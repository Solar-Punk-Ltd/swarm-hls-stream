/**
 * How much media a segment holds, read off the presentation timestamps of its own video packets.
 *
 * Kept apart from `probe.ts` because there is no tool, no tick rate and no I/O in any of it, only
 * arithmetic over a list of integers, and because that arithmetic has two steps which are wrong in
 * ways nothing downstream can see.
 *
 * **The packets are in decode order, so the newest frame is not the last one listed.** Any stream
 * with B-frames reorders them, and subtracting the ends of the list then loses however far the
 * reordering reaches, which for a normal encoder is one frame from every segment. The result stays
 * plausible, stays stable, and lands within rounding distance of the declared duration.
 *
 * **A timestamp says when a frame started, not how long it lasted.** So the last frame's own duration
 * is media the segment holds that no timestamp in the list accounts for, and it has to be credited
 * from somewhere. The median gap is what that somewhere is: for constant-frame-rate output every gap
 * is the frame duration exactly, and where frames were dropped the median is unmoved by the gap they
 * left while a mean would carry it into every segment.
 *
 * Both were checked against ffmpeg 7.1.1's own HLS muxer rather than reasoned about. Over a `-bf 3`
 * segment whose manifest declared `#EXTINF:0.500000`, this lands on 0.500 and the ends of the list
 * give 0.467.
 */

/** What one segment's video timestamps say about it, in the stream's own ticks. */
export interface SpanTicks {
  /** The first frame's presentation timestamp to the end of the last frame. */
  total: number;
  /** What the final frame was credited with, since no timestamp measures the last frame's own length. */
  finalFrame: number;
  /** How many video packets it was measured across, so a report can say how thin a reading is. */
  packets: number;
}

function fail(source: string, why: string): never {
  throw new Error(`cannot measure how much media ${source} holds: ${why}`);
}

/**
 * The typical gap between adjacent timestamps.
 *
 * The lower of the two middles when the count is even, which is deliberate rather than incidental:
 * the figure is credited to a frame nothing measured, so where there is no single middle the
 * conservative one is the one that cannot inflate the span.
 */
function medianGap(ascending: readonly number[]): number {
  const gaps = ascending.slice(1).map((tick, index) => tick - ascending[index]);
  const sorted = [...gaps].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * @param pts every video packet's presentation timestamp, in whatever order the container listed them
 * @param source what to name in an error, normally the segment reference
 */
export function measureSpanTicks(pts: readonly number[], source: string): SpanTicks {
  if (pts.length === 0) {
    fail(source, 'it holds no video packets, so the media never reached the far end');
  }
  if (pts.length === 1) {
    fail(
      source,
      'it holds one video packet, which fixes when a frame started and nothing about how long it ' +
        'lasted. A span assumed here would be indistinguishable in the report from a measured one',
    );
  }
  // Before anything below, because a NaN survives every comparison a later bound could make.
  if (!pts.every((tick) => Number.isFinite(tick))) {
    fail(source, 'one of its presentation timestamps is not a finite number');
  }

  const ascending = [...pts].sort((a, b) => a - b);
  const finalFrame = medianGap(ascending);
  if (finalFrame <= 0) {
    fail(
      source,
      'its presentation timestamps never advance across most of the segment, so they fix no frame ' +
        'duration. A zero credited here would move the live edge onto the first frame it holds',
    );
  }

  return {
    total: ascending[ascending.length - 1] - ascending[0] + finalFrame,
    finalFrame,
    packets: pts.length,
  };
}
