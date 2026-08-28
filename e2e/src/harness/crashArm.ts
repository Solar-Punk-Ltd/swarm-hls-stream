/**
 * How long a crash arm needs, and the four questions a crash scenario asks of the one it got.
 *
 * ## What a crash arm is
 *
 * One broadcast, one fault, one viewer. `browser:crash` opens a real player, watches it settle,
 * breaks a container of the deployment from inside the same process, and keeps sampling while the
 * service comes back. Five faults are declared in `browser/faults.ts` and all five were measured
 * against a real viewer on 2026-08-27, recorded in `docs/bench/crash-at-an-in-tab-viewer-2026-08-27.md`.
 * The suites under `suites/viewer/` promote that sitting into pass/fail, and this is what they judge on.
 *
 * ## Why the rules live here rather than in the suites
 *
 * Nothing under `suites/` runs in CI and each of those files costs a broadcast, so a threshold
 * written inline in a scenario is a threshold nothing checks until a paid broadcast is already
 * burning. Reached from `test/crashArm.test.ts`, these are covered by the unit run and the suites
 * are left with the numbers the matrix recorded and the wiring.
 *
 * ⭐ Every predicate returns the reason a run is not what the matrix records, or null. That is the
 * idiom `viewerPlaybackRefusal` and `weeb3ArmRefusal` already use, for the same reason: a boolean
 * would let a suite print "assertion failed" where the harness could have said which of six things
 * went wrong, on a run that cost minutes of broadcast to produce.
 */

import { DEFAULT_BYTE_SOURCE_SETTLE_SECONDS } from '../browser/byteSourceArm.js';
import { type FaultScenario } from '../browser/faults.js';
import { FEED_STATE_LIVE, readFeedState, type ViewerFeedState } from '../browser/feedState.js';
import { WEEB3_BYTES } from '../browser/fetchBackendSweep.js';

import { type BrowserArmResult, type CrashRecoveryResult } from './browser.js';
import { weeb3ArmRefusal } from './browserVerdict.js';

/**
 * The baseline `browser/crash.ts` holds before it breaks anything.
 *
 * ⛔ Mirrored rather than imported, because that module runs its own `main()` on import and a suite
 * that pulled it in would launch a browser. `test/crashArm.test.ts` greps the driver and fails if
 * the two drift, which is the only thing that makes a mirror safe.
 */
export const CRASH_SETTLE_SECONDS = 45;

/** How long the driver keeps watching after the service is put back, where recovery is measured. */
export const CRASH_RECOVER_SECONDS = 60;

/**
 * What an arm spends between the outage ending and the recovery watch starting.
 *
 * `docker start` returns when the container exists rather than when the process inside it works,
 * which is seconds. The readiness poll that takes longer runs beside the recovery watch rather than
 * before it, so it is not in this. Thirty seconds is generous against the blocking half.
 */
const RESTORE_ALLOWANCE_S = 30;

/**
 * The longest arm a scenario may buy.
 *
 * One broadcast per fault, paid by the minute, and a sitting is five of them. The 2026-08-27 sitting
 * ran seven minute broadcasts per arm and cost 0.319 BZZ over six, so this is the knob that decides
 * what the promoted suites cost every time they run.
 */
const MAX_ARM_MINUTES = 6;

/**
 * The most `/bytes/` requests an in-tab crash arm may make across a whole run.
 *
 * Every weeb-3 arm of the matrix made 8 or 9, against the gateway control's 366 in the same sitting.
 * An arm reads through the gateway while its own node boots, so the honest figure is a handful rather
 * than a zero, and single digits is the boundary between "the node served the video" and "the gateway
 * did".
 */
export const MAX_WEEB3_SEGMENT_REQUESTS = 9;

