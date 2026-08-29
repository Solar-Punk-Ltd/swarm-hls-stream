import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LIVE_SYNC_DURATION_S } from '../src/bench/clientTuning.js';
import { FEED_STATE_LIVE } from '../src/browser/feedState.js';
import { judgeCost, type ResourceReading } from '../src/browser/resources.js';
import { thinRequestLog } from '../src/browser/runFiles.js';
import { summarize, type ViewerSample } from '../src/browser/session.js';
import { judgeStability, MIN_WINDOWS_FOR_TREND, stabilitySection, WINDOW_MS } from '../src/browser/stability.js';

const SAMPLE_MS = 1_000;

const BASE: ViewerSample = {
  atMs: 0,
  currentTime: 0,
  paused: false,
  readyState: 4,
  playbackRate: 1,
  bufferAheadS: 5,
  liveLatencyS: LIVE_SYNC_DURATION_S,
  liveTargetLatencyS: LIVE_SYNC_DURATION_S,
  bufferStalls: 0,
  rebufferCount: 0,
  rebufferMs: 0,
  fatalErrors: 0,
  decodedFrames: 0,
  droppedFrames: 0,
  resolution: '1280×720',
  selectedRungHeight: 720,
  qualitySwitches: 0,
  abrEnabled: true,
  bandwidthEstimateKbps: 4200,
  feedStateMessage: null,
  feedState: FEED_STATE_LIVE,
};

/**
 * A run of `minutes` at one sample a second, with per-sample fields decided by where the sample sits.
 *
 * `at` receives the minute the sample falls in, so a test says "the last ten minutes degraded" as a
 * function of time rather than by indexing into an array of thousands.
 */
function longRun(minutes: number, at: (minute: number) => Partial<ViewerSample> = () => ({})): ViewerSample[] {
  const samples: ViewerSample[] = [];
  let currentTime = 0;
  for (let i = 0; i < minutes * 60; i++) {
    const minute = Math.floor(i / 60);
    const shape = at(minute);
    currentTime += shape.playbackRate ?? 1;
    samples.push({ ...BASE, ...shape, atMs: i * SAMPLE_MS, currentTime });
  }
  return samples;
}

