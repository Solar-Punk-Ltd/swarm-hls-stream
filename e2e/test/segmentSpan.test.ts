import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { measureSpanTicks } from '../src/bench/segmentSpan.js';

/**
 * The presentation timestamps of one real segment, in the order ffprobe listed them.
 *
 * Captured on 2026-08-03 from `ffprobe 7.1.1` against a segment ffmpeg's own HLS muxer produced with
 * `-bf 3`, which is what makes it worth having: the packets arrive in decode order, so this list is
 * not sorted, and its **last entry is not its largest**. The manifest beside it declared
 * `#EXTINF:0.500000`, which is the figure the arithmetic here has to land on.
 */
const REORDERED_TICKS = [
  177_000, 189_000, 183_000, 180_000, 186_000, 201_000, 195_000, 192_000, 198_000, 213_000, 207_000, 204_000, 210_000,
  219_000, 216_000,
];

/** 90kHz, so 3000 ticks is one frame at 30fps. */
const FRAME_TICKS = 3_000;

describe('measuring how much media a segment holds, from its own timestamps', () => {
  it('spans the first frame to the end of the last, not to the start of it', () => {
    const span = measureSpanTicks([0, FRAME_TICKS, 2 * FRAME_TICKS, 3 * FRAME_TICKS], 'seg1.ts');

    // Four frames, so four frame durations. A timestamp says when a frame starts, so the last one's
    // own duration is media the segment holds and no timestamp in the list accounts for it.
    assert.equal(span.total, 4 * FRAME_TICKS);
    assert.equal(span.finalFrame, FRAME_TICKS);
    assert.equal(span.packets, 4);
  });

  /**
   * The reason this module exists rather than a subtraction at the call site.
   *
   * With B-frames the packets are in decode order, so the newest frame is not the last one listed.
   * Against the real capture above, reading the ends of the list gives 42000 ticks where the segment
   * holds 45000, and 0.467s where the manifest declares 0.500. That is a whole frame missing from
   * every segment of every B-frame stream, and it is invisible: the figure stays plausible, stays
   * stable across segments, and lands close enough to the declared duration to look like rounding.
   */
  it('takes the widest timestamp rather than the last one listed', () => {
    const span = measureSpanTicks(REORDERED_TICKS, 'seg1.ts');

    assert.equal(span.total, 45_000, 'max minus min, plus the final frame');
    assert.equal(span.total / 90_000, 0.5, 'which is the 0.500000 the manifest declared for this segment');

    const lastListed = REORDERED_TICKS[REORDERED_TICKS.length - 1];
    assert.notEqual(lastListed, Math.max(...REORDERED_TICKS), 'the fixture has to be one where the two differ');
  });

  /**
   * A dropped frame leaves one wide gap. The mean would carry it into every segment's final frame,
   * which is the one frame the timestamps cannot measure and the one this has to estimate well.
   */
  it('takes the frame duration from the median gap, so one wide gap does not stretch it', () => {
    const withAGap = [0, FRAME_TICKS, 2 * FRAME_TICKS, 20 * FRAME_TICKS];

    const span = measureSpanTicks(withAGap, 'seg1.ts');

    assert.equal(span.finalFrame, FRAME_TICKS, 'the typical gap, not the average of 6.33 frames');
    assert.equal(span.total, 21 * FRAME_TICKS);
  });

  it('is unmoved by the order the timestamps arrive in', () => {
    const shuffled = [...REORDERED_TICKS].sort((a, b) => a - b);

    assert.deepEqual(measureSpanTicks(shuffled, 'seg1.ts'), measureSpanTicks(REORDERED_TICKS, 'seg1.ts'));
  });
});

describe('refusing a packet list that cannot describe a span', () => {
  /**
   * One timestamp says when one frame started and nothing about how long it lasted, so there is no
   * span to be had. Refused rather than credited with some default frame duration, because a guessed
   * duration here is indistinguishable in the report from a measured one.
   */
  it('refuses a single packet, which fixes no duration at all', () => {
    assert.throws(
      () => measureSpanTicks([177_000], 'ref abc123'),
      (error: Error) => {
        assert.match(error.message, /ref abc123/);
        assert.match(error.message, /one video packet/);
        return true;
      },
    );
  });

  it('refuses an empty list', () => {
    assert.throws(() => measureSpanTicks([], 'ref abc123'), /no video packets/);
  });

  /**
   * Every timestamp identical gives a median gap of zero, which would report a segment holding no
   * media at all. `latencySplit` subtracts that duration from the total to place the live edge, so a
   * zero would silently move the edge onto the segment's first frame.
   */
  it('refuses timestamps that never advance', () => {
    assert.throws(() => measureSpanTicks([177_000, 177_000, 177_000], 'ref abc123'), /never advance/);
  });

  /**
   * `NaN` cannot be rejected by a later bound, because every comparison against it is false. Same
   * reasoning as the tick-rate guard in `probe.ts`: it has to be refused where it is still nameable.
   */
  it('refuses a timestamp that is not a finite number', () => {
    assert.throws(() => measureSpanTicks([0, Number.NaN, 6_000], 'ref abc123'), /not a finite number/);
    assert.throws(() => measureSpanTicks([0, Number.POSITIVE_INFINITY], 'ref abc123'), /not a finite number/);
  });
});
