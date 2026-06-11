import { Logger } from '../../libs/Logger.js';
import { StreamOrchestrator } from '../../libs/StreamOrchestrator.js';

import { isMasterPlaylist, parseMasterPlaylist, parseMediaPlaylist } from './utils.js';

const logger = Logger.getInstance();

export class OmeHlsPuller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
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
    if (this.running || this.stopped) {
      return;
    }

    this.running = true;
    logger.info(`[OME] HLS puller started for ${this.streamId} -> ${this.masterUrl}`);
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info(`[OME] HLS puller stopped for ${this.streamId}`);
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) {
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
    if (this.stopped) {
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

    return await rawPlaylistResponse.text();
  }

  private async processPlaylist(playlist: string, url: string): Promise<void> {
    const entries = parseMediaPlaylist(playlist);

    for (const entry of entries) {
      if (this.stopped) {
        return;
      }
      if (entry.seq <= this.lastSeq) {
        continue;
      }

      const segUrl = new URL(entry.uri, url).toString();
      try {
        const segRes = await fetch(segUrl);

        if (!segRes.ok) {
          logger.warn(`[OME] Segment ${entry.seq} fetch failed for ${this.streamId}: HTTP ${segRes.status}`);
          continue;
        }

        const buf = Buffer.from(await segRes.arrayBuffer());
        const result = this.orchestrator.handleSegment(this.streamId, entry.seq, entry.duration, buf);

        if (!result.accepted) {
          logger.warn(`[OME] Segment ${entry.seq} not accepted for ${this.streamId}: ${result.reason}`);
        }

        this.lastSeq = entry.seq;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.warn(`[OME] Segment ${entry.seq} fetch error for ${this.streamId}: ${msg}`);
      }
    }
  }

  // Fetches the master playlist and resolves the first variant to an absolute
  // URL. If the body turns out to be a media playlist (no #EXT-X-STREAM-INF),
  // we use the master URL itself. Returns true if mediaPlaylistUrl is set.
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

    if (isMasterPlaylist(playlist)) {
      const variantUri = parseMasterPlaylist(playlist);
      this.mediaPlaylistUrl = new URL(variantUri, this.masterUrl).toString();
      logger.info(`[OME] Resolved variant playlist for ${this.streamId}: ${this.mediaPlaylistUrl}`);
    } else {
      this.mediaPlaylistUrl = this.masterUrl;
      logger.info(`[OME] Using master URL as media playlist for ${this.streamId}`);
    }
    return true;
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
