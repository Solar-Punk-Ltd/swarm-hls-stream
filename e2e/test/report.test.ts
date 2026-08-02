import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type BenchRun,
  medianSample,
  paceDriftMsPerMinute,
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

function runWith(samples: readonly SegmentSample[], paceDriftMsPerMinute: number | null = 4): BenchRun {
  return {
    measuredAt: '2026-08-02T20:00:00.000Z',
    engine: 'srs',
    profile: 'default',
    knobs: DEFAULT_KNOBS,
    samples,
    paceDriftMsPerMinute,
  };
}

describe('choosing what a run reports', () => {
  it('picks the median sample from an odd count', () => {
    const samples = [sampleWithTotal(1, 9_000), sampleWithTotal(2, 5_600), sampleWithTotal(3, 7_000)];

    assert.equal(medianSample(samples)?.index, 3);
  });

  it('picks the lower of the two middles from an even count, rather than inventing one between them', () => {
    const samples = [sampleWithTotal(1, 9_000), sampleWithTotal(2, 5_600), sampleWithTotal(3, 7_000), sampleWithTotal(4, 8_000)];

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

describe('measuring the publisher against its own clock', () => {
  /**
   * The bias nothing else in the pipeline can reveal. The encoder anchors on the first frame's wall
   * clock and then advances at the nominal frame rate, so if those two rates differ every latency in
   * the run is wrong by the accumulated difference, in the direction of looking better than it was.
   */
  it('reports no drift when media time and wall time advanced together', () => {
    const captured = [BENCH_T0, BENCH_T0 + 60_000];
    const media = [0, 60_000];

    assert.equal(paceDriftMsPerMinute(captured, media), 0);
  });

  it('reports media running fast as a positive drift per minute', () => {
    const captured = [BENCH_T0, BENCH_T0 + 60_000];
    const media = [0, 60_600];

    assert.equal(paceDriftMsPerMinute(captured, media), 600);
  });

  it('reports media running slow as a negative drift', () => {
    assert.equal(paceDriftMsPerMinute([BENCH_T0, BENCH_T0 + 120_000], [0, 119_400]), -300);
  });

  it('declines to report drift from a single sample', () => {
    assert.equal(paceDriftMsPerMinute([BENCH_T0], [0]), null);
  });

  it('declines to report drift across no elapsed time, rather than dividing by zero', () => {
    assert.equal(paceDriftMsPerMinute([BENCH_T0, BENCH_T0], [0, 2_000]), null);
  });

  it('declines to report drift from mismatched series', () => {
    assert.equal(paceDriftMsPerMinute([BENCH_T0, BENCH_T0 + 60_000], [0]), null);
  });
});

describe('the report an operator reads', () => {
  const samples = [sampleWithTotal(1, 5_600), sampleWithTotal(2, 6_000), sampleWithTotal(3, 5_800)];

  it('leads with the figure a later sprint is measured against', () => {
    const report = renderReport(runWith(samples));

    assert.match(report, /capture to fetchable \| \*\*5\.80s\*\*/);
    assert.match(report, /behind live\*\* \| \*\*15\.80s\*\*/);
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

  it('says when drift was not measurable instead of reporting it as none', () => {
    assert.match(renderReport(runWith(samples, null)), /not measured/);
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
