import { countPesPackets, measureSpanTicks, readVideoPts, TS_TIMESCALE_HZ } from '@swarm-hls-stream/shared';

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
  /**
   * How many video packets the segment holds. Zero is not on its own a fault: it is also what bytes
   * of any container this cannot parse look like, which is why {@link audioWithoutVideo} exists.
   */
  videoPackets: number;
  /**
   * How many audio packets the segment carries when it carries no video, and `null` whenever it does
   * carry video or is not a transport stream this can read at all.
   *
   * A different question from whether the duration could be read, with a consequence nothing else
   * here can see: **a player parsing such a fragment first fixes an audio-only codec set and never
   * revises it**, so the rest of the broadcast arrives as sound over a blank picture and every video
   * sample is refused non-fatally.
   *
   * ⛔ **Null for bytes that are not a transport stream**, which is deliberate rather than a gap.
   * That is a segment this service cannot read, already counted by `segment_durations_unread_total`,
   * and treating it as videoless would let an engine this cannot parse be mistaken for a publisher
   * sending no frames. See task #41.
   */
  audioWithoutVideo: number | null;
}

function whyItFailed(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read only for a segment holding no video timestamps, which is the rare path, so the common one
 * still walks the packets once. Both counts at zero means bytes this cannot read rather than media
 * without a picture, and the two must not be answered the same way.
 */
function audioWithoutVideoIn(segment: Uint8Array): number | null {
  const { video, audio } = countPesPackets(segment);
  return video === 0 && audio > 0 ? audio : null;
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
 * @param declared what the engine said, kept for a segment this cannot read. **Neither shipped
 *   engine should reach it.** OME is pulled from `ts:playlist.m3u8`, its MPEG-TS playlist rather
 *   than its fMP4 one, so its segments carry transport packets exactly as SRS's do. The fallback is
 *   for a segment that is genuinely unreadable, and reaching it means a viewer is being told what
 *   the engine claimed. See `segment_durations_unread_total`.
 */
export function measureSegmentDuration(segment: Uint8Array, declared: number): SegmentDurationReading {
  const pts = readVideoPts(segment);
  const audioWithoutVideo = pts.length === 0 ? audioWithoutVideoIn(segment) : null;
  try {
    const span = measureSpanTicks(pts, 'this segment');
    const seconds = span.total / TS_TIMESCALE_HZ;
    // The same bound the engine's claim is held to. It also catches the one failure the arithmetic
    // cannot see: timestamps are 33 bits and wrap about every 26.5 hours, and a segment straddling
    // that reads as most of the range rather than as a fraction of a second.
    if (!isUsableDuration(seconds)) {
      return {
        seconds: declared,
        fellBackBecause: `its timestamps span ${seconds}s, which is not a segment`,
        videoPackets: pts.length,
        audioWithoutVideo,
      };
    }
    return { seconds, fellBackBecause: null, videoPackets: pts.length, audioWithoutVideo };
  } catch (error) {
    return { seconds: declared, fellBackBecause: whyItFailed(error), videoPackets: pts.length, audioWithoutVideo };
  }
}
