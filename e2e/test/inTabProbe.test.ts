import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeRetrieval,
  h0Check,
  type IdleWindow,
  type InTabProbeRun,
  judgeRoundDegraded,
  renderInTabProbeReport,
  type RetrievalRow,
  summarizeAmplification,
} from '../src/browser/inTabProbe.js';
import { judgeCost, type ResourceReading } from '../src/browser/resources.js';

/**
 * The judging and rendering the in-tab throttle probe files its answer through.
 *
 * ⛔ Nothing here asserts a timing. What is tested is that a row which missed its budget is
 * DESCRIBED as one rather than published as a duration, that a degraded round is kept out of the
 * ratios it would otherwise skew, and that the H0 sentence can come out both ways. A report whose
 * verdict prose cannot flip is a report that cannot say anything.
 */

const START_MS = 1_756_800_000_000;
const BUDGET_MS = 90_000;
const TAIL_MS = 10_000;
const CAP_KBPS = 2_800;
const LOW_CAP_KBPS = 700;

function retrieval(overrides: Partial<RetrievalRow> = {}): RetrievalRow {
  return {
    arm: '360p',
    kbpsCap: null,
    ref: 'a'.repeat(64),
    startedAtMs: START_MS,
    settledAtMs: START_MS + 2_500,
    outcome: 'resolved',
    byteLength: 224_848,
    elapsedMs: 2_500,
    budgetMs: BUDGET_MS,
    inBytesDuring: 250_000,
    outFramesDuring: 40,
    inBytesTailAfter: 0,
    amplification: 1.112,
    roundDegraded: false,
    roundIndex: 0,
    ...overrides,
  };
}

function idleWindow(overrides: Partial<IdleWindow> = {}): IdleWindow {
  return {
    label: 'unthrottled',
    kbpsCap: null,
    startedAtMs: START_MS,
    endedAtMs: START_MS + 60_000,
    perSecond: [],
    inBytesPerSecondMean: 4_200,
    outBytesPerSecondMean: 900,
    connectionsOpenStart: 148,
    connectionsOpenEnd: 151,
    ...overrides,
  };
}

describe('whether a round can be read at all', () => {
  /** The canary is one unthrottled 360p retrieval. If that cannot land, the node is the variable. */
  it('lets a round through when its canary resolved inside the budget', () => {
    assert.equal(judgeRoundDegraded(retrieval({ arm: 'canary', elapsedMs: 3_100 }), BUDGET_MS), false);
  });

  it('marks the round degraded when the canary never completed', () => {
    const missed = retrieval({
      arm: 'canary',
      outcome: 'budget',
      settledAtMs: null,
      elapsedMs: null,
      byteLength: null,
    });
    assert.equal(judgeRoundDegraded(missed, BUDGET_MS), true);
  });

  it('marks the round degraded when the canary was refused', () => {
    assert.equal(judgeRoundDegraded(retrieval({ arm: 'canary', outcome: 'rejected' }), BUDGET_MS), true);
  });

  /**
   * ⭐ The budget is a parameter rather than read off the row, so a canary that resolved just past a
   * budget the harness raced it against still counts as a miss.
   */
  it('marks the round degraded when the canary resolved but took longer than the budget', () => {
    assert.equal(judgeRoundDegraded(retrieval({ arm: 'canary', elapsedMs: BUDGET_MS + 1 }), BUDGET_MS), true);
  });
});

describe('how one retrieval is described', () => {
  /**
   * ⛔⛔ The whole point. A retrieval the harness stopped waiting for has no duration, and printing
   * the budget as one would publish "90.0s" as a measurement of a node that may still be fetching.
   */
  it('says a budget row did not complete, and never how long it took', () => {
    const missed = retrieval({ outcome: 'budget', settledAtMs: null, elapsedMs: null, byteLength: null });

    assert.equal(describeRetrieval(missed), 'did not complete in 90 s');
    assert.doesNotMatch(describeRetrieval(missed), /90\.0 s|90 s elapsed/);
  });

  it('gives a resolved row its elapsed time and the bytes it returned', () => {
    assert.equal(describeRetrieval(retrieval()), '2.5 s, 224,848 bytes');
  });

  it('says a rejected row was refused and how long that took', () => {
    assert.equal(describeRetrieval(retrieval({ outcome: 'rejected', elapsedMs: 1_200 })), 'rejected after 1.2 s');
  });
});

