import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type BenchRun,
  type DiscardedSegment,
  type LatencyTrend,
  latencyTrend,
  medianSample,
  renderReport,
  type SegmentSample,
} from '../src/bench/report.js';
import { type ClockSkew, type LatencySplit, latencySplit, type SegmentInstants } from '../src/bench/split.js';
import { DEFAULT_KNOBS } from '../src/bench/wallclockPublisher.js';

const BENCH_T0 = 1_785_677_886_564;
const SKEW: ClockSkew = { offsetMs: 120, uncertaintyMs: 8 };

/**
 * A measured sample around a split.
 *
 * `declaredDurationS` defaults to agreeing with the split's own measured duration, which is the case
 * every test that is not about the comparison wants: a disagreement prints an extra self-check line,
 * and a fixture that produced one by accident would put it under tests that never asked for it.
 */
function sampleOf(index: number, split: LatencySplit, declaredDurationS: number | null = 2): SegmentSample {
  return { index, ref: `ref${index}`.padEnd(16, '0'), split, declaredDurationS, videoPacketCount: 60 };
}

/** A sample whose total is `totalMs`, with the slack taken out of the fetch so the rows still sum. */
function sampleWithTotal(index: number, totalMs: number): SegmentSample {
  const instants: SegmentInstants = {
    capturedAtMs: BENCH_T0,
    segmentDurationS: 2,
    uploadedAtMs: BENCH_T0 + 3_400 + SKEW.offsetMs,
    manifestPublishedAtMs: BENCH_T0 + 4_000 + SKEW.offsetMs,
    visibleAtMs: BENCH_T0 + 5_200,
    fetchedAtMs: BENCH_T0 + totalMs,
  };
  return sampleOf(index, latencySplit(instants, SKEW));
}

function runWith(
  samples: readonly SegmentSample[],
  trend: LatencyTrend | null = { msPerMinute: 4, scatterMsPerMinute: 40 },
  discarded: readonly DiscardedSegment[] = [],
): BenchRun {
  return {
    measuredAt: '2026-08-02T20:00:00.000Z',
    engine: 'srs',
    profile: 'default',
    knobs: DEFAULT_KNOBS,
    samples,
    discarded,
    trend,
  };
}

describe('choosing what a run reports', () => {
  it('picks the median sample from an odd count', () => {
    const samples = [sampleWithTotal(1, 9_000), sampleWithTotal(2, 5_600), sampleWithTotal(3, 7_000)];

    assert.equal(medianSample(samples)?.index, 3);
  });

  it('picks the lower of the two middles from an even count, rather than inventing one between them', () => {
    const samples = [
      sampleWithTotal(1, 9_000),
      sampleWithTotal(2, 5_600),
      sampleWithTotal(3, 7_000),
      sampleWithTotal(4, 8_000),
    ];

    assert.equal(medianSample(samples)?.index, 3);
  });

  it('has no median for no samples', () => {
    assert.equal(medianSample([]), undefined);
  });

  /**
   * The whole reason a sample is chosen rather than the hops averaged. An averaged split sums to a
   * total no segment had, and Sprint 5 measures a later run against this one, so the baseline has to
   * be something that happened.
   */
  it('reports rows that still sum to the total it prints', () => {
    const samples = [sampleWithTotal(1, 9_000), sampleWithTotal(2, 5_600), sampleWithTotal(3, 7_000)];
    const median = medianSample(samples);

    assert.ok(median);
    assert.equal(
      median.split.hops.reduce((sum, hop) => sum + hop.ms, 0),
      median.split.totalMs,
    );
    assert.match(renderReport(runWith(samples)), /\*\*7\.00s\*\*/);
  });
});

