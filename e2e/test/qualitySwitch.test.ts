import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { judgeQualitySwitch, type ThrottleWindow } from '../src/browser/qualitySwitch.js';
import { type ViewerSample } from '../src/browser/session.js';

const START_MS = 1_756_377_600_000;
const INTERVAL_MS = 1_000;

const THROTTLED_AT = START_MS + 10 * INTERVAL_MS;
const RELEASED_AT = START_MS + 20 * INTERVAL_MS;
const WINDOW: ThrottleWindow = { appliedAtMs: THROTTLED_AT, liftedAtMs: RELEASED_AT, kbps: 1200 };

interface SamplePlan {
  /** The rung the player selected, by height. */
  rung: number | null;
  /** Media seconds gained since the previous sample. 1 is keeping up, 0 is a frozen picture. */
  advanced?: number;
  resolution?: string | null;
  abrEnabled?: boolean;
  switches?: number;
  bandwidthKbps?: number | null;
}

/** A run of samples one second apart, described by what the player chose in each. */
function watched(plans: readonly SamplePlan[]): ViewerSample[] {
  let currentTime = 0;
  return plans.map((plan, index) => {
    currentTime += (plan.advanced ?? 1) * (INTERVAL_MS / 1000);
    return {
      atMs: START_MS + index * INTERVAL_MS,
      currentTime,
      paused: false,
      readyState: 4,
      playbackRate: 1,
      bufferAheadS: 6,
      decodedFrames: null,
      liveLatencyS: 5,
      liveTargetLatencyS: 6,
      bufferStalls: 0,
      rebufferCount: 0,
      rebufferMs: 0,
      fatalErrors: 0,
      droppedFrames: 0,
      resolution: plan.resolution === undefined ? (plan.rung === null ? null : `x${plan.rung}`) : plan.resolution,
      selectedRungHeight: plan.rung,
      qualitySwitches: plan.switches ?? 0,
      abrEnabled: plan.abrEnabled ?? true,
      bandwidthEstimateKbps: plan.bandwidthKbps ?? 4000,
      ladderHeights: [1080, 720, 480, 360],
      feedState: 'live',
      feedStateMessage: null,
    } as ViewerSample;
  });
}

/** Ten samples at 1080p, ten squeezed down to 360p, ten back at 1080p. The shape V2 asserts. */
const STEPPED_DOWN_AND_BACK = watched([
  ...Array.from({ length: 10 }, () => ({ rung: 1080 })),
  ...Array.from({ length: 10 }, () => ({ rung: 360, bandwidthKbps: 900 })),
  ...Array.from({ length: 10 }, () => ({ rung: 1080 })),
]);

describe('what the player did when the connection was squeezed', () => {
  it('sees a step down and a climb back', () => {
    const verdict = judgeQualitySwitch(STEPPED_DOWN_AND_BACK, WINDOW);

    assert.equal(verdict.before.endedOnRungHeight, 1080);
    assert.equal(verdict.during.lowestRungHeight, 360);
    assert.equal(verdict.after.tallestRungHeight, 1080);
    assert.equal(verdict.steppedDownAfterMs, 0, 'the first squeezed sample was already lower');
    assert.equal(verdict.climbedBackAfterMs, 0);
  });

  /**
   * ⛔ The one that decides whether the throttle can be credited with anything. The client starts at
   * the top rung deliberately and may settle downwards on its own, so a baseline read as the TALLEST
   * rung of the whole pre-throttle stretch would charge the squeeze with a descent that had already
   * happened.
   */
  it('measures the step against where the player was when the cap landed, not its best moment', () => {
    const settledEarly = watched([
      { rung: 1080 },
      ...Array.from({ length: 9 }, () => ({ rung: 480 })),
      ...Array.from({ length: 10 }, () => ({ rung: 480 })),
      ...Array.from({ length: 10 }, () => ({ rung: 480 })),
    ]);

    const verdict = judgeQualitySwitch(settledEarly, WINDOW);

    assert.equal(verdict.before.endedOnRungHeight, 480, 'the player was on 480p when the cap landed');
    assert.equal(verdict.steppedDownAfterMs, null, 'and it never went below that, so nothing stepped down');
  });

  /** A player that rode the same rung through the squeeze never stepped, and this must say so. */
  it('says nothing stepped down when the rung never moved', () => {
    const stubborn = watched(Array.from({ length: 30 }, () => ({ rung: 1080 })));

    assert.equal(judgeQualitySwitch(stubborn, WINDOW).steppedDownAfterMs, null);
  });

  /** The climb is measured from where the throttle LEFT the player, not from the original baseline. */
  it('says nothing climbed back when the player stayed on the rung the squeeze pushed it to', () => {
    const stuckLow = watched([
      ...Array.from({ length: 10 }, () => ({ rung: 1080 })),
      ...Array.from({ length: 20 }, () => ({ rung: 360 })),
    ]);

    const verdict = judgeQualitySwitch(stuckLow, WINDOW);

    assert.ok(verdict.steppedDownAfterMs !== null, 'it did come down');
    assert.equal(verdict.climbedBackAfterMs, null, 'and it never went back up');
  });

  it('reports how long after the cap the player came down', () => {
    const slowToReact = watched([
      ...Array.from({ length: 10 }, () => ({ rung: 1080 })),
      ...Array.from({ length: 4 }, () => ({ rung: 1080 })),
      ...Array.from({ length: 16 }, () => ({ rung: 360 })),
    ]);

    assert.equal(judgeQualitySwitch(slowToReact, WINDOW).steppedDownAfterMs, 4 * INTERVAL_MS);
  });
});

