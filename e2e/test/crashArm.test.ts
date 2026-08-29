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
  crashArmSummary,
  frozenOverlayRefusal,
  MAX_WEEB3_SEGMENT_REQUESTS,
  resumeRefusal,
} from '../src/harness/crashArm.js';

import { armState, crashArmState, GATEWAY_OUTAGE_RECOVERY } from './helpers/browserArmFixtures.js';

/**
 * How long a crash arm needs, and the questions a crash scenario asks of the one it got.
 *
 * The five suites under `suites/viewer/` that drive a fault cost a broadcast each and nothing under
 * `suites/` runs in CI, so every rule they judge on is covered here instead: a rule written inline in
 * a scenario is a rule nothing checks until a paid broadcast is already burning.
 *
 * The figures throughout are the ones `docs/bench/crash-at-an-in-tab-viewer-2026-08-27.md` recorded,
 * so a predicate is exercised against runs that happened rather than against invented ones. ⭐ They
 * are the INPUTS here and never the contract: owner ruling of 2026-08-29, an e2e suite checks that
 * the feature works properly and stably, and every duration one of these arms produces is measured,
 * printed and filed rather than held against a ceiling.
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

  /**
   * ⛔ The correctness question the freeze ceilings used to stand in for. A viewer who decoded a
   * first frame and then sat on it for the whole arm reports a resolution and no error, so every
   * other check here passes, and the fault would be credited with a picture that never existed.
   */
  it('refuses an arm whose picture never moved forward at all', () => {
    const frozenThroughout = parseBrowserArmState(crashArmState({ overallAdvanceRatio: 0 }));

    assert.match(String(crashArmRefusal(frozenThroughout, CLEAN_ARM)), /never moved/);
  });

  /**
   * ⭐ Owner ruling of 2026-08-29: an e2e suite checks feature correctness and stability, and how
   * long a fault cost a viewer is a performance reading. Live on the four rung ladder that day, three
   * faults froze the picture for 57 to 59 seconds against ceilings of 8 and 45 taken from a
   * single-rendition 720p sitting, and all three suites went red for a configuration difference.
   */
  it('passes an arm that froze for a minute, since a duration is measured here and never judged', () => {
    const slow = parseBrowserArmState(
      crashArmState({ recovery: { ...GATEWAY_OUTAGE_RECOVERY, longestFreezeMs: 59_000 } }),
    );

    assert.equal(crashArmRefusal(slow, CLEAN_ARM), null);
  });

  /**
   * ⭐ The other half of the same ruling, and the sharper half. V10 was refused live for freezing
   * 16.3s against a FLOOR of 20s: it failed for costing the viewer less than the matrix recorded.
   */
  it('passes an arm the fault barely touched, which no longer reads as a fault that never landed', () => {
    const barelyTouched = parseBrowserArmState(
      crashArmState({
        recovery: { ...GATEWAY_OUTAGE_RECOVERY, longestFreezeMs: 0, freezeStartedAfterFaultMs: null },
      }),
    );

    assert.equal(crashArmRefusal(barelyTouched, CLEAN_ARM), null);
  });
});

describe('whether the picture came back the way this fault lets it', () => {
  const RESUMES = { expectRecovery: true };

  it('passes a viewer whose picture was moving again by the end of the run', () => {
    assert.equal(resumeRefusal(RECOVERED, RESUMES), null);
  });

  it('refuses a viewer left on a frozen frame by a fault the product recovers from', () => {
    const stranded = wentThrough({ recovered: false, recoveredAfterLiftMs: null });

    assert.match(String(resumeRefusal(stranded, RESUMES)), /never/);
  });

  /**
   * ⭐ Owner ruling of 2026-08-29. The uploader-crash fix is still worth watching, at 2.3s against
   * 46.7s before it landed, and this is where a regression is NOTICED rather than refused: the figure
   * is printed by {@link crashArmSummary} on every arm and filed in the artifact. The contract is
   * that the picture came back, and a slower return is still a viewer who got their broadcast.
   */
  it('passes a viewer who came back slowly, since a recovery time is measured here and never judged', () => {
    assert.equal(resumeRefusal(wentThrough({ recoveredAfterLiftMs: 46_700 }), RESUMES), null);
  });

  /**
   * Not an anomaly: a viewer whose buffer outlasted the outage was never waiting on the service, so
   * the picture moved again before it answered.
   */
  it('passes a viewer whose buffer outlasted the outage, resuming before the service answered', () => {
    assert.equal(resumeRefusal(wentThrough({ recoveredAfterLiftMs: -1_200 }), RESUMES), null);
  });

  /**
   * ⛔ The writer-bee pause, whose written expectation is that a viewer notices nothing at all. Such a
   * viewer records no resume because there was no freeze to come back from, and reading that absence
   * as a missing recovery would fail the product for behaving better than the matrix measured.
   */
  it('passes a viewer the fault never stopped, who had nothing to resume from', () => {
    const sailedThrough = wentThrough({
      longestFreezeMs: 0,
      freezeStartedAfterFaultMs: null,
      recoveredAfterLiftMs: null,
    });

    assert.equal(resumeRefusal(sailedThrough, RESUMES), null);
  });

  /**
   * ⭐ The picture is moving again, and only the stopwatch is missing. Nothing is timed here any
   * more, so an unrecorded moment is a gap in the report rather than a viewer who was let down.
   */
  it('passes a picture that stopped and is moving again with no record of when it started', () => {
    assert.equal(resumeRefusal(wentThrough({ recoveredAfterLiftMs: null }), RESUMES), null);
  });

  const ENDS = { expectRecovery: false };

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

/**
 * ⭐ One shape across all five arms. A scenario run prints nothing else for minutes, and arms whose
 * summaries are worded differently cannot be read side by side, which is how the matrix is read.
 */
describe('the line an operator reads while an arm runs', () => {
  it('carries the freeze, the buffer, the resume and the arm proof, in one line', () => {
    const line = crashArmSummary(parseBrowserArmState(crashArmState()));

    assert.match(line, /viewer-gateway-outage on weeb3/);
    assert.match(line, /froze 28\.6s/);
    assert.match(line, /6\.0s after the fault/);
    assert.match(line, /10\.7s after the service answered/);
    assert.match(line, /7\.2s of that/);
    assert.match(line, /6 segment requests/);
    assert.match(line, /"Reconnecting to the stream"/);
  });

  it('says a viewer never got their picture back, rather than printing a null at them', () => {
    const stranded = parseBrowserArmState(
      crashArmState({ recovery: { ...GATEWAY_OUTAGE_RECOVERY, recovered: false, recoveredAfterLiftMs: null } }),
    );

    assert.match(crashArmSummary(stranded), /never moved again/);
  });

  it('says NOTHING in as many letters, since an empty list of messages reads as no list at all', () => {
    const silent = parseBrowserArmState(
      crashArmState({ recovery: { ...GATEWAY_OUTAGE_RECOVERY, saidWhileFrozen: [], explainedTheFreeze: false } }),
    );

    assert.match(crashArmSummary(silent), /said NOTHING/);
  });

  it('has something to say about a watch that drove no fault, rather than throwing at the printer', () => {
    assert.match(crashArmSummary(parseBrowserArmState(armState())), /no fault/);
  });
});