/**
 * How much wall clock one crash arm gets, derived from the fault rather than chosen per suite.
 *
 * ⛔ It must outlast the driver's whole timeline: the in-tab node's settle before the measurement
 * opens, the pre-fault baseline, the scenario's own outage, putting the service back and the
 * recovery watch. Everything outside that, the container start, the client's catalog discovery and
 * the player's join, is budgeted separately by `BROWSER_ARM_OVERHEAD_MS`.
 *
 * ⭐ On a scenario arm this is a budget rather than a watch: `browser:crash` never reads
 * `BROWSER_WATCH_SECONDS` and its windows are its own, so this decides when the harness gives up on
 * an arm and nothing about how long the viewer watches.
 */
export function crashArmMinutes(scenario: FaultScenario): number {
  const timelineS =
    DEFAULT_BYTE_SOURCE_SETTLE_SECONDS +
    CRASH_SETTLE_SECONDS +
    scenario.downMs / 1_000 +
    RESTORE_ALLOWANCE_S +
    CRASH_RECOVER_SECONDS;
  const minutes = Math.ceil(timelineS / 60);

  if (minutes > MAX_ARM_MINUTES) {
    throw new Error(
      `'${scenario.name}' would need ${minutes} minutes of broadcast against a ceiling of ${MAX_ARM_MINUTES}. ` +
        'An arm is one paid broadcast, so a fault this long is a sitting to be authorised rather than a ' +
        'suite to be run.',
    );
  }
  return minutes;
}

/** The fault a scenario drove, and the ceiling its in-tab arm is held to. */
interface CrashArmExpectation {
  /** The scenario the suite asked for, checked against the one the artifact says it ran. */
  scenario: string;
  maxSegmentRequests: number;
}

/**
 * Why this run is not a viewer who was watching when the fault landed, or null.
 *
 * ⛔ The instrument comes first and before any figure is read. Chromium pauses muted video and
 * throttles timers on a hidden page, and a page that stopped advancing for that reason is
 * indistinguishable from the freeze every one of these scenarios exists to measure.
 *
 * ⛔ It says nothing about fatal player errors, unlike `viewerPlaybackRefusal`. That one refuses them
 * because a healthy watch must have none, and a scenario here exists to break the thing the player is
 * reading from. The matrix records no error counts for these six arms, so a threshold would be
 * invented rather than recorded, and the outcome it stands in for is measured directly: whether the
 * picture came back.
 */
export function crashArmRefusal(result: BrowserArmResult, expectation: CrashArmExpectation): string | null {
  if (!result.instrumentSound) {
    return (
      'the browser was not a usable instrument for this run, so a picture that stopped advancing is as ' +
      `likely to be the harness as the fault: ${result.instrumentFailures.join('; ') || 'no reason recorded'}`
    );
  }

  const { recovery } = result;
  if (recovery === null) {
    return (
      'this artifact carries no fault verdict, so it is a plain watch rather than a crash arm. Nothing ' +
      'was broken under this viewer, and every figure in it is a healthy broadcast being read as a ' +
      'product surviving an outage it never had'
    );
  }

  if (recovery.scenario !== expectation.scenario) {
    return (
      `this artifact is the ${recovery.scenario} run and this scenario asserts ${expectation.scenario}, so ` +
      "one fault's recorded thresholds would be applied to another fault's viewer"
    );
  }

  // ⛔ Before the arm identity below. A run that decoded nothing froze for the whole run trivially,
  // and would otherwise fail here with a message about byte sources.
  if (result.resolutions.length === 0) {
    return (
      'the player never reported a resolution, so nothing was decoded and there was no picture for the ' +
      'fault to stop'
    );
  }

  const { requested, reported } = result.proof;
  if (requested === null) {
    return 'this arm named no byte source, so its verdict would be filed against a condition nobody chose';
  }
  if (reported !== requested) {
    return (
      `this arm asked for ${requested} and the client reports ${reported}, so the switch did not take and ` +
      'both conditions of the matrix would be one'
    );
  }

  return requested === WEEB3_BYTES
    ? weeb3ArmRefusal(result, { maxSegmentRequests: expectation.maxSegmentRequests })
    : null;
}

