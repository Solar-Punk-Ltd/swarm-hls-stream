import { measureSpanTicks, readVideoPts, TS_TIMESCALE_HZ } from '@swarm-hls-stream/shared';

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

/** How long a segment is, and whether the segment itself or the engine answered. */
export interface SegmentDurationReading {
  seconds: number;
  /**
   * Null when the segment's own timestamps answered. Otherwise why the engine's claim was used
   * instead, so a deployment falling back on every segment can be told from one that never does.
   */
  fellBackBecause: string | null;
}

function whyItFailed(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How much media a segment holds, read from the segment rather than taken from the engine.
 *
 * **The engine's claim is not the media.** SRS sends a `duration` with its `on_hls` callback and the
 * uploader published it verbatim as `#EXTINF`. Measured on 2026-08-06 across a whole recording, that
 * number averaged **0.3205s against 0.2667s of media**, jittering between 0.27 and 0.41 while the
 * media never varied. It is not wall clock either: the same segments arrived 0.265s apart, matching
 * their media exactly, so nothing was slow and nothing was dropped. It simply matches nothing.
 *
 * A viewer met that as a recording whose length collapsed from 27.10s to 22.59s once it finished
 * buffering, but the reach is wider: the same sum is the catalog's advertised duration, it sets
 * `#EXT-X-TARGETDURATION`, and hls.js positions a live viewer `liveSyncDuration` seconds back along
 * a timeline built out of it. See `docs/bench/a-recording-played-back-2026-08-06.md`.
 *
 * The arithmetic is `measureSpanTicks`, which the bench has used since LAT-9 for exactly this reason.
 *
 * @param declared what the engine said, kept for the segments this cannot read. An fMP4 segment
 *   carries no transport packets, so OME lands here on every segment and must keep working.
 */
export function measureSegmentDuration(segment: Uint8Array, declared: number): SegmentDurationReading {
  try {
    const span = measureSpanTicks(readVideoPts(segment), 'this segment');
    const seconds = span.total / TS_TIMESCALE_HZ;
    // The same bound the engine's claim is held to. It also catches the one failure the arithmetic
    // cannot see: timestamps are 33 bits and wrap about every 26.5 hours, and a segment straddling
    // that reads as most of the range rather than as a fraction of a second.
    if (!isUsableDuration(seconds)) {
      return { seconds: declared, fellBackBecause: `its timestamps span ${seconds}s, which is not a segment` };
    }
    return { seconds, fellBackBecause: null };
  } catch (error) {
    return { seconds: declared, fellBackBecause: whyItFailed(error) };
  }
}