describe('whether a long run held or only started well', () => {
  it('cuts the run into equal windows and drops the incomplete tail', () => {
    const verdict = judgeStability(longRun(32));

    assert.equal(verdict.windows.length, 6, 'a partial seventh window was reported as though it were whole');
    verdict.windows.forEach((w) => assert.equal(w.toMs - w.fromMs, WINDOW_MS));
  });

  it('calls a run that kept up in every window exactly that', () => {
    const verdict = judgeStability(longRun(30));

    assert.equal(verdict.heldEveryWindow, true);
    assert.equal(verdict.heldTargetEveryWindow, true);
    assert.equal(verdict.latencyDriftS, 0);
  });

  /**
   * The failure a 150 second run structurally cannot see, and the one predicted for this client: it
   * appends every segment it has ever seen and rebuilds the whole playlist on every poll, so if that
   * costs anything it costs more as the run goes on. Early windows fine, late windows degrading.
   */
  it('catches a run that was fine for twenty minutes and then degraded', () => {
    const verdict = judgeStability(longRun(30, (minute) => (minute >= 20 ? { playbackRate: 0.5 } : {})));

    assert.equal(verdict.heldEveryWindow, false, 'a run that fell apart in its last third read as healthy');
    const bad = verdict.windows.filter((w) => w.advanceRatio < 0.99).map((w) => w.index);
    assert.deepEqual(bad, [4, 5], 'the degradation was attributed to the wrong part of the run');
    assert.ok(verdict.advanceDrift !== null && verdict.advanceDrift < 0.6);
  });

  // The whole-run median is what this exists to be better than, so the degrading run has to be one
  // whose median still looks respectable. Otherwise the windows are proving nothing a median missed.
  it('is better than a median, on the same samples', () => {
    const samples = longRun(30, (minute) => (minute >= 20 ? { playbackRate: 0.5 } : {}));
    const overall =
      ((samples[samples.length - 1].currentTime - samples[0].currentTime) * 1000) /
      (samples[samples.length - 1].atMs - samples[0].atMs);

    assert.ok(overall > 0.8, `the whole-run ratio was ${overall.toFixed(3)}, which a median would already flag`);
    assert.equal(judgeStability(samples).heldEveryWindow, false);
  });

  it('reports latency drifting away across the run', () => {
    const verdict = judgeStability(longRun(30, (minute) => ({ liveLatencyS: LIVE_SYNC_DURATION_S + minute * 0.5 })));

    assert.ok(verdict.latencyDriftS !== null && verdict.latencyDriftS > 10, 'a steady climb was not reported');
    assert.equal(verdict.heldTargetEveryWindow, false);
  });

  /**
   * The rebuffers here land exactly on a window boundary, which is the case that reads as zero
   * everywhere if a window is measured against its own first sample: both ends of the window that
   * received them already carry the new total.
   */
  it('charges a rebuffer at a window boundary to the window it landed in', () => {
    const verdict = judgeStability(longRun(20, (minute) => ({ rebufferCount: minute >= 10 ? 3 : 0 })));

    assert.equal(verdict.windows[0].rebuffers, 0, 'a later rebuffer was charged to an earlier window');
    assert.equal(verdict.windows[1].rebuffers, 0);
    assert.equal(verdict.windows[2].rebuffers, 3, 'a rebuffer on a window boundary was charged to nobody');
    assert.equal(verdict.windows[3].rebuffers, 0, 'the running total was read as a fresh rebuffer');
  });

  // A short run has no trend to report, and printing one anyway is how a two-point line becomes a
  // claim. Every browser run before 2026-08-06 was 150 seconds.
  it('says nothing at all about a run too short to have a trend', () => {
    assert.deepEqual(stabilitySection(judgeStability(longRun(10))), []);
    assert.ok(judgeStability(longRun(MIN_WINDOWS_FOR_TREND * 5 + 1)).windows.length >= MIN_WINDOWS_FOR_TREND);
  });

  it('has nothing to say about no samples at all', () => {
    const verdict = judgeStability([]);

    assert.deepEqual(verdict.windows, []);
    assert.equal(verdict.latencyDriftS, null);
    assert.equal(verdict.heldEveryWindow, false);
  });
});

