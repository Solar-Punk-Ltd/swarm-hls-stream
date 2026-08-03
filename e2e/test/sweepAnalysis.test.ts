import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  arrivalTailMs,
  frameDelivery,
  median,
  minimumSafeBufferMs,
  recommendBufferMs,
} from '../src/bench/sweepAnalysis.js';

/**
 * The arithmetic behind the one recommendation this project makes about the player.
 *
 * `LIVE_SYNC_DURATION_S` is 77% of what a viewer waits and has never been cut, because its own note
 * required a usable per-hop split and a spread over more than five samples. Both exist now, so the
 * number comes from data, and the data reduces to the subtraction below.
 */
describe('the smallest live buffer a set of samples supports', () => {
  /**
   * The live edge is the newest segment's last frame and the total is anchored on its first, so the
   * quantity a buffer has to cover is the total minus the segment. Taken from the on-host run of
   * 2026-08-03: a 5.55s total over a 2.00s segment needs 3.55s.
   */
  it('bounds the buffer by the slowest segment, measured from the live edge', () => {
    const samples = [
      { totalMs: 5_550, segmentMs: 2_000 },
      { totalMs: 3_910, segmentMs: 2_000 },
      { totalMs: 5_000, segmentMs: 2_000 },
    ];

    assert.equal(minimumSafeBufferMs(samples), 3_550);
  });

  /**
   * The degenerate case that fixes the sign. A pipeline making a segment fetchable the instant it
   * closed has `totalMs === segmentMs` and needs no buffer at all, which is what `liveSyncDuration`
   * means. A function that forgot to subtract the segment would return the whole total here.
   */
  it('needs no buffer for a pipeline with no delay past the segment', () => {
    assert.equal(minimumSafeBufferMs([{ totalMs: 2_000, segmentMs: 2_000 }]), 0);
  });

  it('takes the worst sample and not the typical one, since one stall is a stall', () => {
    const samples = [
      { totalMs: 3_000, segmentMs: 1_000 },
      { totalMs: 3_100, segmentMs: 1_000 },
      { totalMs: 9_000, segmentMs: 1_000 },
    ];

    assert.equal(minimumSafeBufferMs(samples), 8_000);
  });

  it('refuses to bound a buffer with nothing to bound it by', () => {
    assert.throws(() => minimumSafeBufferMs([]), /nothing bounds the buffer/);
  });

  /**
   * The floor is when a segment became fetchable; a player learns of it on its next poll and needs
   * somewhere to absorb an arrival later than any measured. Both are additive and both are stated.
   */
  it('recommends the floor plus the poll cadence and one segment', () => {
    const result = recommendBufferMs([{ totalMs: 5_550, segmentMs: 2_000 }], 2_000, 2_000);

    assert.equal(result.observedFloorMs, 3_550);
    assert.equal(result.marginMs, 2_000);
    assert.equal(result.recommendedMs, 7_550);
    assert.equal(result.samples, 1);
  });

  /** Margin scales with the segment, so a short-segment setting is not given a long-segment allowance. */
  it('scales the margin with the segment rather than with a percentage', () => {
    const short = recommendBufferMs([{ totalMs: 2_500, segmentMs: 500 }], 2_000, 500);

    assert.equal(short.marginMs, 500);
    assert.equal(short.recommendedMs, 2_000 + 2_000 + 500);
  });
});

/**
 * The second question a profile grid has to answer. Latency says how far behind live a viewer sits;
 * this says whether what arrives there is the picture that was published.
 */
