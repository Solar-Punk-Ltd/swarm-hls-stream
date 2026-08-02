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

  /**
   * A run costs a real broadcast and real postage, so a question asked of its artifact afterwards
   * should not need another one. Everything else on the split is a duration, and durations alone
   * cannot say when the run happened, how long it lasted, or where a segment sat in the uploader's
   * log. The PR #64 gate's question about the drift estimate needed exactly that and could only be
   * answered by back-computing the run span out of a derived figure.
   */
  it('carries the instants it was derived from, so the artifact keeps its own inputs', () => {
    const { instants } = latencySplit(INSTANTS, NO_SKEW);

    assert.deepEqual(instants, INSTANTS);
    assert.equal(instants.fetchedAtMs - instants.capturedAtMs, latencySplit(INSTANTS, NO_SKEW).totalMs);
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

  it('sets a viewer back from the live edge, not from the frame the total is anchored on', () => {
    const split = latencySplit(INSTANTS, NO_SKEW);

    assert.equal(split.playerBufferMs, LIVE_SYNC_DURATION_S * 1_000);
    // Stated as the instants it is built from rather than as `totalMs +/- something`. Restating the
    // implementation is what let the previous version of this test pass while the figure it checked
    // was a whole segment too large.
    const segmentMs = INSTANTS.segmentDurationS * 1_000;
    const liveEdgeAtMs = INSTANTS.capturedAtMs + segmentMs;
    assert.equal(split.viewerLatencyMs, INSTANTS.fetchedAtMs - (liveEdgeAtMs - split.playerBufferMs));
  });

  /**
   * The case that decides the formula, and the one the old assertion could not see.
   *
   * A pipeline that made a segment fetchable the instant it closed has nothing left to measure, so a
   * viewer of it sits exactly `liveSyncDuration` behind live, because that is the definition of
   * `liveSyncDuration`. Anything that adds the total to the buffer reports a segment more than that.
   */
  it('reports exactly the buffer when the pipeline costs nothing beyond closing the segment', () => {
    const segmentDurationS = 2;
    const capturedAtMs = 1_000_000;
    const closedAtMs = capturedAtMs + segmentDurationS * 1_000;
    const instantlyFetchable: SegmentInstants = {
      ...INSTANTS,
      segmentDurationS,
      capturedAtMs,
      uploadedAtMs: closedAtMs,
      manifestPublishedAtMs: closedAtMs,
      visibleAtMs: closedAtMs,
      fetchedAtMs: closedAtMs,
    };

    const split = latencySplit(instantlyFetchable, NO_SKEW);

    assert.equal(split.totalMs, segmentDurationS * 1_000);
    assert.equal(split.viewerLatencyMs, split.playerBufferMs);
  });
});

/**
 * The reason a two-clock measurement is usable. If skew moved the total, the whole instrument would
 * be bounded by how well two machines agree on the time, which is routinely worse than the seconds
 * S5.2 is trying to detect.
 */
/**
 * The bench attributes a segment to the first manifest publish logged at or after its upload, and
 * that can be one publish early: the uploader builds a manifest and then awaits the feed write, so a
 * publish in flight when a segment lands completes afterwards while naming only what preceded it.
 * See `firstManifestAtOrAfter`.
 *
 * What survives is asserted here rather than argued in a comment, because it is the same shape as the
 * skew argument below and the same thing makes it true: the instant enters the split once positively
 * and once negatively.
 */
describe('what a manifest attributed one publish early can and cannot spoil', () => {
  const attributedEarly: SegmentInstants = { ...INSTANTS, manifestPublishedAtMs: INSTANTS.uploadedAtMs + 100 };

  it('moves time out of feed propagation and into the publish row', () => {
    assert.equal(hopMs(HOP_MANIFEST_PUBLISH, attributedEarly), 100);
    assert.equal(hopMs(HOP_MANIFEST_PUBLISH), 600);
    assert.equal(hopMs(HOP_FEED_PROPAGATION, attributedEarly) - hopMs(HOP_FEED_PROPAGATION), 500);
  });

  it('leaves the two rows summing to what they summed to before', () => {
    const pairMs = (instants: SegmentInstants) =>
      hopMs(HOP_MANIFEST_PUBLISH, instants) + hopMs(HOP_FEED_PROPAGATION, instants);

    assert.equal(pairMs(attributedEarly), pairMs(INSTANTS));
  });

  it('cannot move the total, which never sees that instant', () => {
    assert.equal(latencySplit(attributedEarly, NO_SKEW).totalMs, latencySplit(INSTANTS, NO_SKEW).totalMs);
  });
});

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
