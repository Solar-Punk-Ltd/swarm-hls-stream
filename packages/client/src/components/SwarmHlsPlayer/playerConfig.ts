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
 * ## What the number has to cover
 *
 * A player stalls unless its buffer covers the largest edge-to-fetchable delay, which is
 * `totalMs - segmentMs` per segment, plus the cadence it asks at, since a segment becomes fetchable
 * before the player has asked for it. hls.js reloads a live playlist once per target duration and
 * the uploader declares `ceil(segment duration)`, so that cadence is one second at every segment
 * length below a second. One segment of margin covers an arrival later than any measured.
 *
 * ## Re-derived 2026-08-05, and it stays at six
 *
 * The four clean runs of `docs/bench/quarter-second-2026-08-05.md`, which are the first arrivals
 * measured with the bench's follower reaching the live edge:
 *
 * | segment | samples | observed floor | so this constant needs |
 * | ------- | ------: | -------------: | ---------------------: |
 * | 0.25s   |      33 |          1.42s |                  2.67s |
 * | 0.25s   |      37 |          1.80s |                  3.05s |
 * | 0.5s    |      67 |          2.92s |                  4.42s |
 * | 0.5s    |     107 |          3.41s |                  4.91s |
 *
 * **Six covers the worst of them by 1.09s.** The value did not move, and only the derivation under
 * it did: the table this replaces came from the sweep of 2026-08-03, and every figure from before
 * 2026-08-05 was taken through an instrument with six known defects, two of which made a faster
 * deployment report worse.
 *
 * The floor is not proportional to the segment length across those rows, and two segment lengths are
 * not a scaling law, so **a deployment running segments longer than 0.5s has no fresh measurement
 * here** and the old table put the 2.0s floor at 4.45s. Raising this is what such a deployment
 * would need, and the coupling is the same one {@link LIVE_MAX_LATENCY_DURATION_S} describes: the
 * target duration is whatever the uploader's segment length makes it, and this side does not choose
 * it.
 *
 * ## The uploader has to name enough media for this to be reachable
 *
 * hls.js clamps its sync position to the start of the playlist, so a first manifest holding less
 * media than this asks for puts a joining viewer at the live edge with no runway, whatever this says.
 * Against the requirements above, the uploader's old ten-segment window held 2.5s at a 0.25s segment
 * and was short in **both** clean runs, by 172ms and 550ms, while clearing the worst 0.5s run by 91ms.
 * The window is now budgeted against one chunk rather than counted in segments, which is 9.0s at
 * 0.25s on the deployment these numbers were measured on and 12.5s where `MANIFEST_ACCESS_URL` is
 * left empty, and `ManifestManager.test.ts` reads this constant out of this file and fails if the
 * window stops covering it.
 *
 * ## What this is not
 *
 * A floor over observed samples is not a proof, and these are 244 arrivals over four three-minute
 * runs rather than a steady state. Nothing here has been played in a real browser at this setting,
 * which is task #48, so the claim is that the arrivals measured would not have stalled a player
 * configured this way, not that no arrival ever will.
 *
 * A paragraph here used to say that a player on this deployment rebuffers every 63 seconds whatever
 * this number is. That was LAT-10 and it is **retracted**: the freeze was bee's sequential feed head
 * lookup, which the bench polled every cycle and a player calls only on mount. See
 * `docs/reviews/freeze-elimination-plan.md`.
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
