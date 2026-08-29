import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { type QualitySwitchVerdict } from '../src/browser/qualitySwitch.js';
import { parseBrowserArmState } from '../src/harness/browser.js';
import {
  climbedBackRefusal,
  keptPlayingRefusal,
  qualityArmRefusal,
  qualityArmSummary,
  SQUEEZE_RECOVER_SECONDS,
  SQUEEZE_SECONDS,
  SQUEEZE_SETTLE_SECONDS,
  squeezeArmMinutes,
  steppedDownRefusal,
  throttleRefusal,
} from '../src/harness/qualityArm.js';

import { armState, qualityArmState, STEPPED_DOWN_AND_BACK } from './helpers/browserArmFixtures.js';

/**
 * The questions a squeezed viewer's run is asked.
 *
 * `suites/viewer/quality-switch.test.ts` costs a broadcast and nothing under `suites/` runs in CI, so
 * every rule it judges on is covered here: a rule written inline in a suite is a rule nothing checks
 * until a paid broadcast is already burning.
 */

const E2E_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CLEAN_ARM = { maxSegmentRequests: 9 };

describe('how much wall clock one squeeze arm gets', () => {
  it("outlasts the driver's own windows", () => {
    const windows = SQUEEZE_SETTLE_SECONDS + SQUEEZE_SECONDS + SQUEEZE_RECOVER_SECONDS;

    assert.ok(squeezeArmMinutes() * 60 > windows, `${windows}s of driver timeline has to fit inside`);
  });

  /**
   * ⛔ Mirrored constants, so this is a grep rather than a promise. `browser/quality.ts` runs its own
   * `main()` on import and cannot be read from a suite, so its three window defaults are restated in
   * the harness. A default moved there and not here would size every arm against a timeline the
   * driver no longer has, and the arm would be killed partway through the window it exists to watch.
   */
  it('mirrors the window defaults the quality driver actually declares', () => {
    const driver = readFileSync(join(E2E_DIR, 'browser', 'quality.ts'), 'utf8');
    const declared = (name: string): number => {
      const match = new RegExp(`const ${name} = (\\d+);`).exec(driver);
      assert.ok(match, `browser/quality.ts no longer declares ${name}`);
      return Number(match[1]);
    };

    assert.equal(SQUEEZE_SETTLE_SECONDS, declared('DEFAULT_SETTLE_SECONDS'));
    assert.equal(SQUEEZE_SECONDS, declared('DEFAULT_SQUEEZE_SECONDS'));
    assert.equal(SQUEEZE_RECOVER_SECONDS, declared('DEFAULT_RECOVER_SECONDS'));
  });
});
const SQUEEZED = parseBrowserArmState(qualityArmState()).quality as QualitySwitchVerdict;
const wentThrough = (overrides: Partial<QualitySwitchVerdict>): QualitySwitchVerdict => ({ ...SQUEEZED, ...overrides });

describe('whether a run is a viewer whose connection was squeezed', () => {
  it('passes an in-tab arm that watched, was capped and reported what its player chose', () => {
    assert.equal(qualityArmRefusal(parseBrowserArmState(qualityArmState()), CLEAN_ARM), null);
  });

  /**
   * ⛔ The one that matters most here. A plain watch produces a full report with every playback figure
   * in it, and a suite that read one as a quality-switch run would certify the ladder off a viewer
   * whose connection was never touched.
   */
  it('refuses a plain watch, whose player had no reason to switch anything', () => {
    const refusal = qualityArmRefusal(parseBrowserArmState(armState()), CLEAN_ARM);

    assert.match(String(refusal), /never made worse/);
  });

  /** Before any figure is read. A throttled or hidden page produces numbers about the harness. */
  it('refuses a run whose browser was not a usable instrument', () => {
    const degraded = parseBrowserArmState(
      qualityArmState({ instrument: { sound: false, failures: ['timer drift 61x the interval'] } }),
    );

    assert.match(String(qualityArmRefusal(degraded, CLEAN_ARM)), /timer drift 61x the interval/);
  });

  it('refuses a run that decoded nothing, since there was no quality to switch', () => {
    const blank = parseBrowserArmState(qualityArmState({ resolutions: [] }));

    assert.match(String(qualityArmRefusal(blank, CLEAN_ARM)), /nothing was decoded/);
  });

  it('refuses a run whose picture never moved at all', () => {
    const frozen = parseBrowserArmState(qualityArmState({ overallAdvanceRatio: 0 }));

    assert.match(String(qualityArmRefusal(frozen, CLEAN_ARM)), /never moved forward/);
  });

  /** The byte source is the condition the reading is filed under, exactly as it is on a crash arm. */
  it('refuses an arm whose byte source is not the one it asked for', () => {
    const mismatched = parseBrowserArmState(
      qualityArmState({ byteSource: { requested: 'weeb3', reported: 'gateway', settledForMs: 60_000 } }),
    );

    assert.match(String(qualityArmRefusal(mismatched, CLEAN_ARM)), /the switch did not take/);
  });
});