describe('what a run cost the deployment', () => {
  const reading = (atMs: number, utilization: number, bzz: number): ResourceReading => ({
    atMs,
    batchId: '7849851f404265dd2bea17e4229b45be23e245210ea17ac0af3a2a2b13faa2fd',
    postageUtilization: utilization,
    postageCapacity: 256,
    postageTtlDays: 30,
    postageImmutable: true,
    uploaderBzz: bzz,
  });

  it('turns two readings into a rate per broadcast-minute', () => {
    const cost = judgeCost(reading(0, 10, 10), reading(10 * 60_000, 14, 9.8));

    assert.equal(cost.minutes, 10);
    assert.equal(cost.bucketsUsed, 4);
    assert.equal(cost.bucketsPerMinute, 0.4);
    assert.ok(Math.abs(cost.bzzPerMinute - 0.02) < 1e-9);
  });

  /** The number the funding decision turns on, and the reason a run measures itself at all. */
  it('projects how much broadcasting is left at the rate it just measured', () => {
    const cost = judgeCost(reading(0, 6, 10), reading(10 * 60_000, 8, 9.8));

    assert.equal(cost.minutesOfPostageLeft, (256 - 8) / 0.2);
    assert.ok(cost.minutesOfBzzLeft !== null && Math.abs(cost.minutesOfBzzLeft - 9.8 / 0.02) < 1e-6);
  });

  /**
   * The figure that carries to another bitrate, which the per-minute rate does not.
   *
   * ⛔ Measured 2026-08-07 across seventeen recorded runs at a fixed 0.25s segment: **0.0179 BZZ per
   * broadcast-minute at 720p against 0.0389 at 1080p**, so a runway projected at the first while
   * running the second is out by 2.2x. Normalised by bytes those same runs sit inside 0.00081 to
   * 0.00096 across the whole 2.5x spread in bitrate.
   */
  it('prices the run per megabyte delivered, not only per minute', () => {
    const cost = judgeCost(reading(0, 10, 10), reading(10 * 60_000, 14, 9.8), 250_000_000);

    assert.ok(cost.bzzPerMegabyte !== null);
    // 0.2 BZZ spent over 250 MB.
    assert.ok(Math.abs(cost.bzzPerMegabyte - 0.0008) < 1e-12);
  });

  /**
   * The same spend at half the bitrate is the same price per byte and half the price per minute.
   * Asserting both directions in one test is the point: it is the pair that carries the lesson.
   */
  it('holds per megabyte where the per-minute rate moves with the bitrate', () => {
    const lean = judgeCost(reading(0, 10, 10), reading(10 * 60_000, 12, 9.9), 125_000_000);
    const rich = judgeCost(reading(0, 10, 10), reading(10 * 60_000, 14, 9.8), 250_000_000);

    assert.ok(lean.bzzPerMegabyte !== null && rich.bzzPerMegabyte !== null);
    assert.ok(Math.abs(lean.bzzPerMegabyte - rich.bzzPerMegabyte) < 1e-12, 'per megabyte should not move');
    assert.ok(Math.abs(rich.bzzPerMinute - 2 * lean.bzzPerMinute) < 1e-9, 'per minute should double');
  });

  /**
   * Null rather than zero. A crash run that watched nothing has not shown that bytes are free, it has
   * shown that it cannot answer, and those two read very differently beside a funding decision.
   */
  it('reports no price per byte when the run counted no bytes', () => {
    assert.equal(judgeCost(reading(0, 10, 10), reading(10 * 60_000, 14, 9.8)).bzzPerMegabyte, null);
    assert.equal(judgeCost(reading(0, 10, 10), reading(10 * 60_000, 14, 9.8), 0).bzzPerMegabyte, null);
  });

  /**
   * Null rather than Infinity. A run too short to move a counter has not shown the resource is
   * plentiful, it has shown that this run cannot answer, and those read very differently in a report.
   */
  it('refuses to project from a run that consumed nothing measurable', () => {
    const cost = judgeCost(reading(0, 6, 10), reading(60_000, 6, 10));

    assert.equal(cost.minutesOfPostageLeft, null);
    assert.equal(cost.minutesOfBzzLeft, null);
  });

  it('warns while there is still room, not once the batch is full', () => {
    const cost = judgeCost(reading(0, 200, 10), reading(60_000, 210, 9.9));

    assert.ok(
      cost.warnings.some((w) => w.includes('210/256')),
      `no postage warning at 82% full: ${cost.warnings.join(' | ')}`,
    );
    assert.ok(
      cost.warnings.some((w) => w.includes('immutable')),
      'the warning did not say what filling it does',
    );
  });

  it('warns on a chequebook that will not carry another long run', () => {
    const cost = judgeCost(reading(0, 10, 1.6), reading(60_000, 11, 1.2));

    assert.ok(
      cost.warnings.some((w) => w.includes('chequebook')),
      `no BZZ warning: ${cost.warnings.join(' | ')}`,
    );
  });

  it('says nothing when both resources are comfortable', () => {
    assert.deepEqual(judgeCost(reading(0, 10, 10), reading(60_000, 11, 9.9)).warnings, []);
  });
});