describe('whether a squeezed run is evidence about ABR at all', () => {
  /**
   * ⛔ Before every other reading. A pinned player rides one rung by instruction, so its not stepping
   * down says nothing about the ladder, and a step it did make was not ABR making it.
   */
  it('refuses to call a run ABR when any sample had the level pinned', () => {
    const pinnedLate = watched([
      ...Array.from({ length: 20 }, () => ({ rung: 1080 })),
      ...Array.from({ length: 10 }, () => ({ rung: 1080, abrEnabled: false })),
    ]);

    assert.equal(judgeQualitySwitch(pinnedLate, WINDOW).abrEnabledThroughout, false);
    assert.equal(judgeQualitySwitch(STEPPED_DOWN_AND_BACK, WINDOW).abrEnabledThroughout, true);
  });

  /** An empty run is not a run that behaved well. Nothing was sampled, so nothing is established. */
  it('does not call a run with no samples an ABR run', () => {
    assert.equal(judgeQualitySwitch([], WINDOW).abrEnabledThroughout, false);
  });
});

describe('the picture, across the squeeze', () => {
  /**
   * ⭐ The other half of V2. Stepping down is only correct if it BOUGHT something, and what it buys
   * is the picture continuing to move on a link that could not carry the rung it was on.
   */
  it('measures the advance of the squeezed stretch alone', () => {
    const frozenWhileSqueezed = watched([
      ...Array.from({ length: 10 }, () => ({ rung: 1080 })),
      ...Array.from({ length: 10 }, () => ({ rung: 360, advanced: 0 })),
      ...Array.from({ length: 10 }, () => ({ rung: 1080 })),
    ]);

    const verdict = judgeQualitySwitch(frozenWhileSqueezed, WINDOW);

    assert.equal(verdict.during.advance.ratio, 0, 'the picture did not move while the link was capped');
    assert.equal(verdict.before.advance.ratio, 1, 'and the baseline is untouched by it');
    assert.equal(verdict.after.advance.ratio, 1);
  });

  /** Two rungs can share a height, so the resolutions the decoder produced are carried separately. */
  it('carries the resolutions the decoder actually produced, once each, in the order they appeared', () => {
    const verdict = judgeQualitySwitch(STEPPED_DOWN_AND_BACK, WINDOW);

    assert.deepEqual(verdict.before.resolutions, ['x1080']);
    assert.deepEqual(verdict.during.resolutions, ['x360']);
  });
});

describe("hls.js's own switch counter", () => {
  /**
   * ⛔ A delta, never the final value. The counter is cumulative over the session, so a run that
   * opened mid-session would report every switch made before this arm as one of its own.
   */
  it('is the change across the run rather than the number it ended on', () => {
    const alreadySwitching = watched([
      ...Array.from({ length: 10 }, () => ({ rung: 1080, switches: 7 })),
      ...Array.from({ length: 20 }, () => ({ rung: 360, switches: 9 })),
    ]);

    assert.equal(judgeQualitySwitch(alreadySwitching, WINDOW).switchesCounted, 2);
  });
});
