import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildRetrievalRow,
  describeCap,
  describeRetrieval,
  externalCapRefusal,
  h0Check,
  type IdleWindow,
  type InTabProbeRun,
  judgeRoundDegraded,
  linkOccupancy,
  probeArmOrder,
  readCapSource,
  refsNeededPerRound,
  renderInTabProbeReport,
  type RetrievalRow,
  summarizeAmplification,
  summarizeIdleWindow,
  summarizePair,
} from '../src/browser/inTabProbe.js';
import { judgeCost, type ResourceReading } from '../src/browser/resources.js';
import { type WebSocketTraffic } from '../src/browser/webSocketTraffic.js';

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
    capSource: 'cdp',
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
    capSource: 'cdp',
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

/**
 * The cap that is not Chrome's.
 *
 * ⛔ H0 exists because `Network.emulateNetworkConditions` is applied by the browser and a harness
 * cannot assert from outside that it reached a given transport. A `tc` policer on the container's
 * interface is not that: it sits under every socket the tab opens, and the shaper has already
 * measured what it delivers. So the H0 line has to change rather than be answered again with a
 * reading that no longer means anything, and it has to name the proved rate.
 */
describe('the cap a run was actually under', () => {
  it('reads the two modes and refuses any other spelling', () => {
    assert.equal(readCapSource('cdp'), 'cdp');
    assert.equal(readCapSource('external'), 'external');
    assert.equal(readCapSource(''), 'cdp', 'the emulated cap is what every earlier run used');
    for (const raw of ['CDP', 'shaper', 'tc', 'externa']) {
      assert.throws(() => readCapSource(raw), /PROBE_CAP_MODE/, `${JSON.stringify(raw)} was accepted`);
    }
  });

  it('says which kind of cap a row ran under, so no reader has to assume', () => {
    assert.equal(describeCap(null, 'cdp'), 'uncapped');
    assert.equal(describeCap(CAP_KBPS, 'cdp'), '2800 kbps');
    assert.equal(describeCap(CAP_KBPS, 'external'), 'external 2800 kbps');
  });

  /**
   * ⛔ The label and the shaper have to agree. A run told `PROBE_CAP_KBPS=700` while the shaper
   * proved 350,000 bytes/s would put "external 700 kbps" on every row of an artifact measured at
   * 2800, and nothing downstream could ever catch it.
   */
  it('refuses an external run whose label disagrees with the proved rate', () => {
    assert.equal(externalCapRefusal(CAP_KBPS, 350_000), null);
    assert.equal(externalCapRefusal(CAP_KBPS, 300_000), null, 'a policer delivering under its rate is ordinary');
    assert.match(externalCapRefusal(700, 350_000) ?? '', /disagrees/);
    assert.match(externalCapRefusal(CAP_KBPS, 900_000) ?? '', /disagrees/);
  });

  it('refuses an external run that carries no preflight reading at all', () => {
    assert.match(externalCapRefusal(CAP_KBPS, null) ?? '', /PROBE_EXTERNAL_CAP_MEASURED_BPS/);
  });

  it('drops the free arms, because an external cap cannot be lifted for one row', () => {
    assert.deepEqual(probeArmOrder(0, 'external'), [
      { arm: '360p', capped: true },
      { arm: '1080p', capped: true },
    ]);
    assert.deepEqual(probeArmOrder(1, 'external'), [...probeArmOrder(0, 'external')].reverse());
  });

  /**
   * ⭐ Derived from the arm order rather than written down beside it. The reference pool is sized
   * before the browser opens and no reference is fetched twice, so a count that drifted from the
   * arms would either run the pool dry mid-sitting or leave the last arms unrun, with the artifact
   * already half written either way.
   */
  it('needs one reference per arm plus the canary, counted off the arms themselves', () => {
    assert.deepEqual(refsNeededPerRound('cdp'), { '360p': 3, '1080p': 2 });
    assert.deepEqual(refsNeededPerRound('external'), { '360p': 2, '1080p': 1 });
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

function probeRun(
  retrievals: readonly RetrievalRow[],
  idleWindows: readonly IdleWindow[],
  overrides: Partial<InTabProbeRun> = {},
): InTabProbeRun {
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
    gapMs: 15_000,
    capKbps: CAP_KBPS,
    lowCapKbps: LOW_CAP_KBPS,
    capSource: 'cdp',
    externalCapMeasuredBps: null,
    idleWindows,
    retrievals,
    pairs: [],
    cost: judgeCost(reading(START_MS, 4.2), reading(START_MS + 600_000, 4.2), 0),
    ...overrides,
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
    assert.match(markdown, /of the cap while capped rows ran/);
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

/**
 * The report an externally shaped run leaves behind.
 *
 * ⛔ What separates it from a CDP run is not the numbers, it is what the numbers can be compared
 * against. A `tc` policer sits on the container's interface for the life of the container, so there
 * is no uncapped condition inside the run at all: no unthrottled idle window and no free arm. The
 * report has to say where the uncapped comparison lives rather than leave a reader to assume the
 * absence means nothing was found.
 */
describe('the report an external cap leaves behind', () => {
  const shaped = { capSource: 'external' as const, lowCapKbps: null, externalCapMeasuredBps: 349_120 };
  const windows = [
    idleWindow({
      label: `external ${CAP_KBPS} kbps`,
      kbpsCap: CAP_KBPS,
      capSource: 'external',
      inBytesPerSecondMean: 2_064,
    }),
  ];
  const shapedRows = [
    retrieval({ arm: 'canary', kbpsCap: CAP_KBPS, capSource: 'external', roundIndex: 0 }),
    retrieval({ arm: '360p', kbpsCap: CAP_KBPS, capSource: 'external', amplification: 1.96, roundIndex: 0 }),
    retrieval({ arm: '1080p', kbpsCap: CAP_KBPS, capSource: 'external', amplification: 2.41, roundIndex: 0 }),
    retrieval({ arm: 'pair', kbpsCap: CAP_KBPS, capSource: 'external', amplification: 2.02, roundIndex: 0 }),
  ];
  const shapedRun = probeRun(shapedRows, windows, shaped);

  it('replaces the H0 reading with the rate the preflight proved', () => {
    const markdown = renderInTabProbeReport(shapedRun);

    assert.match(markdown, /H0 does not apply/);
    assert.match(markdown, /349,120 B\/s/);
    assert.doesNotMatch(markdown, /H0 holds/, 'an emulated cap is not what this run was under');
    assert.doesNotMatch(markdown, /H0 fails/);
  });

  it('names every row as externally capped rather than leaving the kind unsaid', () => {
    assert.match(renderInTabProbeReport(shapedRun), /external 2800 kbps/);
  });

  /**
   * One window, because there is no second cap to hold and no uncapped state to compare with.
   *
   * ⛔ Asserted on the sentence that only Part A carries. The first version of this matched
   * "uncapped comparison" and "CDP run of the same day", both of which the predictions table also
   * says, so deleting the Part A note left the test green: a mutation run is what found that.
   */
  it('sends the reader to the CDP run of the same day for the uncapped comparison', () => {
    const markdown = renderInTabProbeReport(shapedRun);

    assert.match(markdown, /There is no uncapped condition inside an externally capped run/);
    assert.match(markdown, /one idle window and no free arm/);
    assert.match(markdown, /uncapped comparison is the CDP run of the same day/);
  });

  it('shows no uncapped column in the ratios, since no row could have filled one', () => {
    const markdown = renderInTabProbeReport(shapedRun);

    assert.match(markdown, /\| 360p \| external 2800 kbps \| 1\.96 \/ 1\.96 \/ 1\.96 \(n=1\) \|/);
    assert.doesNotMatch(markdown, /\| 360p \| uncapped \|/);
  });

  it('still answers H2 off its one idle window', () => {
    assert.match(renderInTabProbeReport(shapedRun), /2,064 bytes\/s/);
  });

  /**
   * ⛔ Two sentences that were simply false under an external cap, found by reading a rendered
   * report end to end rather than by any assertion. Part B claimed "an unthrottled 360p canary"
   * when the policer cannot be lifted for one row, and Part C named a bare "2800 kbps cap".
   */
  it('never claims an unthrottled canary or a bare cap it did not have', () => {
    const markdown = renderInTabProbeReport(shapedRun);

    assert.doesNotMatch(markdown, /unthrottled 360p canary/);
    assert.match(markdown, /under the same cap as every other row/);
    assert.doesNotMatch(markdown, /together under the 2800 kbps cap/);
    assert.match(markdown, /together under the external 2800 kbps cap/);
  });

  it('keeps saying the canary is unthrottled where it really is', () => {
    const emulated = probeRun(
      [retrieval({ arm: 'canary' }), retrieval({ arm: 'pair', kbpsCap: CAP_KBPS })],
      [idleWindow(), idleWindow({ kbpsCap: LOW_CAP_KBPS })],
    );
    const markdown = renderInTabProbeReport(emulated);

    assert.match(markdown, /unthrottled 360p canary/);
    assert.doesNotMatch(markdown, /under the same cap as every other row/);
    assert.match(markdown, /together under the 2800 kbps cap/);
  });
});

describe('how full the capped link was while a row ran', () => {
  // 2800 kbps allows 350,000 bytes a second.
  it('reads inbound bytes against what the cap allowed over the watched time', () => {
    const row = retrieval({ kbpsCap: CAP_KBPS, inBytesDuring: 262_500, settledAtMs: START_MS + 2_500 });

    // 262,500 over 2.5 s is 105,000 a second, which is 30% of the cap.
    assert.ok(Math.abs((linkOccupancy(row) ?? 0) - 0.3) < 1e-9);
  });

  it('has nothing to say about an uncapped row', () => {
    assert.equal(linkOccupancy(retrieval()), null);
  });

  it('reads a budget row over the budget, which is how long the harness watched', () => {
    const row = retrieval({
      kbpsCap: CAP_KBPS,
      outcome: 'budget',
      settledAtMs: null,
      elapsedMs: null,
      byteLength: null,
      amplification: null,
      inBytesTailAfter: null,
      inBytesDuring: 3_150_000,
    });

    // 3,150,000 over 90 s is a tenth of what the cap allows.
    assert.ok(Math.abs((linkOccupancy(row) ?? 0) - 0.1) < 1e-9);
  });

  it('prints the spread over the capped rows beside H3', () => {
    const rows = [retrieval({ arm: '360p', kbpsCap: CAP_KBPS, inBytesDuring: 262_500 })];
    const markdown = renderInTabProbeReport(probeRun(rows, []));

    assert.match(markdown, /Link at 30% \/ 30% \/ 30% \(n=1\) of the cap while capped rows ran/);
  });
});

describe('a Part C pair read together', () => {
  const traffic: WebSocketTraffic = {
    connections: [],
    frames: [
      { atMs: START_MS + 100, direction: 'in', bytes: 100_000 },
      { atMs: START_MS + 3_000, direction: 'in', bytes: 200_000 },
      // After the union window, so it belongs to neither row and not to the pair.
      { atMs: START_MS + 9_000, direction: 'in', bytes: 50_000 },
    ],
  };
  const rows = [
    retrieval({
      arm: 'pair',
      kbpsCap: CAP_KBPS,
      startedAtMs: START_MS,
      settledAtMs: START_MS + 2_500,
      byteLength: 100_000,
    }),
    retrieval({
      arm: 'pair',
      kbpsCap: CAP_KBPS,
      startedAtMs: START_MS + 50,
      settledAtMs: START_MS + 5_000,
      byteLength: 120_000,
    }),
  ];

  it('spans from the first start to the last settle and sums both payloads', () => {
    const pair = summarizePair(rows, traffic);

    assert.equal(pair.startedAtMs, START_MS);
    assert.equal(pair.watchedUntilMs, START_MS + 5_000);
    assert.equal(pair.inBytes, 300_000);
    assert.equal(pair.payloadBytes, 220_000);
    assert.ok(Math.abs((pair.amplification ?? 0) - 300_000 / 220_000) < 1e-9);
    // 300,000 over 5 s against the 350,000 a second the cap allows.
    assert.ok(Math.abs((pair.occupancy ?? 0) - 300_000 / 1_750_000) < 1e-9);
  });

  it('carries no payload figure when neither row returned one', () => {
    const empty = rows.map((row) => ({ ...row, byteLength: null, amplification: null }));

    const pair = summarizePair(empty, traffic);

    assert.equal(pair.payloadBytes, null);
    assert.equal(pair.amplification, null);
  });

  it('reaches the report as one line about both rows', () => {
    const run = { ...probeRun(rows, []), pairs: [summarizePair(rows, traffic)] };

    assert.match(
      renderInTabProbeReport(run),
      /Pair 0 together: 300,000 bytes inbound over 5 s against 220,000 payload bytes, ×1\.36, link at 17% of the cap/,
    );
  });
});

describe('the order the arms of a round run in', () => {
  /**
   * ⭐ Alternated so drift over the sitting does not land on one arm. Sustained retrieval degrades a
   * weeb-3 node after two or three rounds, so a fixed order would hand the last arm every round's
   * worst conditions and the report would read that as a property of the arm.
   */
  it('runs the four arms of a round, capped and free, on both rungs', () => {
    assert.deepEqual(probeArmOrder(0, 'cdp'), [
      { arm: '360p', capped: true },
      { arm: '1080p', capped: true },
      { arm: '360p', capped: false },
      { arm: '1080p', capped: false },
    ]);
  });

  it('reverses the order on the next round', () => {
    assert.deepEqual(probeArmOrder(1, 'cdp'), [...probeArmOrder(0, 'cdp')].reverse());
  });

  it('comes back to the opening order on the round after that', () => {
    assert.deepEqual(probeArmOrder(2, 'cdp'), probeArmOrder(0, 'cdp'));
  });
});

describe('an idle window read off the frames around it', () => {
  const traffic: WebSocketTraffic = {
    connections: [
      { url: 'wss://one.invalid', openedAtMs: START_MS - 1_000, closedAtMs: null },
      { url: 'wss://two.invalid', openedAtMs: START_MS + 1_500, closedAtMs: null },
    ],
    frames: [
      { atMs: START_MS + 100, direction: 'in', bytes: 1_000 },
      { atMs: START_MS + 1_100, direction: 'in', bytes: 3_000 },
      { atMs: START_MS + 1_200, direction: 'out', bytes: 500 },
    ],
  };

  const window = summarizeIdleWindow(
    {
      label: 'capped at 700 kbps',
      kbpsCap: LOW_CAP_KBPS,
      capSource: 'cdp',
      startedAtMs: START_MS,
      endedAtMs: START_MS + 2_000,
    },
    traffic,
  );

  /** H2 asks what share of the link idle chatter takes, so the divisor is the whole window. */
  it('divides the window bytes by the window seconds rather than by the busy ones', () => {
    assert.equal(window.inBytesPerSecondMean, 2_000);
    assert.equal(window.outBytesPerSecondMean, 250);
  });

  it('keeps the whole per-second series, quiet seconds included', () => {
    assert.equal(window.perSecond.length, 2);
  });

  /** A node that shed or gained peers across a window was a different node at either end of it. */
  it('counts the connections open at each end', () => {
    assert.equal(window.connectionsOpenStart, 1);
    assert.equal(window.connectionsOpenEnd, 2);
  });

  it('reads a window of no length as zero rather than dividing by it', () => {
    const empty = summarizeIdleWindow(
      { label: 'none', kbpsCap: null, capSource: 'cdp', startedAtMs: START_MS, endedAtMs: START_MS },
      traffic,
    );

    assert.equal(empty.inBytesPerSecondMean, 0);
  });
});

describe('a retrieval row built from the traffic around it', () => {
  const traffic: WebSocketTraffic = {
    connections: [],
    frames: [
      { atMs: START_MS - 500, direction: 'in', bytes: 9_999 },
      { atMs: START_MS + 100, direction: 'in', bytes: 400_000 },
      { atMs: START_MS + 200, direction: 'out', bytes: 300 },
      { atMs: START_MS + 300, direction: 'out', bytes: 300 },
      { atMs: START_MS + 3_000, direction: 'in', bytes: 50_000 },
      { atMs: START_MS + 89_000, direction: 'in', bytes: 7_777 },
    ],
  };

  const observed = {
    arm: '360p' as const,
    kbpsCap: CAP_KBPS,
    capSource: 'cdp' as const,
    ref: 'a'.repeat(64),
    roundIndex: 0,
    roundDegraded: false,
    startedAtMs: START_MS,
    budgetMs: BUDGET_MS,
    tailMs: TAIL_MS,
  };

  const settled = {
    ...observed,
    settledAtMs: START_MS + 2_000,
    outcome: 'resolved' as const,
    byteLength: 200_000,
    elapsedMs: 2_000,
  };

  it('counts only what crossed the link between the start and the settle', () => {
    const row = buildRetrievalRow(settled, traffic);

    assert.equal(row.inBytesDuring, 400_000);
    assert.equal(row.outFramesDuring, 2);
    assert.equal(row.amplification, 2);
  });

  /** The late answers. weeb-3 detaches a timed-out attempt rather than cancelling it, so they land. */
  it('counts the tail from the settle forward', () => {
    assert.equal(buildRetrievalRow(settled, traffic).inBytesTailAfter, 50_000);
  });

  /**
   * ⛔⛔ A row the harness stopped waiting for has no settle, so it has no tail either. Its window is
   * the budget, which is how long the harness watched, and never a duration the node produced.
   */
  it('measures a budget row over the budget and gives it no tail at all', () => {
    const row = buildRetrievalRow(
      { ...observed, settledAtMs: null, outcome: 'budget', byteLength: null, elapsedMs: null },
      traffic,
    );

    assert.equal(row.inBytesDuring, 457_777);
    assert.equal(row.inBytesTailAfter, null);
    assert.equal(row.amplification, null);
  });

  it('carries the round it belongs to and whether that round could be read', () => {
    const row = buildRetrievalRow({ ...settled, roundIndex: 2, roundDegraded: true }, traffic);

    assert.equal(row.roundIndex, 2);
    assert.equal(row.roundDegraded, true);
  });
});
