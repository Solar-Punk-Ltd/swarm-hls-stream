import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LIVE_SYNC_DURATION_S } from '../src/bench/clientTuning.js';
import { FAULT_SCENARIOS, scenarioByName } from '../src/browser/faults.js';
import { FEED_STATE_LIVE } from '../src/browser/feedState.js';
import { judgeRecovery } from '../src/browser/recovery.js';
import { renderCrashReport } from '../src/browser/recoveryReport.js';
import { summarize, type ViewerSample } from '../src/browser/session.js';

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
  feedStateMessage: null,
  feedState: FEED_STATE_LIVE,
};

/**
 * A run described as media seconds gained per sample, which is the axis everything here judges on.
 *
 * `1` is playing, `0` is frozen. Written as a list so a test reads as the shape of the session it
 * builds: `[1, 1, 0, 0, 1]` is a run that stalled for two seconds in the middle.
 */
function run(gains: readonly number[], overridesAt: Record<number, Partial<ViewerSample>> = {}): ViewerSample[] {
  let currentTime = 0;
  return gains.map((gain, i) => {
    currentTime += gain;
    return { ...BASE, atMs: i * SAMPLE_MS, currentTime, ...overridesAt[i] };
  });
}

describe('what a viewer experienced across a fault', () => {
  // The shape every scenario is measured against: playing, stopped while the service is down, playing
  // again once it is back.
  it('separates the rate before, during and after the fault', () => {
    const samples = run([1, 1, 1, 0, 0, 0, 1, 1, 1]);

    const verdict = judgeRecovery(samples, {
      injectedAtMs: 3 * SAMPLE_MS,
      liftedAtMs: 6 * SAMPLE_MS,
      servingAtMs: null,
    });

    assert.equal(verdict.before.ratio, 1, 'the baseline picked up the outage');
    assert.equal(verdict.during.ratio, 0, 'the picture was moving while the service was down');
    assert.equal(verdict.after.ratio, 1, 'playback did not come back to full rate');
  });

  /**
   * The defect this exists for. `docker start` returns when the container exists, not when the
   * process inside it serves: on 2026-08-06 the bee gateway returned from it at t+79.1s and did not
   * answer a 200 until t+86.3s. Charging those 7.2 seconds to the viewer set fix 0.8b a target no
   * client change could reach, and made a fix that worked read as a fix that had not.
   */
  it('measures recovery from the service answering, not from docker returning', () => {
    const samples = run([1, 1, 0, 0, 0, 0, 1, 1]);
    const injectedAtMs = 2 * SAMPLE_MS;
    const liftedAtMs = 3 * SAMPLE_MS;
    const servingAtMs = 5 * SAMPLE_MS;

    const verdict = judgeRecovery(samples, { injectedAtMs, liftedAtMs, servingAtMs });

    assert.equal(verdict.recoveredAfterLiftMs, SAMPLE_MS, 'the service startup was charged to the viewer');
    assert.equal(verdict.serviceStartupMs, 2 * SAMPLE_MS, 'the startup the viewer waited through went unreported');
  });

  // Without a readiness signal there is nothing better to measure from, and the figure then includes
  // the startup. Falling back silently is fine only because the report says which one it is.
  it('falls back to docker returning when readiness could not be established', () => {
    const samples = run([1, 1, 0, 0, 0, 0, 1, 1]);

    const verdict = judgeRecovery(samples, {
      injectedAtMs: 2 * SAMPLE_MS,
      liftedAtMs: 3 * SAMPLE_MS,
      servingAtMs: null,
    });

    assert.equal(verdict.recoveredAfterLiftMs, 3 * SAMPLE_MS);
    assert.equal(verdict.serviceStartupMs, null, 'a startup was reported that was never measured');
  });

  it('reports the longest stretch the picture did not move', () => {
    const samples = run([1, 0, 1, 0, 0, 0, 1]);

    const verdict = judgeRecovery(samples, { injectedAtMs: SAMPLE_MS, liftedAtMs: 6 * SAMPLE_MS, servingAtMs: null });

    assert.equal(verdict.longestFreezeMs, 3 * SAMPLE_MS, 'a longer freeze was reported as a shorter one');
  });

  /**
   * The number the whole exercise is for. "Recovered" says nothing about whether a viewer waited two
   * seconds or forty, and both read the same in a run long enough to end well.
   */
  it('times the recovery from the fault being lifted, not from the freeze starting', () => {
    const samples = run([1, 1, 0, 0, 0, 0, 1, 1]);

    const verdict = judgeRecovery(samples, {
      injectedAtMs: 2 * SAMPLE_MS,
      liftedAtMs: 5 * SAMPLE_MS,
      servingAtMs: null,
    });

    assert.equal(verdict.freezeStartedAfterFaultMs, 0, 'the picture stopped on the sample the fault landed');
    assert.equal(verdict.recoveredAfterLiftMs, SAMPLE_MS, 'the wait after the service returned is misreported');
    assert.equal(verdict.recovered, true);
  });

  /**
   * A viewer holds `LIVE_SYNC_DURATION_S` seconds of runway, so an outage shorter than that should
   * cost them nothing. Reporting a freeze that did not happen would make a scenario that passed look
   * like one that failed.
   */
  it('says nothing froze when the buffer covered the whole outage', () => {
    const samples = run([1, 1, 1, 1, 1, 1]);

    const verdict = judgeRecovery(samples, {
      injectedAtMs: 2 * SAMPLE_MS,
      liftedAtMs: 4 * SAMPLE_MS,
      servingAtMs: null,
    });

    assert.equal(verdict.longestFreezeMs, 0);
    assert.equal(verdict.freezeStartedAfterFaultMs, null);
    assert.equal(verdict.recoveredAfterLiftMs, null);
    assert.equal(verdict.recovered, true);
    assert.equal(verdict.explainedTheFreeze, true, 'a run with no freeze has nothing to explain');
  });

  // A picture that came back and then stopped for good is not a recovery, and judging on the first
  // moving sample after the freeze would call it one.
  it('does not call it recovered when playback stopped again and stayed stopped', () => {
    const samples = run([1, 0, 0, 1, 1, 0, 0, 0]);

    const verdict = judgeRecovery(samples, { injectedAtMs: SAMPLE_MS, liftedAtMs: 3 * SAMPLE_MS, servingAtMs: null });

    assert.equal(verdict.recovered, false, 'a run that ended frozen was reported as recovered');
  });

  /**
   * The product's words rather than its timing, and the failure worth catching: a stopped picture
   * with an overlay that still says the feed is live is a viewer who reloads or leaves.
   */
  it('collects what the client told the viewer while the picture was stopped', () => {
    const samples = run([1, 0, 0, 1], {
      1: { feedStateMessage: 'Reconnecting to the stream' },
      2: { feedStateMessage: 'Reconnecting to the stream' },
    });

    const verdict = judgeRecovery(samples, { injectedAtMs: SAMPLE_MS, liftedAtMs: 3 * SAMPLE_MS, servingAtMs: null });

    assert.deepEqual(verdict.saidWhileFrozen, ['Reconnecting to the stream'], 'the message was not read once');
    assert.equal(verdict.explainedTheFreeze, true);
  });

  it('reports a freeze the client never explained', () => {
    const samples = run([1, 0, 0, 1]);

    const verdict = judgeRecovery(samples, { injectedAtMs: SAMPLE_MS, liftedAtMs: 3 * SAMPLE_MS, servingAtMs: null });

    assert.deepEqual(verdict.saidWhileFrozen, []);
    assert.equal(verdict.explainedTheFreeze, false, 'a silently frozen picture passed as explained');
  });

  /**
   * A player can resume and still be watching the past. Coming back forty seconds behind is a
   * different outcome from coming back at the edge, and the advance ratio cannot tell them apart
   * because both play at 1.0.
   */
  it('reports where the player sat before the fault and where it ended up', () => {
    const samples = run([1, 1, 0, 1, 1], { 0: { liveLatencyS: 6 }, 4: { liveLatencyS: 41 } });

    const verdict = judgeRecovery(samples, {
      injectedAtMs: 2 * SAMPLE_MS,
      liftedAtMs: 3 * SAMPLE_MS,
      servingAtMs: null,
    });

    assert.equal(verdict.latencyBeforeS, 6);
    assert.equal(verdict.latencyAfterS, 41, 'a viewer who resumed in the past reads as a clean recovery');
  });

  /**
   * ⚠️ The crash report is where this matters most, and it is the one place a stall is **guaranteed**:
   * the whole point of a fault is to make the player stall.
   *
   * hls.js raises its own latency target by up to a target duration after a stall and never lowers it,
   * so latency after a fault is legitimately higher than before by that much, with no drift and no
   * failure to recover. `renderCrashReport` warns "it resumed in the past" above a **two second**
   * increase, which sits inside the penalty range, so the warning could not tell a player that came
   * back late from a player that came back exactly where hls.js now wants it.
   */
  it('separates a target the fault raised from latency the recovery lost', () => {
    const samples = run([1, 1, 0, 1, 1], {
      0: { liveLatencyS: 6, liveTargetLatencyS: 6 },
      4: { liveLatencyS: 8.5, liveTargetLatencyS: 7, bufferStalls: 1 },
    });

    const verdict = judgeRecovery(samples, {
      injectedAtMs: 2 * SAMPLE_MS,
      liftedAtMs: 3 * SAMPLE_MS,
      servingAtMs: null,
    });

    assert.equal(verdict.targetRaisedByS, 1, 'the fault moved the target, and that is not lost latency');
    assert.equal(verdict.latencyAfterS, 8.5);
  });

  it('reports no raise when the fault left the target where it was', () => {
    const samples = run([1, 1, 0, 1, 1], { 4: { liveLatencyS: 41 } });

    const verdict = judgeRecovery(samples, {
      injectedAtMs: 2 * SAMPLE_MS,
      liftedAtMs: 3 * SAMPLE_MS,
      servingAtMs: null,
    });

    assert.equal(verdict.targetRaisedByS, 0, 'a 35s excursion with the target untouched is all real');
  });
});