describe('measuring how far a run moved while it was being taken', () => {
  /** Fetch instants a minute apart, and the capture instants `latencies` implies for them. */
  function seriesWithLatencies(latenciesMs: readonly number[]): [number[], number[]] {
    const stepMs = 60_000 / (latenciesMs.length - 1);
    const wallMs = latenciesMs.map((_, index) => BENCH_T0 + index * stepMs);
    return [wallMs, wallMs.map((wall, index) => wall - latenciesMs[index])];
  }

  it('reports no movement when every sample measured the same latency', () => {
    assert.deepEqual(latencyTrend(...seriesWithLatencies([5_000, 5_000, 5_000])), {
      msPerMinute: 0,
      scatterMsPerMinute: 0,
    });
  });

  it('reports latency shrinking across the run as positive', () => {
    assert.equal(latencyTrend(...seriesWithLatencies([5_600, 5_000]))?.msPerMinute, 600);
  });

  it('reports latency growing across the run as negative', () => {
    assert.equal(latencyTrend(...seriesWithLatencies([5_000, 5_300]))?.msPerMinute, -300);
  });

  /**
   * The defect this replaced. The old figure was these two ends and nothing else, published as the
   * publisher's clock drift: on the first real run it read +589ms per minute, and swapping which
   * segment happened to land last turned that into -980. A middle sample wider than either end
   * contributes nothing to the trend and everything to whether the trend means anything.
   */
  it('scatters across every sample, not only the two the trend is taken from', () => {
    const trend = latencyTrend(...seriesWithLatencies([5_100, 9_000, 5_000]));

    assert.equal(trend?.msPerMinute, 100);
    assert.equal(trend?.scatterMsPerMinute, 4_000);
  });

  /**
   * True for every possible run, because the trend is the difference between two latencies and both
   * of them are inside the scatter. Asserted rather than left as a comment, so that anyone tempted to
   * write "resolvable when the trend exceeds its scatter" finds out here that no run can reach it.
   */
  it('never produces a trend its own scatter does not cover', () => {
    for (const latencies of [
      [5_000, 5_000],
      [9_000, 5_000],
      [5_000, 9_000],
      [5_100, 9_000, 5_000],
      [1, 2, 3, 4],
    ]) {
      const trend = latencyTrend(...seriesWithLatencies(latencies));

      assert.ok(trend);
      assert.ok(
        Math.abs(trend.msPerMinute) <= trend.scatterMsPerMinute,
        `latencies ${latencies.join('/')} gave trend ${trend.msPerMinute} outside scatter ${trend.scatterMsPerMinute}`,
      );
    }
  });

  it('declines to report a trend from a single sample', () => {
    assert.equal(latencyTrend([BENCH_T0], [0]), null);
  });

  it('declines to report a trend across no elapsed time, rather than dividing by zero', () => {
    assert.equal(latencyTrend([BENCH_T0, BENCH_T0], [0, 2_000]), null);
  });

  it('declines to report a trend from mismatched series', () => {
    assert.equal(latencyTrend([BENCH_T0, BENCH_T0 + 60_000], [0]), null);
  });
});

