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
import { type ClockSkew, latencySplit, type SegmentInstants } from '../src/bench/split.js';
import { DEFAULT_KNOBS } from '../src/bench/wallclockPublisher.js';

const BENCH_T0 = 1_785_677_886_564;
const SKEW: ClockSkew = { offsetMs: 120, uncertaintyMs: 8 };

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
  return { index, ref: `ref${index}`.padEnd(16, '0'), split: latencySplit(instants, SKEW) };
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
    const sample: SegmentSample = { index: 9, ref: 'ref9'.padEnd(16, '0'), split: latencySplit(impossible, SKEW) };
    const upload = sample.split.hops.find((hop) => hop.name === 'upload');
    assert.ok(upload && upload.ms < -SKEW.uncertaintyMs, 'fixture must produce a gap wider than the uncertainty');

    const report = renderReport(runWith([sample]));

    assert.match(report, /\*\*Not the skew estimate\.\*\*/);
    assert.doesNotMatch(report, /The totals are unaffected/);
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
