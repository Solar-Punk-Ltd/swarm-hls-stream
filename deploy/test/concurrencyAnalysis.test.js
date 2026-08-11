import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTROL_INVALID, CONTROL_VALID, parseSweepRows, summariseSweep } from '../scripts/concurrency-analysis.mjs';

/**
 * The arithmetic that turns a browser sweep's raw fetches into a throughput claim, tested against the
 * ways it has actually been got wrong.
 *
 * Every in-browser throughput figure this project held before 2026-08-11 was retracted, and not one of
 * them was retracted because a fetch was mistimed. They were retracted because of what was computed
 * afterwards: a per-request p50 multiplied by a worker count, and a worker count that was assumed to
 * have been reached rather than measured. So the fetching is the easy half and it is not what this
 * file guards.
 */

/** @param {Partial<import('../scripts/concurrency-analysis.mjs').SweepRow>} over */
const row = (over) => ({
  arm: '4',
  round: 0,
  ref: 'aaaaaaaaaa',
  startMs: 0,
  endMs: 100,
  ms: 100,
  bytes: 92160,
  status: 200,
  overBudget: false,
  ...over,
});

/**
 * Rows plus the passing canary each of their rounds needs. An uncanaried round is deliberately
 * treated as degraded, so a fixture that skipped this would be summarising nothing at all.
 */
const sitting = (rows) => [
  ...[...new Set(rows.map((r) => r.round))].map((round) => row({ arm: 'canary', round, startMs: -1, endMs: 0, ms: 1 })),
  ...rows,
];

/** Four fetches, one after another, in an arm that asked for four workers. */
const sequentialFours = sitting([
  row({ startMs: 0, endMs: 100, ms: 100 }),
  row({ startMs: 100, endMs: 200, ms: 100 }),
  row({ startMs: 200, endMs: 300, ms: 100 }),
  row({ startMs: 300, endMs: 400, ms: 100 }),
]);

describe('achieved concurrency, which is measured and never assumed', () => {
  /**
   * ⭐ The test this whole module exists for. An arm labelled 4 whose requests never once overlapped
   * delivered the throughput of one worker, and reporting it under its label is how "203 KB/s at
   * concurrency 3" became a fact about weeb-3 when it was a fact about the harness.
   */
  it('reports what the requests actually overlapped, not what the arm asked for', () => {
    const [arm] = summariseSweep(sequentialFours).perArm;

    assert.equal(arm.requested, 4);
    assert.equal(arm.achievedPeak, 1);
    assert.equal(arm.achievedMean, 1);
  });

  it('flags an arm that never reached the concurrency it asked for', () => {
    const [arm] = summariseSweep(sequentialFours).perArm;

    assert.match(arm.reached, /only reached 1/);
  });

  it('says nothing when the arm did reach it', () => {
    const overlapping = sitting([
      row({ startMs: 0, endMs: 400 }),
      row({ startMs: 10, endMs: 400 }),
      row({ startMs: 20, endMs: 400 }),
      row({ startMs: 30, endMs: 400 }),
    ]);

    const [arm] = summariseSweep(overlapping).perArm;

    assert.equal(arm.achievedPeak, 4);
    assert.equal(arm.reached, '');
  });

  /**
   * A request ending exactly as the next begins is a handover, and counting it as two open at once
   * would let a strictly sequential arm report concurrency 2 and look like it scaled.
   */
  it('does not count a handover as an overlap', () => {
    const [arm] = summariseSweep(sitting([row({ startMs: 0, endMs: 100 }), row({ startMs: 100, endMs: 200 })])).perArm;

    assert.equal(arm.achievedPeak, 1);
  });

  /** Mean in-flight is the time-weighted figure, so half-overlapped work reads as 1.5 rather than 2. */
  it('reports mean in-flight time-weighted, not as a peak', () => {
    const halfOverlapped = sitting([
      row({ startMs: 0, endMs: 200, ms: 200 }),
      row({ startMs: 100, endMs: 200, ms: 100 }),
    ]);

    const [arm] = summariseSweep(halfOverlapped).perArm;

    assert.equal(arm.achievedPeak, 2);
    assert.equal(arm.achievedMean, 1.5);
  });
});