describe('the amplification a set of rows shows', () => {
  it('reports the spread and how many rows it came from', () => {
    const rows = [0.9, 3.4, 7.1].map((ratio) => retrieval({ amplification: ratio }));

    assert.deepEqual(summarizeAmplification(rows), { n: 3, min: 0.9, median: 3.4, max: 7.1 });
  });

  /** With an even count the middle is the mean of the two middle values, not either of them. */
  it('takes the median of an even count between the two middle rows', () => {
    const rows = [1, 2, 4, 8].map((ratio) => retrieval({ amplification: ratio }));

    assert.deepEqual(summarizeAmplification(rows), { n: 4, min: 1, median: 3, max: 8 });
  });

  it('reads the rows by value rather than by the order they were collected in', () => {
    const rows = [8, 1, 4, 2].map((ratio) => retrieval({ amplification: ratio }));

    assert.deepEqual(summarizeAmplification(rows), { n: 4, min: 1, median: 3, max: 8 });
  });

  /** A row that returned no payload has no ratio, and dropping it changes n as well as the spread. */
  it('leaves out a row that has no ratio', () => {
    const rows = [retrieval({ amplification: 2 }), retrieval({ amplification: null }), retrieval({ amplification: 4 })];

    assert.deepEqual(summarizeAmplification(rows), { n: 2, min: 2, median: 3, max: 4 });
  });

  it('has nothing to report when no row carries a ratio', () => {
    assert.equal(summarizeAmplification([retrieval({ amplification: null })]), null);
  });
});

describe('the instrument check the capped figures depend on', () => {
  it('passes when idle inbound stayed inside what the cap allows', () => {
    const sentence = h0Check(idleWindow({ kbpsCap: LOW_CAP_KBPS, inBytesPerSecondMean: 4_000 }));

    assert.match(sentence, /^✅/);
    assert.match(sentence, /87,500 bytes\/s/);
  });

  /**
   * ⛔⛔⛔ The reading that voids the run. If a 700 kbps cap does not hold aggregate inbound under
   * 87,500 bytes/s then the cap is per connection or absent, and every capped ratio in the report is
   * a number about an uncapped link. The sentence has to say that rather than note it.
   */
  it('fails, and says every capped figure is void, when idle inbound went past the cap', () => {
    const sentence = h0Check(idleWindow({ kbpsCap: LOW_CAP_KBPS, inBytesPerSecondMean: 120_000 }));

    assert.match(sentence, /^⛔/);
    assert.match(sentence, /void/);
  });

  it('refuses to answer for a window that was never capped', () => {
    const sentence = h0Check(idleWindow({ kbpsCap: null }));

    assert.match(sentence, /^⛔/);
    assert.match(sentence, /not capped/);
  });
});

function reading(atMs: number, bzz: number): ResourceReading {
  return {
    atMs,
    nodes: [
      {
        rung: '360p',
        port: 11_071,
        batchId: 'b4b44086',
        postageUtilization: 12,
        postageCapacity: 256,
        postageTtlDays: 30,
        postageImmutable: true,
        bzz,
      },
    ],
  };
}

function probeRun(retrievals: readonly RetrievalRow[], idleWindows: readonly IdleWindow[]): InTabProbeRun {
  return {
    measuredAt: '2026-09-02T20:00:00.000Z',
    clientUrl: 'http://stage.invalid:8080',
    chromeVersion: 'Chrome 149.0.7827.55',
    owner: '8d8a30ff4cbcf8ad0e0773547686295f8157feb0',
    manifests: [
      { rung: '360p', topicHex: '906fe47f', segmentCount: 127, targetDurationS: 3, medianSegmentSeconds: 2.068 },
      { rung: '1080p', topicHex: 'fbb12dbb', segmentCount: 127, targetDurationS: 3, medianSegmentSeconds: 2.068 },
    ],
    joinedInMs: 10_400,
    budgetMs: BUDGET_MS,
    tailMs: TAIL_MS,
    capKbps: CAP_KBPS,
    lowCapKbps: LOW_CAP_KBPS,
    idleWindows,
    retrievals,
    cost: judgeCost(reading(START_MS, 4.2), reading(START_MS + 600_000, 4.2), 0),
  };
}

