import { Logger } from '../../libs/Logger.js';
import { StreamOrchestrator } from '../../libs/StreamOrchestrator.js';

import { isMasterPlaylist, parseMasterPlaylist, parseMediaPlaylist } from './utils.js';

const logger = Logger.getInstance();

export class OmeHlsPuller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: 'idle' | 'running' | 'stopped' = 'idle';
  private lastSeq = -1;
  private notFoundSince: number | null = null;
  private readonly masterUrl: string;
  private mediaPlaylistUrl: string | null = null;

  private static readonly RETRY_THRESHOLD_IN_MS = 60_000;

  constructor(
    private streamId: string,
    app: string,
    stream: string,
    hlsBaseUrl: string,
    private intervalMs: number,
    private orchestrator: StreamOrchestrator,
    private onHalt?: () => void,
  ) {
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
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.warn(`[OME] Puller tick error for ${this.streamId}: ${msg}`);
        this.scheduleNext(this.intervalMs);
      });
    }, delayMs);
  }

  private resetRetryCounter(): void {
    this.notFoundSince = null;
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
    const rawPlaylistResponse = await fetch(url);

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
        const segmentResponse = await fetch(segmentUrl);

        if (!segmentResponse.ok) {
          logger.warn(`[OME] Segment ${segment.seq} fetch failed for ${this.streamId}: HTTP ${segmentResponse.status}`);
          continue;
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
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.warn(`[OME] Segment ${segment.seq} fetch error for ${this.streamId}: ${msg}`);
      }
    }
  }

  private async fetchMediaPlaylistUrl(): Promise<boolean> {
    const res = await fetch(this.masterUrl);

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