describe('throughput over the wall clock', () => {
  /**
   * ⛔ p50 x workers is the forbidden product. Here it would read 4 x 92160 bytes per 100ms, which is
   * about 3600 KB/s, against a true 900 KB/s. The two only agree when workers never contend, which is
   * the single thing a concurrency sweep is run to find out.
   */
  it('divides bytes by elapsed wall time rather than multiplying a median by the worker count', () => {
    const [arm] = summariseSweep(sequentialFours).perArm;

    assert.equal(arm.wallS, 0.4);
    assert.equal(arm.kbPerS, Math.round(((92160 * 4) / 1024 / 400) * 1000));
    assert.equal(arm.fetchPerS, 10);
  });

  it('measures an arm end to end, so idle time between its fetches counts against it', () => {
    const withAGap = sitting([row({ startMs: 0, endMs: 100, ms: 100 }), row({ startMs: 900, endMs: 1000, ms: 100 })]);

    const [arm] = summariseSweep(withAGap).perArm;

    assert.equal(arm.wallS, 1);
  });

  it('sums wall time across rounds instead of spanning the gap between them', () => {
    const twoRounds = sitting([
      row({ round: 0, startMs: 0, endMs: 100, ms: 100 }),
      row({ round: 1, startMs: 60000, endMs: 60100, ms: 100 }),
    ]);

    const [arm] = summariseSweep(twoRounds).perArm;

    assert.equal(arm.wallS, 0.2);
  });
});

describe('rows that did not deliver', () => {
  it('counts an over-budget row against the arm but takes no bytes from it', () => {
    const oneStuck = sitting([
      row({ startMs: 0, endMs: 100, ms: 100 }),
      row({ startMs: 100, endMs: 30100, ms: 30000, bytes: 0, status: 0, overBudget: true }),
    ]);

    const [arm] = summariseSweep(oneStuck).perArm;

    assert.equal(arm.inBudget, '1/2');
    assert.equal(arm.bytes, 92160);
  });

  /** A 30s abort left in the latency distribution would move a p90 by an order of magnitude. */
  it('keeps an over-budget row out of the latency percentiles', () => {
    const oneStuck = sitting([
      row({ startMs: 0, endMs: 100, ms: 100 }),
      row({ startMs: 100, endMs: 30100, ms: 30000, bytes: 0, status: 0, overBudget: true }),
    ]);

    const [arm] = summariseSweep(oneStuck).perArm;

    assert.equal(arm.p90Ms, 100);
  });

  /**
   * ⛔⛔ A stuck fetch still holds a slot, so it must stay in the overlap integral. Dropping it there
   * would make a node that has stopped answering look like a node running at low concurrency.
   */
  it('still counts a stuck fetch as occupying a slot', () => {
    const oneStuck = sitting([
      row({ startMs: 0, endMs: 30000, ms: 30000, bytes: 0, status: 0, overBudget: true }),
      row({ startMs: 0, endMs: 100, ms: 100 }),
    ]);

    const [arm] = summariseSweep(oneStuck).perArm;

    assert.equal(arm.achievedPeak, 2);
  });
});