describe('the report an operator reads', () => {
  const samples = [sampleWithTotal(1, 5_600), sampleWithTotal(2, 6_000), sampleWithTotal(3, 5_800)];

  it('leads with the figure a later sprint is measured against', () => {
    const report = renderReport(runWith(samples));

    assert.match(report, /capture to fetchable \| \*\*5\.80s\*\*/);
    // 5.80s total, less the 2s segment already inside the buffer's reach, plus the 10s buffer. Not
    // 15.80s: the total is anchored on a segment's first frame and the buffer is measured back from
    // the live edge, which is its last, so adding the two counts one segment twice.
    assert.match(report, /behind live\*\* \| \*\*13\.80s\*\*/);
  });

  /**
   * A run that measured one segment and dropped four looks exactly like a run that asked for one,
   * and the difference is a broken pipeline against a thin result. Each drop also cost a broadcast
   * and real postage, so it is not free to leave out.
   */
  it('names the segments that were paid for and produced no reading', () => {
    const report = renderReport(
      runWith(samples, null, [{ ref: 'abc123def456789', reason: 'no video packets in the segment' }]),
    );

    assert.match(report, /1 segment\(s\) reached the bench and could not be read/);
    assert.match(report, /abc123def456/);
    assert.match(report, /no video packets in the segment/);
  });

  /**
   * The guidance has to be decided from the run's own numbers, not asserted. Naming skew as the
   * suspect when the run's own uncertainty cannot cover the gap sends the reader at the one cause
   * already excluded, which is what the previous version did.
   */
  it('refuses to blame the skew estimate for a gap the skew estimate cannot cover', () => {
    // Uploaded 500ms before the segment it belongs to could have closed, which is 500ms of correction
    // against a skew this run bounded at 8ms.
    const impossible: SegmentInstants = {
      capturedAtMs: BENCH_T0,
      segmentDurationS: 2,
      uploadedAtMs: BENCH_T0 + 1_500 + SKEW.offsetMs,
      manifestPublishedAtMs: BENCH_T0 + 4_000 + SKEW.offsetMs,
      visibleAtMs: BENCH_T0 + 5_200,
      fetchedAtMs: BENCH_T0 + 5_800,
    };
    const sample = sampleOf(9, latencySplit(impossible, SKEW));
    const upload = sample.split.hops.find((hop) => hop.name === 'upload');
    assert.ok(upload && upload.ms < -SKEW.uncertaintyMs, 'fixture must produce a gap wider than the uncertainty');

    const report = renderReport(runWith([sample]));

    assert.match(report, /\*\*Not the skew estimate\.\*\*/);
    assert.doesNotMatch(report, /The totals are unaffected/);
  });

  it('names which segment the split came from, so it can be found in the sample list', () => {
    const report = renderReport(runWith(samples));

    assert.match(report, /segment 3, the median one/);
    assert.doesNotMatch(report, /is flagged below/);
  });

  /**
   * Two facts about one segment, in two sections, with nothing connecting them. On the first real run
   * the median was segment 24 and segment 24's upload hop was negative, so the report led with a split
   * it went on to call impossible, and never said they were the same segment. A reader who stopped at
   * the headline table had no way to know the self-checks were about it.
   */
  it('says at the headline when the sample it split is one the self-checks flag', () => {
    const impossible: SegmentInstants = {
      capturedAtMs: BENCH_T0,
      segmentDurationS: 2,
      uploadedAtMs: BENCH_T0 + 1_500 + SKEW.offsetMs,
      manifestPublishedAtMs: BENCH_T0 + 4_000 + SKEW.offsetMs,
      visibleAtMs: BENCH_T0 + 5_200,
      fetchedAtMs: BENCH_T0 + 5_800,
    };
    const sample = sampleOf(24, latencySplit(impossible, SKEW));

    const report = renderReport(runWith([sample]));

    assert.match(report, /segment 24, the median one/);
    assert.match(report, /is flagged below/);
    assert.match(report, /upload/);
  });

  it('names the configuration it measured, so a comparison cannot be made across different setups', () => {
    const report = renderReport(runWith(samples));

    assert.match(report, /engine `srs`/);
    assert.match(report, /1280x720 @ 30fps, 2500kbps, 2s GOP/);
  });

  it('marks the rows a wrong clock skew would move, and says it cannot move the total', () => {
    const report = renderReport(runWith(samples));

    assert.match(report, /\| upload \| \d+ \| ~ \|/);
    assert.match(report, /\| feedPropagation \| \d+ \| ~ \|/);
    assert.match(report, /\| segment \| \d+ \| {2}\|/);
    assert.match(report, /cancels in the total/);
  });

  /**
   * The split's other attributed boundary, and the one nothing in the table marks. A reader taking
   * `manifestPublish` on its own can be reading a feed write that had already started when the
   * segment landed.
   */
  it('says the manifest boundary is attributed by time, so those two rows read as one', () => {
    const report = renderReport(runWith(samples));

    assert.match(report, /attributed to the first publish\s+logged after the upload/);
    assert.match(report, /as one number/);
  });

  it('says outright when a run measured nothing, rather than printing a zero', () => {
    const report = renderReport(runWith([]));

    assert.match(report, /No segment was measured/);
    assert.doesNotMatch(report, /0\.00s/);
  });

  it('says when the trend was not measurable instead of reporting it as none', () => {
    assert.match(renderReport(runWith(samples, null)), /not measured/);
  });

  /**
   * The scatter has to travel with the figure, or a reader takes a number the run cannot support.
   * The report must also not claim which of the three causes it is, because the two series it has
   * cannot tell them apart at any sample count.
   */
  it('prints the trend with the scatter that covers it, and names no cause for it', () => {
    const report = renderReport(runWith(samples, { msPerMinute: 589, scatterMsPerMinute: 3_199 }));

    assert.match(report, /moved \+589ms per minute, inside a scatter of 3199ms per minute/);
    assert.match(report, /cannot say whether/);
  });

  /**
   * A negative hop means an input is wrong, and a report that hid it would present a split an
   * operator would then reason from.
   */
  it('surfaces a hop that came out negative, naming its segment', () => {
    const impossible = sampleWithTotal(4, 5_600);
    const broken: SegmentSample = {
      ...impossible,
      split: latencySplit(
        {
          capturedAtMs: BENCH_T0,
          segmentDurationS: 2,
          uploadedAtMs: BENCH_T0 + 3_400,
          manifestPublishedAtMs: BENCH_T0 + 4_000,
          visibleAtMs: BENCH_T0 + 5_200,
          fetchedAtMs: BENCH_T0 + 5_600,
        },
        { offsetMs: 9_000, uncertaintyMs: 8 },
      ),
    };

    const report = renderReport(runWith([broken]));

    assert.match(report, /hops that cannot be true/);
    assert.match(report, /segment 4: upload came out at -\d+ms/);
  });

  it('says so plainly when every hop is possible', () => {
    assert.match(renderReport(runWith(samples)), /no hop came out negative/);
  });

  it('lists every sample, not only the one it split', () => {
    const report = renderReport(runWith(samples));

    for (const sample of samples) {
      assert.match(report, new RegExp(`\\| ${sample.index} \\|`));
    }
  });
});