describe('frame delivery', () => {
  /** A segment carrying every frame the publisher was asked for scores 1. */
  it('scores an intact segment at one', () => {
    const result = frameDelivery([{ videoPacketCount: 30, segmentMs: 1_000, fps: 30 }]);

    assert.equal(result.medianRatio, 1);
    assert.equal(result.worstRatio, 1);
  });

  /**
   * The reading this exists for, taken from the laptop runs of 2026-08-03. About 15% of SRT packets
   * were lost on the way to the host and segments came back with 14 to 24 video frames where the
   * local self-check produced 60. Every latency number in those runs looked ordinary, and a grid
   * without this column would have ranked a broken path against a working one.
   */
  it('catches a lossy path that the latency columns cannot see', () => {
    const result = frameDelivery([
      { videoPacketCount: 24, segmentMs: 2_000, fps: 30 },
      { videoPacketCount: 14, segmentMs: 2_000, fps: 30 },
      { videoPacketCount: 21, segmentMs: 2_000, fps: 30 },
    ]);

    assert.ok(result.medianRatio < 0.4, `expected a badly incomplete median, got ${result.medianRatio}`);
    assert.ok(result.worstRatio < 0.25, `expected the worst segment to be worse still, got ${result.worstRatio}`);
  });

  /**
   * The worst is reported beside the median because one gap is a visible glitch, and a single bad
   * segment among four good ones leaves the median at 1.
   */
  it('reports the worst segment separately, since a median hides a single glitch', () => {
    const result = frameDelivery([
      { videoPacketCount: 30, segmentMs: 1_000, fps: 30 },
      { videoPacketCount: 30, segmentMs: 1_000, fps: 30 },
      { videoPacketCount: 9, segmentMs: 1_000, fps: 30 },
      { videoPacketCount: 30, segmentMs: 1_000, fps: 30 },
    ]);

    assert.equal(result.medianRatio, 1);
    assert.equal(result.worstRatio, 0.3);
  });

  /** The expectation scales with both knobs, so a half-second segment is not scored against a second. */
  it('expects fewer frames of a shorter segment and of a slower frame rate', () => {
    assert.equal(frameDelivery([{ videoPacketCount: 15, segmentMs: 500, fps: 30 }]).medianRatio, 1);
    assert.equal(frameDelivery([{ videoPacketCount: 15, segmentMs: 1_000, fps: 15 }]).medianRatio, 1);
  });

  /**
   * A segment of no duration would divide by zero and report `Infinity`, which sorts as the best row
   * in the grid. Refusing is the only reading that cannot be mistaken for a good one.
   */
  it('refuses a segment with no duration rather than scoring it infinitely well', () => {
    assert.throws(() => frameDelivery([{ videoPacketCount: 30, segmentMs: 0, fps: 30 }]), /no duration/);
  });
});

/**
 * What the buffer costs beyond the typical case.
 *
 * `minimumSafeBufferMs` takes the worst sample because one stall is a stall, which makes it the right
 * number to configure and the wrong one to judge a setting by: it cannot say whether the worst was
 * near the typical or far above it. Two settings with the same median can need very different buffers.
 */
describe('arrival tail', () => {
  it('measures how far the worst arrival sat above the typical one', () => {
    const samples = [
      { totalMs: 3_000, segmentMs: 1_000 },
      { totalMs: 3_200, segmentMs: 1_000 },
      { totalMs: 6_000, segmentMs: 1_000 },
    ];

    // Delays are 2000/2200/5000; the median is 2200 and the worst 5000.
    assert.equal(arrivalTailMs(samples), 2_800);
  });

  it('is zero when every segment arrived alike, which is what a settled setting looks like', () => {
    assert.equal(
      arrivalTailMs([
        { totalMs: 3_000, segmentMs: 1_000 },
        { totalMs: 3_000, segmentMs: 1_000 },
      ]),
      0,
    );
  });
});

describe('median', () => {
  it('takes the middle of an odd count', () => {
    assert.equal(median([3, 1, 2]), 2);
  });

  /** The lower middle, so a summary of an even count cannot report a value no run produced. */
  it('takes the lower middle of an even count', () => {
    assert.equal(median([1, 2, 3, 4]), 2);
  });

  it('refuses an empty list rather than returning NaN', () => {
    assert.throws(() => median([]), /no values/);
  });
});
