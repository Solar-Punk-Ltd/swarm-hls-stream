import { Logger } from '../../libs/Logger.js';
import { StreamOrchestrator } from '../../libs/StreamOrchestrator.js';
import { getErrorMessage } from '../../utils/common.js';

import { Fetcher, PullerOptions } from './interfaces.js';
import { isMasterPlaylist, parseMasterPlaylist, parseMediaPlaylist } from './utils.js';

const logger = Logger.getInstance();

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * `AbortSignal.timeout` aborts with a `TimeoutError` DOMException, and an explicit `controller.abort()`
 * with an `AbortError`. Both mean the request was cut off rather than answered, which is the case an
 * operator needs to see at error level: it is indistinguishable from a healthy stream in every other log.
 */
function isAbortedRequest(error: unknown): boolean {
  const name = (error as { name?: string } | null | undefined)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export class OmeHlsPuller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: 'idle' | 'running' | 'stopped' = 'idle';
  private lastSeq = -1;
  private notFoundSince: number | null = null;
  private readonly masterUrl: string;
  private mediaPlaylistUrl: string | null = null;

  private static readonly RETRY_THRESHOLD_IN_MS = 60_000;

  private readonly onHalt?: () => void;
  private readonly fetcher: Fetcher;
  private readonly fetchTimeoutMs: number;

  constructor(
    private streamId: string,
    app: string,
    stream: string,
    hlsBaseUrl: string,
    private intervalMs: number,
    private orchestrator: StreamOrchestrator,
    options: PullerOptions = {},
  ) {
    this.onHalt = options.onHalt;
    // Resolved per call rather than captured, so instrumentation that replaces globalThis.fetch after
    // construction is still seen. Capturing it here would silently opt this class out of an APM agent.
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const base = hlsBaseUrl.replace(/\/+$/, '');
    this.masterUrl = `${base}/${app}/${stream}/ts:playlist.m3u8`;
  }

  start(): void {
    if (this.state !== 'idle') {
      return;
    }

    this.state = 'running';
    logger.info(`[OME] HLS puller started for ${this.streamId} -> ${this.masterUrl}`);
    this.scheduleNext(0);
  }

  stop(): void {
    this.state = 'stopped';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info(`[OME] HLS puller stopped for ${this.streamId}`);
  }

  private scheduleNext(delayMs: number): void {
    if (this.state === 'stopped') {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.tick().catch((error) => {
        const msg = getErrorMessage(error);
        if (isAbortedRequest(error)) {
          logger.error(`[OME] Puller request aborted after ${this.fetchTimeoutMs}ms for ${this.streamId}: ${msg}`);
        } else {
          logger.warn(`[OME] Puller tick error for ${this.streamId}: ${msg}`);
        }
        this.scheduleNext(this.intervalMs);
      });
    }, delayMs);
  }

  private resetRetryCounter(): void {
    this.notFoundSince = null;
  }

  /**
   * Every HTTP call the puller makes goes through here, so the abort window cannot be forgotten at a
   * new call site. A fresh signal per call, because a shared one would abort later requests the moment
   * the first window elapsed.
   */
  private fetchWithTimeout(url: string): Promise<Response> {
    return this.fetcher(url, { signal: AbortSignal.timeout(this.fetchTimeoutMs) });
  }

  private async tick(): Promise<void> {
    if (this.state === 'stopped') {
      return;
    }

    const playlistData = await this.fetchPlaylistData();

    if (!playlistData) {
      return;
    }

    this.resetRetryCounter();
    await this.processPlaylist(playlistData, this.mediaPlaylistUrl as string);

    this.scheduleNext(this.intervalMs);
  }

  private async fetchPlaylistData(): Promise<string | null> {
    if (!this.mediaPlaylistUrl) {
      const playlistUrl = await this.fetchMediaPlaylistUrl();
      if (!playlistUrl) {
        // If not ready yet (404)
        return null;
      }
    }

    const url = this.mediaPlaylistUrl as string;
    const rawPlaylistResponse = await this.fetchWithTimeout(url);

    if (rawPlaylistResponse.status === 404) {
      this.handleNotFound('media playlist');
      // re-resolve on the next tick.
      this.mediaPlaylistUrl = null;
      return null;
    }

    if (!rawPlaylistResponse.ok) {
      throw new Error(`Media playlist HTTP ${rawPlaylistResponse.status}`);
    }

    const body = await rawPlaylistResponse.text();

    // The URL we latched onto can turn out to be a master (variant) playlist — e.g. our first poll
    // landed on an early stub before OME published the master, so we fell back to the master URL.
    // Parsing a master as a media playlist yields zero segments forever, so re-resolve and follow the
    // variant instead of polling a dead URL.
    if (isMasterPlaylist(body)) {
      this.setMediaPlaylistUrl(body);
      this.scheduleNext(this.intervalMs);
      return null;
    }

    return body;
  }

  /**
   * `lastSeq` advances only past a segment that actually reached the orchestrator, so every failure
   * ends this pass and the next tick re-pulls the same index. Continuing instead would advance past
   * the failed segment on the next success, and its own `seq <= lastSeq` guard would then drop that
   * index forever: a hole in the manifest that no health signal can see, since a segment that never
   * arrives is a segment that never failed to upload.
   */
  private async processPlaylist(playlist: string, url: string): Promise<void> {
    const segments = parseMediaPlaylist(playlist);

    for (const segment of segments) {
      if (this.state === 'stopped') {
        return;
      }
      if (segment.seq <= this.lastSeq) {
        continue;
      }

      const segmentUrl = new URL(segment.uri, url).toString();
      try {
        const segmentResponse = await this.fetchWithTimeout(segmentUrl);

        if (!segmentResponse.ok) {
          logger.warn(`[OME] Segment ${segment.seq} fetch failed for ${this.streamId}: HTTP ${segmentResponse.status}`);
          return;
        }

        const segmentBuffer = Buffer.from(await segmentResponse.arrayBuffer());
        const result = this.orchestrator.handleSegment(this.streamId, segment.seq, segment.duration, segmentBuffer);

        if (!result.accepted) {
          logger.warn(`[OME] Segment ${segment.seq} not accepted for ${this.streamId}: ${result.reason}`);
          // Backpressure/rejection: leave lastSeq unchanged so the next tick re-pulls this segment in order.
          return;
        }

        this.lastSeq = segment.seq;
      } catch (error) {
        const msg = getErrorMessage(error);
        if (isAbortedRequest(error)) {
          logger.error(
            `[OME] Segment ${segment.seq} aborted after ${this.fetchTimeoutMs}ms for ${this.streamId}: ${msg}`,
          );
        } else {
          logger.warn(`[OME] Segment ${segment.seq} fetch error for ${this.streamId}: ${msg}`);
        }
        return;
      }
    }
  }

  private async fetchMediaPlaylistUrl(): Promise<boolean> {
    const res = await this.fetchWithTimeout(this.masterUrl);

    if (res.status === 404) {
      this.handleNotFound('master playlist');
      return false;
    }

    if (!res.ok) {
      throw new Error(`Master playlist HTTP ${res.status}`);
    }

    this.resetRetryCounter();

    const playlist = await res.text();
    this.setMediaPlaylistUrl(playlist);

    return true;
  }

  private setMediaPlaylistUrl(playlist: string): void {
    if (isMasterPlaylist(playlist)) {
      const variantUri = parseMasterPlaylist(playlist);
      this.mediaPlaylistUrl = new URL(variantUri, this.masterUrl).toString();
      logger.info(`[OME] Resolved variant playlist for ${this.streamId}: ${this.mediaPlaylistUrl}`);
    } else {
      this.mediaPlaylistUrl = this.masterUrl;
      logger.info(`[OME] Using master URL as media playlist for ${this.streamId}`);
    }
  }

  private handleNotFound(target: string): void {
    const now = Date.now();
    if (this.notFoundSince === null) {
      this.notFoundSince = now;
    }

    if (now - this.notFoundSince > OmeHlsPuller.RETRY_THRESHOLD_IN_MS) {
      logger.info(`[OME] ${target} gone for ${this.streamId}, halting puller`);
      this.stop();
      this.onHalt?.();
      return;
    }

    this.scheduleNext(this.intervalMs);
  }
}
