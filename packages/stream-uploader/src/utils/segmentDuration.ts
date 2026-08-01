/** A segment longer than this is not a segment. An hour is far beyond any HLS target duration. */
const MAX_SEGMENT_SECONDS = 3600;

/**
 * A duration that can go into a manifest, and that can be added to and subtracted from a running
 * total without destroying it.
 *
 * Anything else reaches `#EXTINF` verbatim, and a playlist that says `NaN`, a negative length, or a
 * number no clock could mean is one no player can follow. Zero is degenerate rather than unusable:
 * it publishes cleanly and adds nothing to a total.
 *
 * The second job is why this lives here rather than in the OME parser it started in. The queue
 * tracks how far behind live a stream is by adding a duration on enqueue and subtracting it when the
 * job ends, and `Infinity - Infinity` is `NaN`, which never leaves a running total and which
 * `Math.max` then spreads across every stream in the process.
 */
export function isUsableDuration(duration: number): boolean {
  return Number.isFinite(duration) && duration >= 0 && duration <= MAX_SEGMENT_SECONDS;
}
