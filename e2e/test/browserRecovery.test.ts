import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LIVE_SYNC_DURATION_S } from '../src/bench/clientTuning.js';
import { FAULT_SCENARIOS, scenarioByName } from '../src/browser/faults.js';
import { judgeRecovery } from '../src/browser/recovery.js';
import { type ViewerSample } from '../src/browser/session.js';

const SAMPLE_MS = 1_000;

const BASE: ViewerSample = {
  atMs: 0,
  currentTime: 0,
  paused: false,
  readyState: 4,
  playbackRate: 1,
  bufferAheadS: 5,
  liveLatencyS: LIVE_SYNC_DURATION_S,
  rebufferCount: 0,
  rebufferMs: 0,
  fatalErrors: 0,
  droppedFrames: 0,
  resolution: '1280×720',
  feedStateMessage: null,
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

    const verdict = judgeRecovery(samples, { injectedAtMs: 3 * SAMPLE_MS, liftedAtMs: 6 * SAMPLE_MS });

    assert.equal(verdict.before.ratio, 1, 'the baseline picked up the outage');
    assert.equal(verdict.during.ratio, 0, 'the picture was moving while the service was down');
    assert.equal(verdict.after.ratio, 1, 'playback did not come back to full rate');
  });

  it('reports the longest stretch the picture did not move', () => {
    const samples = run([1, 0, 1, 0, 0, 0, 1]);

    const verdict = judgeRecovery(samples, { injectedAtMs: SAMPLE_MS, liftedAtMs: 6 * SAMPLE_MS });

    assert.equal(verdict.longestFreezeMs, 3 * SAMPLE_MS, 'a longer freeze was reported as a shorter one');
  });

  /**
   * The number the whole exercise is for. "Recovered" says nothing about whether a viewer waited two
   * seconds or forty, and both read the same in a run long enough to end well.
   */
  it('times the recovery from the fault being lifted, not from the freeze starting', () => {
    const samples = run([1, 1, 0, 0, 0, 0, 1, 1]);

    const verdict = judgeRecovery(samples, { injectedAtMs: 2 * SAMPLE_MS, liftedAtMs: 5 * SAMPLE_MS });

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

    const verdict = judgeRecovery(samples, { injectedAtMs: 2 * SAMPLE_MS, liftedAtMs: 4 * SAMPLE_MS });

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

    const verdict = judgeRecovery(samples, { injectedAtMs: SAMPLE_MS, liftedAtMs: 3 * SAMPLE_MS });

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

    const verdict = judgeRecovery(samples, { injectedAtMs: SAMPLE_MS, liftedAtMs: 3 * SAMPLE_MS });

    assert.deepEqual(verdict.saidWhileFrozen, ['Reconnecting to the stream'], 'the message was not read once');
    assert.equal(verdict.explainedTheFreeze, true);
  });

  it('reports a freeze the client never explained', () => {
    const samples = run([1, 0, 0, 1]);

    const verdict = judgeRecovery(samples, { injectedAtMs: SAMPLE_MS, liftedAtMs: 3 * SAMPLE_MS });

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

    const verdict = judgeRecovery(samples, { injectedAtMs: 2 * SAMPLE_MS, liftedAtMs: 3 * SAMPLE_MS });

    assert.equal(verdict.latencyBeforeS, 6);
    assert.equal(verdict.latencyAfterS, 41, 'a viewer who resumed in the past reads as a clean recovery');
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