describe('thinning a long run request log', () => {
  const record = (status: number | null) => ({ status });

  it('leaves a short log exactly as it was', () => {
    const records = Array.from({ length: 100 }, () => record(200));

    assert.equal(thinRequestLog(records).length, 100);
  });

  /**
   * A refusal or a failure is why anyone opens this file, so those survive whatever the run's length.
   * The successes only have to keep their shape.
   */
  it('keeps every failure and refusal out of a log too big to keep whole', () => {
    const records = [
      ...Array.from({ length: 50_000 }, () => record(200)),
      ...Array.from({ length: 37 }, () => record(404)),
      ...Array.from({ length: 5 }, () => record(null)),
    ];

    const thinned = thinRequestLog(records);

    assert.equal(thinned.filter((r) => r.status === 404).length, 37);
    assert.equal(thinned.filter((r) => r.status === null).length, 5);
    assert.ok(thinned.length < 6_000, `thinned to ${thinned.length}, which is not thin`);
  });

  it('keeps the log in the order it was recorded, since the gaps are the signal', () => {
    const records = [record(200), record(404), record(200), record(500), record(200)];

    assert.deepEqual(thinRequestLog(records), records);
  });
});

/**
 * The client destroys and remounts its player when a manifest will not parse, which is what the
 * switch from a live playlist to the finished VOD one looks like at the end of a broadcast. The page
 * reports rebuffers, fatal errors and dropped frames as running totals, so the fresh instance starts
 * them at zero and everything the run had accumulated stops being visible in the last sample.
 */
describe('summarising a run whose player restarted', () => {
  /** A run that plays `beforeS`, restarts, then plays `afterS` from the beginning of the VOD. */
  function restartedRun(beforeS: number, afterS: number, atRestart: Partial<ViewerSample> = {}): ViewerSample[] {
    const before = Array.from({ length: beforeS }, (_, i) => ({
      ...BASE,
      atMs: i * SAMPLE_MS,
      currentTime: i + 1,
      droppedFrames: i,
    }));
    const after = Array.from({ length: afterS }, (_, i) => ({
      ...BASE,
      atMs: (beforeS + i + 1) * SAMPLE_MS,
      currentTime: i,
      droppedFrames: i,
    }));
    return [...before, { ...before[before.length - 1], ...atRestart, atMs: beforeS * SAMPLE_MS }, ...after];
  }

  it('counts a fatal error that the restart it triggered then erased', () => {
    const samples = restartedRun(150, 300, { currentTime: 0, fatalErrors: 1 });

    assert.equal(summarize(samples).fatalErrors, 1);
  });

  it('adds the rebuffers from before the restart to the ones after it', () => {
    const samples = restartedRun(150, 300, { currentTime: 0, rebufferCount: 4, rebufferMs: 900 });
    const after = samples.slice(-10).map((sample) => ({ ...sample, rebufferCount: 2, rebufferMs: 500 }));

    const summary = summarize([...samples.slice(0, -10), ...after]);

    assert.equal(summary.rebufferCount, 6);
    assert.equal(summary.rebufferMs, 1_400);
  });

  it('counts the media played on both sides rather than reading a rewind as a stall', () => {
    const samples = restartedRun(150, 300, { currentTime: 0 });

    // 150s before the restart and 299 after, against 451 wall seconds: a player that never stopped.
    assert.ok(
      summarize(samples).overallAdvanceRatio > 0.95,
      `read ${summarize(samples).overallAdvanceRatio}, which reads a replay as a freeze`,
    );
  });

  /**
   * The counters open at a non-zero value here because a real window opens after a settle the player
   * has already been counting through. What the window cost is what they gained inside it, so a run
   * that arrives with 2 rebuffers already counted and gains 2 more reports 2, not 4.
   */
  it('leaves a run that never restarted exactly as it was', () => {
    const samples = longRun(3).map((sample, i) => ({
      ...sample,
      rebufferCount: i === 0 ? 2 : 4,
      droppedFrames: i,
    }));

    const summary = summarize(samples);

    assert.equal(summary.rebufferCount, 2);
    assert.equal(summary.droppedFrames, samples.length - 1);
    assert.equal(summary.fatalErrors, 0);
    assert.ok(Math.abs(summary.overallAdvanceRatio - 1) < 0.01);
  });
});
