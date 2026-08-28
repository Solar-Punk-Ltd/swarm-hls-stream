import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FAULT_SCENARIOS, type FaultScenario, scenarioByName } from '../src/browser/faults.js';
import { FEED_STATE_ENDED, FEED_STATE_RECONNECTING, FEED_STATE_STALLED } from '../src/browser/feedState.js';
import { GATEWAY_BYTES, WEEB3_BYTES } from '../src/browser/fetchBackendSweep.js';
import { type BrowserArmResult, type CrashRecoveryResult, parseBrowserArmState } from '../src/harness/browser.js';
import {
  CRASH_RECOVER_SECONDS,
  CRASH_SETTLE_SECONDS,
  crashArmMinutes,
  crashArmRefusal,
  freezeRefusal,
  frozenOverlayRefusal,
  MAX_WEEB3_SEGMENT_REQUESTS,
  resumeRefusal,
} from '../src/harness/crashArm.js';

import { armState, crashArmState, GATEWAY_OUTAGE_RECOVERY } from './helpers/browserArmFixtures.js';

/**
 * How long a crash arm needs, and the four questions a crash scenario asks of the one it got.
 *
 * The five suites under `suites/viewer/` that drive a fault cost a broadcast each and nothing under
 * `suites/` runs in CI, so every rule they judge on is covered here instead: a threshold written
 * inline in a scenario is a threshold nothing checks until a paid broadcast is already burning.
 *
 * The figures throughout are the ones `docs/bench/crash-at-an-in-tab-viewer-2026-08-27.md` recorded,
 * so a predicate is exercised against runs that happened rather than against invented ones.
 */

const GATEWAY_OUTAGE = scenarioByName('viewer-gateway-outage');
const ENGINE_RESTART = scenarioByName('engine-restart');

const E2E_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The recovery verdict of the doc's arm 1, parsed, which is the shape the predicates take. */
const RECOVERED = parseBrowserArmState(crashArmState()).recovery as CrashRecoveryResult;
const wentThrough = (overrides: Partial<CrashRecoveryResult>): CrashRecoveryResult => ({ ...RECOVERED, ...overrides });

const CLEAN_ARM = { scenario: GATEWAY_OUTAGE.name, maxSegmentRequests: MAX_WEEB3_SEGMENT_REQUESTS };

describe('how much wall clock one crash arm gets', () => {
  /**
   * ⭐ Derived from the fault rather than chosen per suite. Five copies of this arithmetic would
   * drift, and a suite that guessed short would kill a paid broadcast partway through the recovery
   * it exists to measure.
   */
  it('gives every fault in the matrix an arm between three and six minutes', () => {
    for (const scenario of FAULT_SCENARIOS) {
      const minutes = crashArmMinutes(scenario);

      assert.ok(minutes >= 3 && minutes <= 6, `${scenario.name} would run for ${minutes} minutes`);
    }
  });

  it("outlasts the driver's own windows, for the longest fault in the matrix", () => {
    const windows = 60 + CRASH_SETTLE_SECONDS + ENGINE_RESTART.downMs / 1000 + CRASH_RECOVER_SECONDS;

    assert.ok(crashArmMinutes(ENGINE_RESTART) * 60 > windows, `${windows}s of driver timeline has to fit inside`);
  });

  /**
   * ⛔ The ceiling is what an operator pays for: one broadcast per arm, and five arms in a sitting.
   * There is no floor to check, because the shortest arm these windows can produce is already over
   * the three minutes the crash matrix was sized against.
   */
  it('refuses a fault that would need more broadcast than an arm may buy', () => {
    const marathon: FaultScenario = { ...GATEWAY_OUTAGE, name: 'ten-minute-outage', downMs: 600_000 };

    assert.throws(() => crashArmMinutes(marathon), /ten-minute-outage/);
  });

  /**
   * ⛔ Mirrored constants, so this is a grep rather than a promise. `browser/crash.ts` runs its own
   * `main()` on import and cannot be read from a suite, so its two window defaults are restated in
   * the harness. A default moved there and not here would silently size every arm against a timeline
   * the driver no longer has.
   */
  it('mirrors the window defaults the crash driver actually declares', () => {
    const driver = readFileSync(join(E2E_DIR, 'browser', 'crash.ts'), 'utf8');
    const declared = (name: string): number => {
      const match = new RegExp(`const ${name} = (\\d+);`).exec(driver);
      assert.ok(match, `browser/crash.ts no longer declares ${name}`);
      return Number(match[1]);
    };

    assert.equal(CRASH_SETTLE_SECONDS, declared('DEFAULT_SETTLE_SECONDS'));
    assert.equal(CRASH_RECOVER_SECONDS, declared('DEFAULT_RECOVER_SECONDS'));
  });
});