describe('whether a squeezed run is evidence about the ladder', () => {
  it('accepts a run whose player measured the cap', () => {
    assert.equal(throttleRefusal(SQUEEZED), null);
  });

  /**
   * ⛔ The instrument question this whole file exists around. Chromium applies network emulation
   * itself and an in-tab node carries segment bytes over its own peer connections, so a cap that did
   * not reach them must be refused as a harness failure rather than reported as a ladder that does
   * not adapt.
   */
  it('refuses a run whose player still measured more than the cap it was under', () => {
    const unreached = wentThrough({
      during: { ...SQUEEZED.during, bandwidthEstimateKbps: 5_900 },
    });

    assert.match(String(throttleRefusal(unreached)), /did not reach whatever carried the segment bytes/);
  });

  it('refuses a run whose player reported no estimate while capped', () => {
    const silent = wentThrough({ during: { ...SQUEEZED.during, bandwidthEstimateKbps: null } });

    assert.match(String(throttleRefusal(silent)), /no bandwidth estimate/);
  });

  /** A pinned player rides one rung by instruction, so neither answer it gives is about ABR. */
  it('refuses a run whose level was pinned', () => {
    assert.match(String(throttleRefusal(wentThrough({ abrEnabledThroughout: false }))), /pinned/);
  });
});

describe('whether the viewer stepped down when their link could not carry their rung', () => {
  it('accepts a player that came below where the cap found it', () => {
    assert.equal(steppedDownRefusal(SQUEEZED), null);
  });

  /** ⭐ The case the plan names as done-when: a client that ignores bandwidth and rides one rung. */
  it('refuses a player that rode its rung straight through the squeeze', () => {
    const stubborn = wentThrough({ steppedDownAfterMs: null, during: { ...SQUEEZED.during, lowestRungHeight: 1080 } });

    assert.match(String(steppedDownRefusal(stubborn)), /never came below it/);
  });

  it('refuses a run where the player had chosen no rung when the cap landed', () => {
    const unstarted = wentThrough({ before: { ...SQUEEZED.before, endedOnRungHeight: null } });

    assert.match(String(steppedDownRefusal(unstarted)), /nothing for it to have stepped down from/);
  });
});

describe('whether stepping down bought the viewer anything', () => {
  it('accepts a picture that kept moving while capped', () => {
    assert.equal(keptPlayingRefusal(SQUEEZED), null);
  });

  /**
   * ⭐ The half that makes a step down worth having. A player that adapted its way into a stall has
   * arrived back where it started, and every other reading in the run would still look like a success.
   */
  it('refuses a player that stepped down into a frozen picture', () => {
    const stalled = wentThrough({ during: { ...SQUEEZED.during, advance: { ratio: 0, wallMs: 60_000, samples: 60 } } });

    assert.match(String(keptPlayingRefusal(stalled)), /frozen frame/);
  });
});

describe('whether the viewer got their quality back', () => {
  it('accepts a player that climbed once the cap came off', () => {
    assert.equal(climbedBackRefusal(SQUEEZED), null);
  });

  it('refuses a player left on the rung the squeeze pushed it to', () => {
    assert.match(String(climbedBackRefusal(wentThrough({ climbedBackAfterMs: null }))), /only ever goes down/);
  });
});

describe('the line an operator reads while a squeeze arm runs', () => {
  it('names the rung before, under and after the cap', () => {
    const line = qualityArmSummary(parseBrowserArmState(qualityArmState()));

    assert.match(line, /1080p before/);
    assert.match(line, /360p under it/);
    assert.match(line, /1080p after/);
  });

  it('has something to say about an arm that drove no squeeze, rather than throwing at the printer', () => {
    assert.match(qualityArmSummary(parseBrowserArmState(armState())), /no squeeze/);
  });
});

describe('the verdict as the artifact carries it', () => {
  /** ⛔ Read whole rather than trusted. A half-stated verdict is what the reader is supposed to refuse. */
  it('refuses an artifact whose quality section is missing a phase', () => {
    const halfStated = { ...STEPPED_DOWN_AND_BACK };
    delete (halfStated as Record<string, unknown>).during;

    assert.throws(() => parseBrowserArmState(qualityArmState({ quality: halfStated })), /run\.quality\.during/);
  });
});