/** The freeze the matrix records for one fault, as a window rather than as the point it measured. */
interface FreezeExpectation {
  /**
   * The shortest freeze that still counts as the fault having reached the viewer.
   *
   * Zero for a fault whose recorded outcome is that a viewer barely notices, where sailing through it
   * is the better result of the two rather than a failure.
   */
  minFreezeMs: number;
  /** The longest freeze the fault may cost. Null for a fault that ends the broadcast, where the picture correctly never returns. */
  maxFreezeMs: number | null;
  /**
   * How long the picture must keep moving after the fault lands, which is the viewer's buffer
   * spending itself. Null where the matrix recorded no such figure for this fault.
   */
  minBufferMs: number | null;
}

/**
 * Why the picture did not stop the way this fault stops it, or null.
 *
 * ⚠️ `longestFreezeMs` is the longest stretch anywhere in the run rather than only after the fault,
 * so a run that stalled before the fault is judged on that stall too. That is the pessimistic
 * reading and the right one: a viewer does not care which of two freezes stopped their picture.
 */
export function freezeRefusal(
  recovery: CrashRecoveryResult,
  { minFreezeMs, maxFreezeMs, minBufferMs }: FreezeExpectation,
): string | null {
  const froze = recovery.longestFreezeMs;

  if (froze < minFreezeMs) {
    return (
      `the picture stopped for ${seconds(froze)}s against the ${seconds(minFreezeMs)}s this fault is ` +
      'recorded as costing at least, so either the fault never reached this viewer or it was never applied'
    );
  }
  if (maxFreezeMs !== null && froze > maxFreezeMs) {
    return (
      `the picture stopped for ${seconds(froze)}s against a ceiling of ${seconds(maxFreezeMs)}s, so this ` +
      'viewer lost materially more of the broadcast than the crash matrix records for this fault'
    );
  }

  // Null is a picture that never stopped, which the floor above has already judged: either none was
  // required, or it refused. Reading it as a missing buffer here would fail the better outcome twice.
  const buffered = recovery.freezeStartedAfterFaultMs;
  if (minBufferMs === null || buffered === null) {
    return null;
  }
  return buffered < minBufferMs
    ? `the picture stopped ${seconds(buffered)}s after the fault landed against the ${seconds(minBufferMs)}s of ` +
        'buffer a viewer is supposed to have in front of them, so the runway the client holds was not there'
    : null;
}

/** Whether this fault lets the viewer back in, and how quickly the matrix records them coming. */
interface ResumeExpectation {
  /** False for a fault that genuinely ends the broadcast, where a picture that never moves again is correct. */
  expectRecovery: boolean;
  /**
   * How long after the service ANSWERS AGAIN the picture must be moving. Null where no resume is
   * expected, since there is nothing left to time.
   */
  withinMs: number | null;
}

/**
 * Why the picture did not come back the way this fault lets it, or null.
 *
 * ⭐ Timed from the service answering rather than from `docker start` returning, which is up to seven
 * seconds earlier and belongs to the service. Charging those seconds to the client once set a
 * recovery target no client change could reach.
 */
export function resumeRefusal(
  recovery: CrashRecoveryResult,
  { expectRecovery, withinMs }: ResumeExpectation,
): string | null {
  if (!expectRecovery) {
    return recovery.recovered
      ? 'the picture started moving again after a fault that ended the broadcast this viewer was watching. ' +
          'Either they were handed a different broadcast, or the fault never landed'
      : null;
  }

  if (!recovery.recovered) {
    return (
      'the picture never moved again before the run ended, so this viewer was left on a frozen frame by a ' +
      'fault the product is recorded as recovering from'
    );
  }
  if (recovery.recoveredAfterLiftMs === null) {
    return 'the picture is moving and nothing recorded when it started again, so there is no recovery to judge';
  }
  if (withinMs !== null && recovery.recoveredAfterLiftMs > withinMs) {
    return (
      `the picture moved again ${seconds(recovery.recoveredAfterLiftMs)}s after the service answered, against ` +
      `the ${seconds(withinMs)}s ceiling the crash matrix records for this fault`
    );
  }
  return null;
}

