import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LIVE_SYNC_DURATION_S } from '../src/bench/clientTuning.js';
import {
  type ClockSkew,
  HOP_FEED_PROPAGATION,
  HOP_FETCH,
  HOP_MANIFEST_PUBLISH,
  HOP_SEGMENT,
  HOP_UPLOAD,
  type HopName,
  HOPS_CROSSING_CLOCKS,
  impossibleHops,
  latencySplit,
  type SegmentInstants,
} from '../src/bench/split.js';

const BENCH_T0 = 1_785_677_886_564;
const NO_SKEW: ClockSkew = { offsetMs: 0, uncertaintyMs: 12 };

/**
 * One plausible segment: 2s of media, captured at T0, uploaded 1.4s after it closed, published 0.6s
 * later, seen by the next poll 1.2s after that, and fetched in 0.4s.
 */
const INSTANTS: SegmentInstants = {
  capturedAtMs: BENCH_T0,
  segmentDurationS: 2,
  uploadedAtMs: BENCH_T0 + 3_400,
  manifestPublishedAtMs: BENCH_T0 + 4_000,
  visibleAtMs: BENCH_T0 + 5_200,
  fetchedAtMs: BENCH_T0 + 5_600,
};

function hopMs(name: HopName, instants = INSTANTS, skew = NO_SKEW): number {
  const hop = latencySplit(instants, skew).hops.find((h) => h.name === name);
  assert.ok(hop, `no ${name} hop in the split`);
  return hop.ms;
}

function withSkew(offsetMs: number): ClockSkew {
  return { offsetMs, uncertaintyMs: 12 };
}

describe('splitting one segment across the pipeline', () => {
  it('measures the total from capture to fetch', () => {
    assert.equal(latencySplit(INSTANTS, NO_SKEW).totalMs, 5_600);
  });

  it('charges the first frame for its own segment closing', () => {
    assert.equal(hopMs(HOP_SEGMENT), 2_000);
  });

  it('starts the upload hop when the segment closed, not when its first frame was captured', () => {
    assert.equal(hopMs(HOP_UPLOAD), 1_400);
  });

  it('measures the feed write between the two uploader log lines', () => {
    assert.equal(hopMs(HOP_MANIFEST_PUBLISH), 600);
  });

  it('measures propagation from the publish to the poll that first saw it', () => {
    assert.equal(hopMs(HOP_FEED_PROPAGATION), 1_200);
  });

  it('measures the payload fetch on its own', () => {
    assert.equal(hopMs(HOP_FETCH), 400);
  });

  /**
   * The property that makes the split worth reading at all: no time is invented or lost between the
   * rows. Asserted as a sum rather than row by row, because every row above could be individually
   * right while a sixth stage went unaccounted for.
   */
  it('accounts for every millisecond of the total, with nothing left over', () => {
    const split = latencySplit(INSTANTS, NO_SKEW);

    assert.equal(
      split.hops.reduce((sum, hop) => sum + hop.ms, 0),
      split.totalMs,
    );
  });

  it('adds the configured player buffer to reach what a viewer experiences', () => {
    const split = latencySplit(INSTANTS, NO_SKEW);

    assert.equal(split.playerBufferMs, LIVE_SYNC_DURATION_S * 1_000);
    assert.equal(split.viewerLatencyMs, split.totalMs + split.playerBufferMs);
  });
});

/**
 * The reason a two-clock measurement is usable. If skew moved the total, the whole instrument would
 * be bounded by how well two machines agree on the time, which is routinely worse than the seconds
 * S5.2 is trying to detect.
 */
describe('what a wrong clock skew can and cannot spoil', () => {
  for (const offsetMs of [-5_000, -250, 0, 250, 5_000]) {
    it(`leaves the total untouched at a skew of ${offsetMs}ms`, () => {
      assert.equal(latencySplit(INSTANTS, withSkew(offsetMs)).totalMs, 5_600);
    });

    it(`leaves the single-clock hops untouched at a skew of ${offsetMs}ms`, () => {
      assert.equal(hopMs(HOP_SEGMENT, INSTANTS, withSkew(offsetMs)), 2_000);
      assert.equal(hopMs(HOP_MANIFEST_PUBLISH, INSTANTS, withSkew(offsetMs)), 600);
      assert.equal(hopMs(HOP_FETCH, INSTANTS, withSkew(offsetMs)), 400);
    });

    it(`still accounts for the whole total at a skew of ${offsetMs}ms`, () => {
      const split = latencySplit(INSTANTS, withSkew(offsetMs));

      assert.equal(
        split.hops.reduce((sum, hop) => sum + hop.ms, 0),
        split.totalMs,
      );
    });
  }

  it('moves the skew between exactly the two hops that name it', () => {
    const skewed = latencySplit(INSTANTS, withSkew(700));

    assert.equal(hopMs(HOP_UPLOAD, INSTANTS, withSkew(700)), 1_400 - 700);
    assert.equal(hopMs(HOP_FEED_PROPAGATION, INSTANTS, withSkew(700)), 1_200 + 700);
    assert.deepEqual([...HOPS_CROSSING_CLOCKS], [HOP_UPLOAD, HOP_FEED_PROPAGATION]);
    assert.equal(skewed.skew.offsetMs, 700);
  });
});

describe('reporting a reading that cannot be true', () => {
  it('finds nothing to complain about in a plausible split', () => {
    assert.deepEqual(impossibleHops(latencySplit(INSTANTS, NO_SKEW)), []);
  });

  /**
   * Zero is a reading, not a fault. Two uploader log lines land in the same millisecond whenever the
   * SOC write returns quickly, and a warning light that comes on for a fast pipeline is one an
   * operator learns to ignore.
   */
  it('leaves a hop that took no measurable time alone', () => {
    const instant: SegmentInstants = { ...INSTANTS, manifestPublishedAtMs: INSTANTS.uploadedAtMs };

    assert.equal(hopMs(HOP_MANIFEST_PUBLISH, instant), 0);
    assert.deepEqual(impossibleHops(latencySplit(instant, NO_SKEW)), []);
  });

  /**
   * Time cannot run backwards between two stages, so a negative row means an input is wrong: a skew
   * estimate taken across a slow link, or a log line paired with the wrong segment. Surfaced rather
   * than thrown, because the total survives it and is the number worth keeping.
   */
  it('names the hop a badly wrong skew drove negative', () => {
    const split = latencySplit(INSTANTS, withSkew(3_000));

    assert.deepEqual(
      impossibleHops(split).map((hop) => hop.name),
      [HOP_UPLOAD],
    );
    assert.equal(split.totalMs, 5_600);
  });

  it('names a propagation hop driven negative by a skew in the other direction', () => {
    assert.deepEqual(
      impossibleHops(latencySplit(INSTANTS, withSkew(-3_000))).map((hop) => hop.name),
      [HOP_FEED_PROPAGATION],
    );
  });

  it('names the fetch hop when a poll and a download are recorded out of order', () => {
    const outOfOrder: SegmentInstants = { ...INSTANTS, fetchedAtMs: INSTANTS.visibleAtMs - 100 };

    assert.deepEqual(
      impossibleHops(latencySplit(outOfOrder, NO_SKEW)).map((hop) => hop.name),
      [HOP_FETCH],
    );
  });
});
