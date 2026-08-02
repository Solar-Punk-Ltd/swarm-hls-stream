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
 * every mount of the player depends on the two staying ordered. The upper bound is the one that is
 * easy to get wrong, because nothing enforces it: hls.js only nudges the playback rate while the
 * drift is under `min(this, targetLatency + targetduration)` past the target, and only seeks once it
 * is past this. Set this higher than twice {@link LIVE_SYNC_DURATION_S} and the two stop meeting, so
 * a viewer between the end of catch-up and the start of the seek is left drifting with neither
 * running. At twice the target the ranges meet whatever the playlist's target duration turns out to
 * be, which is not a number this side of the system chooses.
 */
export const LIVE_MAX_LATENCY_DURATION_S = 2 * LIVE_SYNC_DURATION_S;

/**
 * The fastest playback rate used to catch up after drifting behind the target.
 *
 * hls.js reads exactly 1, its default, as "never adapt", so without this a second lost to a slow
 * fetch or a rebuffer is kept for the rest of the session and latency only ever grows, until it
 * crosses {@link LIVE_MAX_LATENCY_DURATION_S} and the viewer is jumped forward instead. That was
 * LAT-2.
 *
 * 1.1 rather than the 1.5 the low-latency presets use. Browsers pitch-correct transparently to
 * around 1.1 and audibly past it, and 10% recovers a two second overshoot inside twenty seconds
 * without the viewer hearing that it happened.
 *
 * hls.js gates this on `lowLatencyMode` in the same condition, so the two have to stay together.
 * That flag defaults to true and is deliberately not set here, which is what R7 in the finding
 * register decided and the whole of its reason. Reading the two as unrelated is what would make
 * someone override the flag to false and kill this silently, so R7's own note carries the gate.
 */
export const MAX_LIVE_SYNC_PLAYBACK_RATE = 1.1;

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
  maxLiveSyncPlaybackRate: MAX_LIVE_SYNC_PLAYBACK_RATE,
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