describe('whether a crash arm is a viewer who was watching when the fault landed', () => {
  it('passes an in-tab arm that watched, broke and reported the fault it was asked for', () => {
    assert.equal(crashArmRefusal(parseBrowserArmState(crashArmState()), CLEAN_ARM), null);
  });

  /**
   * ⛔ First, and before any figure is read. A hidden or throttled page stops advancing playback on
   * its own, which is indistinguishable from the freeze every one of these scenarios is measuring.
   */
  it('refuses a run whose browser was not a usable instrument, whatever its freeze says', () => {
    const degraded = parseBrowserArmState(
      crashArmState({ instrument: { sound: false, failures: ['timer drift 61x the interval'] } }),
    );

    assert.match(String(crashArmRefusal(degraded, CLEAN_ARM)), /timer drift 61x the interval/);
  });

  /**
   * ⛔ A watch artifact reaching a crash suite. Every figure in it is a healthy broadcast's, so the
   * scenario would report that its fault cost the viewer nothing.
   */
  it('refuses an artifact from a run that broke nothing at all', () => {
    assert.match(String(crashArmRefusal(parseBrowserArmState(armState()), CLEAN_ARM)), /no fault/);
  });

  it('refuses an artifact from a different fault than the one this scenario asked for', () => {
    const wrongFault = parseBrowserArmState(crashArmState({ scenario: 'uploader-crash' }));

    assert.match(String(crashArmRefusal(wrongFault, CLEAN_ARM)), /uploader-crash/);
  });

  it('refuses a run that decoded nothing, whose silence looks exactly like an unaffected viewer', () => {
    const blind = parseBrowserArmState(crashArmState({ resolutions: [] }));

    assert.match(String(crashArmRefusal(blind, CLEAN_ARM)), /resolution/);
  });

  it('refuses an arm whose byte-source switch did not take, since both conditions would then be one', () => {
    const landedElsewhere = parseBrowserArmState(
      crashArmState({ byteSource: { requested: WEEB3_BYTES, reported: GATEWAY_BYTES, settledForMs: 60_000 } }),
    );

    assert.match(String(crashArmRefusal(landedElsewhere, CLEAN_ARM)), new RegExp(GATEWAY_BYTES));
  });

  /**
   * ⭐ The matrix's in-tab arms each made 8 or 9 segment requests over HTTP for a whole run, against
   * the control's 366. The readback above says what the client believes and this is what the network
   * did, and on 2026-08-13 those disagreed while both arms fetched everything from one node.
   */
  it('refuses an in-tab arm that went on reading its segments from the gateway', () => {
    const notInTab = parseBrowserArmState(crashArmState({ segmentRequests: 366 }));

    assert.match(String(crashArmRefusal(notInTab, CLEAN_ARM)), /366/);
  });

  it('passes a gateway arm, which is the control and claims nothing about a node in the tab', () => {
    const control = parseBrowserArmState(crashArmState({ backend: GATEWAY_BYTES, segmentRequests: 366 }));

    assert.equal(crashArmRefusal(control, CLEAN_ARM), null);
  });
});