/** What the client is recorded as telling the viewer while their picture was stopped. */
interface FrozenOverlayExpectation {
  /**
   * The states the viewer must have been shown. Empty is the silence the matrix records for the
   * faults issue #100 covers, and it is asserted exactly: anything at all then fails.
   */
  told: readonly ViewerFeedState[];
}

/**
 * Why the client did not tell the viewer what the matrix records, or null.
 *
 * ⭐ Judged as states rather than as prose. The overlay's wording is a product decision, so asserting
 * the sentence would turn a green scenario red on a copy edit while a genuinely broken terminal state
 * stayed green for as long as the words survived. ⛔ A message the client is no longer known to render
 * throws out of `readFeedState` rather than reading as silence, which is the honest answer to no
 * longer knowing what the viewer was looking at.
 *
 * ⛔ The two directions are deliberately not symmetric. A state beyond the recorded ones is the client
 * saying MORE to a stranded viewer, which is not a regression in what they get, so it passes and the
 * suite prints the route. An expectation of silence is different: the silence IS the recorded
 * contract, so anything at all fails it, and that is the assertion a fix for #100 flips.
 */
export function frozenOverlayRefusal(recovery: CrashRecoveryResult, { told }: FrozenOverlayExpectation): string | null {
  // The live state is the overlay rendering nothing, which is not the client having said something.
  const shown: ViewerFeedState[] = recovery.saidWhileFrozen
    .map((message) => readFeedState(message))
    .filter((state) => state !== FEED_STATE_LIVE);

  if (told.length === 0) {
    return shown.length === 0
      ? null
      : `the client showed ${shown.join(', ')} while the picture was stopped, and the crash matrix records ` +
          'this fault reaching a viewer in silence. This is the assertion a fix for the overlay flips, so ' +
          'the case is red because the product improved: move the expectation and file the new behaviour';
  }

  const missing = told.filter((state) => !shown.includes(state));
  if (missing.length === 0) {
    return null;
  }
  return (
    `the client never showed ${missing.join(', ')} while the picture was stopped, and showed ` +
    `${shown.join(', ') || 'nothing at all'}. A frozen frame that says why is a viewer who waits, and one ` +
    'that still claims to be live is a viewer who reloads or leaves'
  );
}

/**
 * What the fault did, in the one line an operator watching a scenario run gets to read.
 *
 * ⭐ One shape across all five arms rather than a sentence per suite. The matrix is read by putting
 * arms beside each other, and arms whose summaries are worded differently cannot be. It states facts
 * and judges nothing: a picture that never came back is the correct outcome of one of these faults
 * and a failure in the other four, and which it is belongs to the suite.
 */
export function crashArmSummary(result: BrowserArmResult): string {
  const { recovery } = result;
  if (recovery === null) {
    return 'this arm drove no fault, so there is nothing to report about one';
  }

  const buffered =
    recovery.freezeStartedAfterFaultMs === null
      ? 'and the picture never stopped'
      : `starting ${seconds(recovery.freezeStartedAfterFaultMs)}s after the fault`;
  const startup =
    recovery.serviceStartupMs === null ? '' : ` (${seconds(recovery.serviceStartupMs)}s of that was the service)`;
  const resumed = !recovery.recovered
    ? 'and never moved again'
    : recovery.recoveredAfterLiftMs === null
    ? 'and was moving by the end, with nothing recording when it started'
    : `moving again ${seconds(recovery.recoveredAfterLiftMs)}s after the service answered${startup}`;
  const said = recovery.saidWhileFrozen.length > 0 ? `"${recovery.saidWhileFrozen.join('", "')}"` : 'NOTHING at all';

  return (
    `${recovery.scenario} on ${result.proof.requested ?? 'an unnamed byte source'}: froze ` +
    `${seconds(recovery.longestFreezeMs)}s ${buffered}, ${resumed}. ${result.rebufferCount} rebuffers, ` +
    `advance ${result.advanceRatio.toFixed(3)}, ${result.segmentRequests} segment requests, and the client ` +
    `said ${said} while frozen`
  );
}

/** One decimal, which is the precision the crash matrix's own figures are quoted at. */
function seconds(ms: number): string {
  return (ms / 1_000).toFixed(1);
}