describe('the degraded round', () => {
  /**
   * The node decays under sustained retrieval, so a round whose canary missed is measuring node health.
   * Excluding it is what stops that decay from being read as a concurrency effect.
   */
  it('drops every row of a round whose canary missed', () => {
    const rows = [
      row({ arm: 'canary', round: 0, startMs: -1, endMs: 0, ms: 1 }),
      row({ round: 0, startMs: 0, endMs: 100, ms: 100 }),
      row({ arm: 'canary', round: 1, startMs: 200, endMs: 30200, ms: 30000, bytes: 0, status: 0, overBudget: true }),
      row({ round: 1, startMs: 300, endMs: 400, ms: 100 }),
    ];

    const summary = summariseSweep(rows);

    assert.deepEqual(summary.degradedRounds, [1]);
    assert.equal(summary.perArm[0].inBudget, '1/1');
  });

  it('keeps a round whose canary came back', () => {
    const rows = [
      row({ arm: 'canary', round: 0, startMs: 0, endMs: 100, ms: 100 }),
      row({ round: 0, startMs: 100, endMs: 200, ms: 100 }),
    ];

    assert.deepEqual(summariseSweep(rows).degradedRounds, []);
  });

  /** A round with no canary row at all is not silently trusted. */
  it('treats a round that never ran a canary as degraded', () => {
    assert.deepEqual(summariseSweep([row({ round: 2 })]).degradedRounds, [2]);
  });
});

describe('the warm control, which has to be able to fail', () => {
  const cold = [row({ arm: 'canary', round: 0 }), row({ round: 0, startMs: 0, endMs: 800, ms: 800 })];

  it('passes when a re-read comes back far faster than the cold read', () => {
    const summary = summariseSweep([...cold, row({ arm: 'warm', round: -1, startMs: 900, endMs: 902, ms: 2 })]);

    assert.equal(summary.control, CONTROL_VALID);
  });

  /**
   * ⭐ The direction that matters. If a warm re-read costs what a cold one costs, the sweep timed our
   * own plumbing rather than retrieval, and every arm above it is void. A control with no failing
   * value is not a control.
   */
  it('fails when a re-read costs what the cold read cost', () => {
    const summary = summariseSweep([...cold, row({ arm: 'warm', round: -1, startMs: 900, endMs: 1700, ms: 800 })]);

    assert.equal(summary.control, CONTROL_INVALID);
  });

  it('refuses to claim a verdict when no warm rows were collected', () => {
    assert.equal(summariseSweep(cold).control, 'not run');
  });
});

describe('reading a sitting back off disk', () => {
  it('round-trips the rows a sitting saved, comments and all', () => {
    const tsv = [
      '# peers 129 connected / 71 connecting',
      'arm\tround\tref\tstartMs\tendMs\tms\tbytes\tstatus\toverBudget',
      '4\t0\taaaaaaaaaa\t0\t100\t100\t92160\t200\t',
      '4\t0\tbbbbbbbbbb\t100\t30100\t30000\t0\t0\tover-budget',
    ].join('\n');

    const rows = parseSweepRows(tsv);

    assert.equal(rows.length, 2);
    assert.equal(rows[0].bytes, 92160);
    assert.equal(rows[1].overBudget, true);
  });

  it('reaches the same verdict off disk as it did live', () => {
    const live = summariseSweep(sequentialFours);
    const header = 'arm\tround\tref\tstartMs\tendMs\tms\tbytes\tstatus\toverBudget';
    const body = sequentialFours.map((r) =>
      [r.arm, r.round, r.ref, r.startMs, r.endMs, r.ms, r.bytes, r.status, ''].join('\t'),
    );

    assert.deepEqual(summariseSweep(parseSweepRows([header, ...body].join('\n'))), live);
  });
});

describe('speedup against the smallest arm', () => {
  it('normalises every arm to the lowest concurrency present', () => {
    const rows = sitting([
      row({ arm: '1', startMs: 0, endMs: 1000, ms: 1000 }),
      row({ arm: '2', startMs: 0, endMs: 500, ms: 500 }),
      row({ arm: '2', startMs: 0, endMs: 500, ms: 500 }),
    ]);

    const summary = summariseSweep(rows);

    assert.equal(summary.perArm.find((a) => a.requested === 1).speedup, 1);
    assert.equal(summary.perArm.find((a) => a.requested === 2).speedup, 4);
  });
});
