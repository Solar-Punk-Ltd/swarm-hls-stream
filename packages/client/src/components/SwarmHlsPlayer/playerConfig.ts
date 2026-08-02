import type { HlsConfig } from 'hls.js';

const MB = 1024 * 1024;

/**
 * How far behind the live edge playback aims to sit, in seconds.
 *
 * Every segment here is fetched from Swarm rather than from an origin next to the viewer, so the
 * budget covers a feed lookup plus a chunk download, not one HTTP round trip. Lowering it is the
 * largest client-side latency lever there is, and it is not being lowered yet: nothing in this
 * repository can currently measure glass-to-glass latency, so a smaller number here would trade
 * away rebuffering headroom for an improvement nobody could show. That instrument is LAT-1.
 */
export const LIVE_SYNC_DURATION_S = 10;

/**
 * The latency at which hls.js stops trying to recover gradually and seeks to the live edge instead.
 *
 * hls.js refuses a value at or below {@link LIVE_SYNC_DURATION_S}, throwing from the constructor, so
 * every mount of the player depends on the two staying ordered.
 */
export const LIVE_MAX_LATENCY_DURATION_S = 30;

/**
 * Everything the player tells hls.js that is not a loader.
 *
 * Separate from the component because a wrong number here is invisible in every way except how the
 * stream feels: nothing throws, nothing logs, playback just sits further behind or rebuffers more.
 * Out here it can be asserted, and compared against the library's own defaults, without a DOM.
 */
export const HLS_TUNING = {
  liveSyncDuration: LIVE_SYNC_DURATION_S,
  liveMaxLatencyDuration: LIVE_MAX_LATENCY_DURATION_S,
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  maxBufferSize: 60 * MB,
  maxBufferHole: 1,
} as const satisfies Partial<HlsConfig>;

/**
 * The full config for one player instance: the tuning above, plus the loaders that route manifest
 * and fragment requests through Swarm.
 *
 * A function rather than a spread at the call site so that what the component passes to hls.js is
 * one named thing a test can build and hand to a real `new Hls(...)`.
 */
export function buildPlayerConfig(loaders: Pick<HlsConfig, 'pLoader' | 'fLoader'>): Partial<HlsConfig> {
  return { ...loaders, ...HLS_TUNING };
}