describe('whether the picture stopped the way this fault stops it', () => {
  const GATEWAY_FREEZE = { minFreezeMs: 10_000, maxFreezeMs: 60_000, minBufferMs: 3_000 };

  it('passes a freeze inside the window the matrix records', () => {
    assert.equal(freezeRefusal(RECOVERED, GATEWAY_FREEZE), null);
  });

  /**
   * ⛔ The floor is not pedantry. A scenario whose fault never reached the viewer passes every other
   * check here, and the run then reports that the product survives an outage it never had.
   */
  it('refuses a fault that never reached the viewer at all', () => {
    const untouched = wentThrough({ longestFreezeMs: 0, freezeStartedAfterFaultMs: null });

    assert.match(String(freezeRefusal(untouched, GATEWAY_FREEZE)), /10/);
  });

  it('refuses a freeze past the ceiling the matrix records', () => {
    assert.match(String(freezeRefusal(wentThrough({ longestFreezeMs: 71_000 }), GATEWAY_FREEZE)), /71/);
  });

  /**
   * The fault that ends the broadcast has no ceiling to hold: the picture stops and stays stopped,
   * so the freeze is as long as whatever is left of the run rather than a property of the product.
   */
  it('holds no ceiling against a fault whose viewer is never getting a picture back', () => {
    const terminal = { minFreezeMs: 20_000, maxFreezeMs: null, minBufferMs: null };

    assert.equal(freezeRefusal(wentThrough({ longestFreezeMs: 83_200 }), terminal), null);
  });

  /**
   * ⭐ The viewer's runway. Three arms of the matrix kept the picture moving 6.0, 6.1 and 7.1s after
   * the fault landed, which is `LIVE_SYNC_DURATION_S` of buffer spending itself. A viewer who froze
   * the instant the service died had none in front of them.
   */
  it('refuses a viewer who froze with no buffer in front of the fault', () => {
    assert.match(String(freezeRefusal(wentThrough({ freezeStartedAfterFaultMs: 400 }), GATEWAY_FREEZE)), /0\.4/);
  });

  it('says nothing about the buffer where the matrix recorded no such figure', () => {
    const noBufferRecorded = { minFreezeMs: 10_000, maxFreezeMs: 60_000, minBufferMs: null };

    assert.equal(freezeRefusal(wentThrough({ freezeStartedAfterFaultMs: 400 }), noBufferRecorded), null);
  });

  /**
   * The writer-bee pause, whose recorded outcome is a freeze so short it barely happened and whose
   * written expectation is no freeze at all. A viewer who sailed through it is the better outcome of
   * the two and must not be refused for having no buffer figure to show.
   */
  it('passes a viewer the fault never stopped, where none was required to stop', () => {
    const barely = { minFreezeMs: 0, maxFreezeMs: 8_000, minBufferMs: 3_000 };
    const sailedThrough = wentThrough({ longestFreezeMs: 0, freezeStartedAfterFaultMs: null });

    assert.equal(freezeRefusal(sailedThrough, barely), null);
  });
});

describe('whether the picture came back the way this fault lets it', () => {
  const RESUMES = { expectRecovery: true, withinMs: 30_000 };

  it('passes a viewer who came back inside the window the matrix records', () => {
    assert.equal(resumeRefusal(RECOVERED, RESUMES), null);
  });

  it('refuses a viewer left on a frozen frame by a fault the product recovers from', () => {
    const stranded = wentThrough({ recovered: false, recoveredAfterLiftMs: null });

    assert.match(String(resumeRefusal(stranded, RESUMES)), /never/);
  });

  /**
   * ⭐ The figure a client change can move, and the one the uploader-crash recovery fix is judged on:
   * 2.3s here against 46.7s before that fix. A ceiling is how a regression back to it is caught.
   */
  it('refuses a viewer who came back later than the matrix records', () => {
    assert.match(String(resumeRefusal(wentThrough({ recoveredAfterLiftMs: 46_700 }), RESUMES)), /46\.7/);
  });

  /**
   * Not an anomaly: a viewer whose buffer outlasted the outage was never waiting on the service, so
   * the picture moved again before it answered.
   */
  it('passes a viewer whose buffer outlasted the outage, resuming before the service answered', () => {
    assert.equal(resumeRefusal(wentThrough({ recoveredAfterLiftMs: -1_200 }), RESUMES), null);
  });

  const ENDS = { expectRecovery: false, withinMs: null };

  it('passes the fault that ends the broadcast, whose viewer correctly never gets a picture back', () => {
    const terminal = wentThrough({ recovered: false, recoveredAfterLiftMs: null, serviceStartupMs: null });

    assert.equal(resumeRefusal(terminal, ENDS), null);
  });

  /**
   * ⛔ A resume here is not good news. The engine restart takes the publisher's connection with it, so
   * a picture that moves again is a viewer who was handed a different broadcast, or a fault that
   * never landed.
   */
  it('refuses a viewer who resumed a broadcast that had ended', () => {
    assert.match(String(resumeRefusal(RECOVERED, ENDS)), /ended/);
  });
});