describe('the report the probe leaves behind', () => {
  const windows = [
    idleWindow(),
    idleWindow({ label: `capped at ${CAP_KBPS} kbps`, kbpsCap: CAP_KBPS, inBytesPerSecondMean: 6_100 }),
    idleWindow({ label: `capped at ${LOW_CAP_KBPS} kbps`, kbpsCap: LOW_CAP_KBPS, inBytesPerSecondMean: 5_400 }),
  ];

  const rows = [
    retrieval({ arm: 'canary', roundIndex: 0 }),
    retrieval({ arm: '360p', kbpsCap: CAP_KBPS, amplification: 6.4, roundIndex: 0 }),
    retrieval({ arm: '1080p', kbpsCap: CAP_KBPS, amplification: 9.2, roundIndex: 0 }),
    retrieval({ arm: '360p', amplification: 1.05, roundIndex: 0 }),
    retrieval({ arm: 'pair', kbpsCap: CAP_KBPS, amplification: 5.5, roundIndex: 0 }),
  ];

  it('states what ran, the predictions and the cost, under a heading that asserts nothing', () => {
    const markdown = renderInTabProbeReport(probeRun(rows, windows));

    assert.match(markdown, /observations, none of them asserted/);
    assert.match(markdown, /http:\/\/stage\.invalid:8080/);
    assert.match(markdown, /Chrome 149\.0\.7827\.55/);
    assert.match(markdown, /8d8a30ff4cbcf8ad0e0773547686295f8157feb0/);
    assert.match(markdown, /127/);
    assert.match(markdown, /## What this run consumed/);
  });

  /** The line hls.js gives up on is what makes a slow retrieval a viewer-visible fault. */
  it('marks the 20 s line hls.js abandons a fragment at', () => {
    assert.match(renderInTabProbeReport(probeRun(rows, windows)), /20 s/);
  });

  it('restates each pre-registered prediction with what was observed beside it', () => {
    const markdown = renderInTabProbeReport(probeRun(rows, windows));

    assert.match(markdown, /H1/);
    assert.match(markdown, /3\.0/);
    assert.match(markdown, /H2/);
    assert.match(markdown, /105,000 bytes\/s/);
    assert.match(markdown, /H3/);
  });

  it('prints a budget row as not completing rather than as a duration', () => {
    const missed = retrieval({
      arm: '1080p',
      kbpsCap: CAP_KBPS,
      outcome: 'budget',
      settledAtMs: null,
      elapsedMs: null,
      byteLength: null,
      amplification: null,
      inBytesTailAfter: null,
    });

    assert.match(renderInTabProbeReport(probeRun([...rows, missed], windows)), /did not complete in 90 s/);
  });

  /**
   * ⛔⛔ A degraded round's rows are reported and kept out of the ratios. Averaging them in would
   * blame the node for a round in which the node was already not answering, which is the shape a
   * finding gets buried in.
   */
  it('keeps a degraded round out of the ratios and lists it on its own', () => {
    const degraded = retrieval({
      arm: '360p',
      kbpsCap: CAP_KBPS,
      ref: 'd'.repeat(64),
      amplification: 99,
      roundDegraded: true,
      roundIndex: 1,
    });
    const markdown = renderInTabProbeReport(probeRun([...rows, degraded], windows));

    // The clean capped 360p row is the only one the spread may be taken over, so n stays at one and
    // the degraded row's ratio reaches no summary.
    assert.match(markdown, /\| 360p \| 2800 kbps \| 6\.40 \/ 6\.40 \/ 6\.40 \(n=1\) \|/);
    assert.match(markdown, /1 row\(s\) come from a degraded round/);
    assert.match(markdown, /dddddddddddd/);
  });

  it('says so plainly when no round was degraded', () => {
    assert.match(renderInTabProbeReport(probeRun(rows, windows)), /no round was degraded/);
  });

  it('renders a run whose idle windows are missing rather than throwing', () => {
    const markdown = renderInTabProbeReport(probeRun(rows, []));

    assert.match(markdown, /observations, none of them asserted/);
  });
});
