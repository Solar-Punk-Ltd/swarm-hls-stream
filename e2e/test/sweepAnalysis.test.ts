import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { median, minimumSafeBufferMs, recommendBufferMs } from '../src/bench/sweepAnalysis.js';

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