describe('what the client told the viewer while the picture was stopped', () => {
  it('passes an overlay that said what the matrix records it says', () => {
    assert.equal(frozenOverlayRefusal(RECOVERED, { told: [FEED_STATE_RECONNECTING] }), null);
  });

  it('refuses a frozen frame that explained nothing, where the matrix records a message', () => {
    const silent = wentThrough({ saidWhileFrozen: [], explainedTheFreeze: false });

    assert.match(String(frozenOverlayRefusal(silent, { told: [FEED_STATE_RECONNECTING] })), /nothing/);
  });

  /**
   * ⛔ The recorded gap, issue #100: the uploader-crash and writer-bee-outage arms froze for 13.5 and
   * 29.5 seconds under an overlay that said nothing at all. Asserting the silence is what makes the
   * fix visible when it lands, rather than asserting a message the deployment does not have.
   */
  it('passes the silence the matrix records, which is the current contract and not the wanted one', () => {
    const silent = wentThrough({ saidWhileFrozen: [], explainedTheFreeze: false });

    assert.equal(frozenOverlayRefusal(silent, { told: [] }), null);
  });

  it('refuses a run where the silence ended, so the gap closing is what turns the case red', () => {
    assert.match(String(frozenOverlayRefusal(RECOVERED, { told: [] })), new RegExp(FEED_STATE_RECONNECTING));
  });

  /**
   * ⭐ Judged as states rather than as prose. The overlay's wording is a product decision, so a copy
   * edit must not turn a green scenario red while a genuinely broken terminal state stays green for
   * as long as the words survive.
   */
  it('refuses a message the client is no longer known to render, rather than reading it as silence', () => {
    const reworded = wentThrough({ saidWhileFrozen: ['Hang tight, we are on it'] });

    assert.throws(() => frozenOverlayRefusal(reworded, { told: [] }), /Hang tight/);
  });

  /**
   * The engine restart's recorded escalation. The route through the states is printed by the suite
   * and not asserted here: what the matrix records is that the viewer reached both, and an extra
   * state on the way is the client saying more rather than less.
   */
  it('passes a viewer told everything the matrix records, in whatever order they met it', () => {
    const ended = wentThrough({
      saidWhileFrozen: ['Waiting for the broadcast to continue', 'This broadcast has ended'],
    });

    assert.equal(frozenOverlayRefusal(ended, { told: [FEED_STATE_ENDED, FEED_STATE_STALLED] }), null);
  });

  it('refuses a viewer told only half of what the matrix records', () => {
    const stalledOnly = wentThrough({ saidWhileFrozen: ['Waiting for the broadcast to continue'] });
    const refusal = frozenOverlayRefusal(stalledOnly, { told: [FEED_STATE_STALLED, FEED_STATE_ENDED] });

    assert.match(String(refusal), new RegExp(FEED_STATE_ENDED));
  });
});

/** Kept honest about what it is handed: these are the results the suites will pass in. */
describe('the shapes the predicates take', () => {
  it('reads a parsed arm result, so a suite never restates the artifact', () => {
    const result: BrowserArmResult = parseBrowserArmState(crashArmState());

    assert.equal(result.recovery?.scenario, GATEWAY_OUTAGE.name);
    assert.deepEqual(result.recovery?.saidWhileFrozen, GATEWAY_OUTAGE_RECOVERY.saidWhileFrozen);
  });
});