/**
 * LAT-9's own question, which the fix routes around rather than answers: the split is measured from
 * the bytes now, so an engine that misreports its segment durations no longer moves any figure, and
 * the only place that misreporting can still be seen is here.
 */
describe('reporting the manifest against the bytes', () => {
  /** Measured at 2s, declared at `declaredDurationS`, so the gap is the fixture's own parameter. */
  function declaring(index: number, declaredDurationS: number | null): SegmentSample {
    return { ...sampleWithTotal(index, 5_600), declaredDurationS };
  }

  it('names the widest disagreement and the segment it came from', () => {
    const report = renderReport(runWith([declaring(1, 2.02), declaring(2, 3.15), declaring(3, 1.99)]));

    assert.match(report, /disagree by at most 1150ms across 3 sample\(s\), worst at segment 2/);
    assert.match(report, /declared 3\.15s for 2\.00s of media/);
  });

  /**
   * Unconditional, for the reason the trend line is. A run cannot separate an engine that segments
   * unevenly from one that segments evenly and misreports, so a line that appeared only past some
   * threshold would state a judgement these numbers do not carry.
   */
  it('prints the comparison even when the two agree exactly', () => {
    const report = renderReport(runWith([declaring(1, 2), declaring(2, 2)]));

    assert.match(report, /disagree by at most 0ms across 2 sample\(s\)/);
  });

  /** The declared figure feeds nothing, so its absence costs the comparison and no other row. */
  it('says when no sample carried a readable duration, rather than reporting a zero gap', () => {
    const report = renderReport(runWith([declaring(1, null), declaring(2, null)]));

    assert.match(report, /no sample carried a readable `#EXTINF`/);
    assert.doesNotMatch(report, /disagree by at most/);
    assert.match(report, /capture to fetchable/, 'the split itself still reports');
  });

  /**
   * The line first said the gap "moves no other number in this report", which was the true half of a
   * false pair: nothing derives from the declared figure, and everything but the total derives from
   * the measured one. So a wide gap is evidence against the measurement too, and that direction is
   * the dangerous one. A span measured too small grows the `upload` hop instead of making it
   * negative, and a negative `upload` hop is the entire symptom LAT-9 was opened on.
   */
  it('does not blame the engine for a gap that is evidence against the measurement too', () => {
    const report = renderReport(runWith([declaring(1, 3.15)]));

    assert.match(report, /says one of the two is wrong and not which/);
    assert.match(report, /grows the `upload` hop rather than making it negative/);
    assert.doesNotMatch(report, /moves no other number/);
  });

  it('carries both durations and the packet count into the sample table', () => {
    const report = renderReport(runWith([declaring(7, 3.15)]));

    assert.match(report, /\| 7 \| `ref700000000` \| 5\.60s \| 2\.00s \| 3\.15s \| 60 \|/);
  });

  it('marks an unreadable declaration in the table rather than leaving the cell blank', () => {
    assert.match(renderReport(runWith([declaring(7, null)])), /\| 2\.00s \| unreadable \| 60 \|/);
  });
});