describe('the fault scenario catalog', () => {
  it('names every scenario uniquely, since the name selects it and titles its report', () => {
    const names = FAULT_SCENARIOS.map((scenario) => scenario.name);

    assert.equal(new Set(names).size, names.length, `duplicate scenario names: ${names.join(', ')}`);
  });

  it('refuses an unknown scenario by name, listing the ones it has', () => {
    assert.throws(() => scenarioByName('gateway-outage'), /unknown crash scenario.*viewer-gateway-outage/s);
  });

  it('resolves each catalogued scenario by its own name', () => {
    FAULT_SCENARIOS.forEach((scenario) => assert.equal(scenarioByName(scenario.name), scenario));
  });
});

/**
 * A run that ends the broadcast and a viewer stranded on one that is still being published are
 * opposite outcomes, and the report gave them one verdict: the engine-restart run of 2026-08-05
 * behaved exactly as designed and was written up as "⛔ It did not recover".
 */
describe('reporting a fault that is supposed to end the broadcast', () => {
  const scenario = scenarioByName('engine-restart');
  const samples = run([1, 1, 0, 0, 0, 0], { 2: { feedStateMessage: 'Waiting for the broadcast to continue' } });
  const fault = { injectedAtMs: 2 * SAMPLE_MS, liftedAtMs: 3 * SAMPLE_MS, servingAtMs: null };

  const rendered = renderCrashReport({
    measuredAt: '2026-08-05T00:00:00.000Z',
    watchUrl: 'http://client.test/#/watch/video/owner/topic?qoe=1',
    chromeVersion: 'Chrome 151',
    gopSeconds: 0.25,
    scenario,
    container: 'latbench-srs-1',
    fault,
    summary: summarize(samples),
    recovery: judgeRecovery(samples, fault),
    instrument: { sound: true, failures: [], firedChecks: [], soundSamples: samples.length },
    samples,
    screenshots: [],
  });

  it('declares that this fault ends the broadcast', () => {
    assert.equal(scenario.expectRecovery, false, 'the fixture no longer tests what this describe is about');
  });

  it('does not call a picture that correctly stayed stopped a failure', () => {
    assert.doesNotMatch(rendered, /⛔ \*\*It did not recover/, 'the designed outcome was reported as a defect');
    assert.match(rendered, /✅ \*\*Playback did not resume, which is correct here/);
  });

  // The half that still has to hold. A broadcast that ends and says so is a viewer who stops waiting.
  it('still requires that the viewer was told', () => {
    assert.match(rendered, /the viewer was told, and they were\./);
  });

  it('names the container in a tense a person would write', () => {
    assert.match(rendered, /was \*\*restarted\*\*/);
    assert.doesNotMatch(rendered, /restartped/);
  });
});
