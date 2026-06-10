import { Logger } from '../../libs/Logger.js';
import { StreamOrchestrator } from '../../libs/StreamOrchestrator.js';

import { parseMasterPlaylist, parsePlaylist } from './utils.js';

const logger = Logger.getInstance();

// Pulls the HLS playlist from OME at a fixed interval and forwards new
// segments to the StreamOrchestrator. One instance per active stream.
export class HlsPuller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private lastSeq = -1;
  private consecutiveNotFound = 0;
  private readonly masterUrl: string;
  // Resolved on demand from the master playlist; OME's variant URL contains
  // a per-session id, so we discover it after the stream is ready.
  private mediaPlaylistUrl: string | null = null;

  // Allow plenty of time for OME's HLS publisher to warm up. With 2s
  // SegmentDuration and a slow keyframe interval (e.g. OBS default 6s),
  // the master playlist can take 10-15s to appear. 120 ticks * 500ms = 60s.
  private static readonly MAX_NOT_FOUND = 120;

  constructor(
    private streamId: string,
    app: string,
    stream: string,
    hlsBaseUrl: string,
    private intervalMs: number,
    private orchestrator: StreamOrchestrator,
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
    this.timer = setTimeout(() => {
      this.tick().catch((error) => {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.warn(`[OME] Puller tick error for ${this.streamId}: ${msg}`);
        this.scheduleNext(this.intervalMs);
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }

    // 1. Resolve the variant (media) playlist URL if we don't have it yet.
    if (!this.mediaPlaylistUrl) {
      const resolved = await this.resolveMediaPlaylistUrl();
      if (!resolved) {
        // Either master not ready yet (404) or it's actually a media
        // playlist already (handled inside resolveMediaPlaylistUrl).
        return;
      }
    }

    // 2. Fetch the media playlist and process new segments.
    const url = this.mediaPlaylistUrl as string;
    const res = await fetch(url);
    if (res.status === 404) {
      this.handleNotFound('media playlist');
      // OME may rotate the variant id if the stream restarts; clear it so
      // we re-resolve on the next tick.
      this.mediaPlaylistUrl = null;
      return;
    }
    if (!res.ok) {
      throw new Error(`Media playlist HTTP ${res.status}`);
    }
    this.consecutiveNotFound = 0;

    const playlist = await res.text();
    const entries = parsePlaylist(playlist);

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

    this.scheduleNext(this.intervalMs);
  }

  // Fetches the master playlist and resolves the first variant to an absolute
  // URL. If the body turns out to be a media playlist (no #EXT-X-STREAM-INF),
  // we use the master URL itself. Returns true if mediaPlaylistUrl is set.
  private async resolveMediaPlaylistUrl(): Promise<boolean> {
    const res = await fetch(this.masterUrl);
    if (res.status === 404) {
      this.handleNotFound('master playlist');
      return false;
    }
    if (!res.ok) {
      throw new Error(`Master playlist HTTP ${res.status}`);
    }
    this.consecutiveNotFound = 0;

    const body = await res.text();
    const variantUri = parseMasterPlaylist(body);
    if (variantUri) {
      this.mediaPlaylistUrl = new URL(variantUri, this.masterUrl).toString();
      logger.info(`[OME] Resolved variant playlist for ${this.streamId}: ${this.mediaPlaylistUrl}`);
    } else {
      // Already a media playlist — use master URL directly.
      this.mediaPlaylistUrl = this.masterUrl;
      logger.info(`[OME] Using master URL as media playlist for ${this.streamId}`);
    }
    this.scheduleNext(0); // re-tick immediately to fetch segments
    return true;
  }

  private handleNotFound(what: string): void {
    this.consecutiveNotFound++;
    if (this.consecutiveNotFound > HlsPuller.MAX_NOT_FOUND) {
      logger.info(`[OME] ${what} gone for ${this.streamId}, halting puller`);
      this.stop();
      return;
    }
    this.scheduleNext(this.intervalMs);
  }
}
