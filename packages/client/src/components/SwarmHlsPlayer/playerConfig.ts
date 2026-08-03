import type { HlsConfig } from 'hls.js';

const MB = 1024 * 1024;

/**
 * How far behind the live edge playback aims to sit, in seconds.
 *
 * Every segment here is fetched from Swarm rather than from an origin next to the viewer, so the
 * budget covers a feed lookup plus a chunk download, not one HTTP round trip. It is the largest
 * client-side latency lever there is, and it was 10 until 2026-08-03.
 *
 * Behind-live is not the total plus this buffer. The total is anchored on a segment's first frame
 * and the buffer is measured back from the live edge, which is that same segment's last, so adding
 * them counts one segment twice.
 *
 * ## Why it was 10, and why that reasoning expired
 *
 * The previous note declined to cut it for two stated reasons: the per-hop split reported an
 * impossible negative upload hop on every sample (LAT-9), and a spread taken over five samples is
 * not a spread. Both are now closed. LAT-9 was the publisher's timestamps running 1.4s ahead of wall
 * clock, and the sweep of 2026-08-03 measured 105 samples over four segment durations, on the
 * deployment host so that no uplink sat inside the numbers.
 *
 * ## What the number is now, and how it was derived
 *
 * A player stalls unless its buffer covers the largest edge-to-fetchable delay, which is
 * `totalMs - segmentMs` per segment. Measured floors, against a 1.0s segment:
 *
 * | segment | observed floor | this constant needs to be |
 * | ------- | -------------- | ------------------------- |
 * | 0.5s    | 2.46s          | 4.96s                     |
 * | 1.0s    | 2.88s          | 5.88s                     |
 * | 2.0s    | 4.45s          | 8.45s                     |
 * | 4.0s    | 6.72s          | 12.72s                    |
 *
 * The right column is the floor plus the client's manifest poll cadence, since a segment is fetchable
 * before the player has asked for it, plus one segment of margin for an arrival later than any of the
 * 105 measured. Six seconds is the 1.0s row rounded up, and `HLS_FRAGMENT` now defaults to 1.0 for
 * exactly that reason: **these two numbers were chosen together and only make sense together.**
 *
 * A deployment running longer segments has to raise this or it will rebuffer. That coupling is real
 * and this side does not control the other half, which is the same limitation
 * {@link LIVE_MAX_LATENCY_DURATION_S} describes: the target duration is whatever the uploader's
 * segment length makes it.
 *
 * ## What this is not
 *
 * A floor over observed samples is not a proof. Nothing here has been played in a real browser at
 * this setting, so the claim is that 105 measured arrivals would not have stalled a player
 * configured this way, not that no arrival ever will.
 *
 * ## And on this deployment it is not enough, which is measured rather than feared
 *
 * LAT-10: the feed a player polls stops naming new segments for **30 to 48 seconds at a time**, on a
 * roughly 63 second cycle, for 42% to 70% of a broadcast. That is far outside any buffer worth
 * configuring, so **a player on this deployment rebuffers every cycle whatever this number is**, and
 * raising it would trade constant extra latency for no fewer stalls.
 *
 * The cause is not here and not in the uploader: the segments reach a viewer's gateway node in under
 * a second, and only the single-owner chunk announcing them is slow. **So this number is not the
 * thing to change in response.** It stays derived from the arrival floor, which is what it is for,
 * and `docs/bench/longrun.md` carries the rest.
 */
export const LIVE_SYNC_DURATION_S = 6;

/**
 * The latency at which hls.js stops trying to recover gradually and seeks to the live edge instead.
 *
 * hls.js refuses a value at or below {@link LIVE_SYNC_DURATION_S}, throwing from the constructor, so
 * every mount of the player depends on the two staying ordered. The upper bound is the one that is
 * easy to get wrong, because nothing enforces it: hls.js only nudges the playback rate while the
 * drift is under `min(this, targetLatency + targetduration)` past the target, and only seeks once it
 * is past this. Set it high enough and the two stop meeting, leaving a viewer between the end of
 * catch-up and the start of the seek with neither running, which is what 10 and 30 did between 22
 * and 30 seconds of latency. At twice the target the ranges meet for **every** target duration, and
 * that is the reason for the bound: the target duration is whatever the uploader's segment length
 * makes it, not a number this side chooses. Larger values are not all broken, since a long enough
 * target duration closes the gap on its own, but which ones are safe then depends on a number this
 * side does not control.
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
