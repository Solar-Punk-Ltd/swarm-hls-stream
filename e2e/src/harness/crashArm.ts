/**
 * How long a crash arm needs, and the questions a crash scenario asks of the one it got.
 *
 * ## What a crash arm is
 *
 * One broadcast, one fault, one viewer. `browser:crash` opens a real player, watches it settle,
 * breaks a container of the deployment from inside the same process, and keeps sampling while the
 * service comes back. Five faults are declared in `browser/faults.ts` and all five were measured
 * against a real viewer on 2026-08-27, recorded in `docs/bench/crash-at-an-in-tab-viewer-2026-08-27.md`.
 * The suites under `suites/viewer/` drive those faults, and this is what they judge on.
 *
 * ## ⛔ What these judge, and what they only measure
 *
 * **Owner ruling, 2026-08-29: an e2e suite checks feature correctness and stability. It never gates
 * on a timing.** So what is asserted is that the viewer watched, that the picture came back where
 * recovery is the contract and correctly did not where the broadcast ended, and that the client told
 * them something true meanwhile. How long the freeze lasted, how much buffer ran out in front of it
 * and how quickly the picture returned are measured on every arm, printed by
 * {@link crashArmSummary}, and filed in the artifact. None of them refuses a run.
 *
 * ⚠️ **What that repaired.** These once held the 2026-08-27 matrix's figures as ceilings and floors.
 * That sitting was a SINGLE-RENDITION 720p broadcast at a 0.5s GOP, and the suites now run against a
 * four rung ABR ladder. Live on 2026-08-29 they read 57.1s, 58.0s and 57.0s of freeze against
 * ceilings of 45s, 8s and 45s, and V10 read 16.3s against a FLOOR of 20s, so it was refused for
 * costing its viewer less than the matrix recorded. None of those five reds was a broken feature.
 * The gap itself is explained and is not this code's: an in-browser node admits roughly one segment
 * per second, so half second segments cap it near half of real time.
 *
 * ## Why the rules live here rather than in the suites
 *
 * Nothing under `suites/` runs in CI and each of those files costs a broadcast, so a rule written
 * inline in a scenario is a rule nothing checks until a paid broadcast is already burning. Reached
 * from `test/crashArm.test.ts`, these are covered by the unit run and the suites are left with the
 * per-fault contract and the wiring.
 *
 * ⭐ Every predicate returns the reason a run is not what the product promises, or null. That is the
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

  // ⭐ The correctness question the freeze floors used to stand in for. A viewer who decoded a first
  // frame and then sat on it for the whole arm passes every other check here, and the fault would be
  // credited with stopping a picture that was never moving. How MUCH it moved is not asked: see the
  // module docblock.
  if (result.advanceRatio <= 0) {
    return (
      'the picture never moved forward at any point in this arm, so there was no playback for the ' +
      'fault to interrupt and every verdict below would be about a frozen frame the fault did not cause'
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

/** Whether this fault lets the viewer back in at all. */
interface ResumeExpectation {
  /** False for a fault that genuinely ends the broadcast, where a picture that never moves again is correct. */
  expectRecovery: boolean;
}

/**
 * Why the picture did not come back the way this fault lets it, or null.
 *
 * ⭐ **Whether, never how fast.** This once held `recoveredAfterLiftMs` against a per-fault ceiling,
 * and that figure is still the sharpest one these arms produce: the uploader-crash recovery fix moved
 * it from 46.7s to 2.3s. It is measured on every arm, printed by {@link crashArmSummary} and filed,
 * so a regression is noticed. It is not refused. Owner ruling of 2026-08-29, and the reading behind
 * it: on a four rung ladder the same faults froze a viewer for 57 to 59 seconds where the
 * single-rendition matrix recorded 13 to 30, which is the configuration and not a broken recovery.
 */
export function resumeRefusal(recovery: CrashRecoveryResult, { expectRecovery }: ResumeExpectation): string | null {
  if (!expectRecovery) {
    return recovery.recovered
      ? 'the picture started moving again after a fault that ended the broadcast this viewer was watching. ' +
          'Either they were handed a different broadcast, or the fault never landed'
      : null;
  }

  return recovery.recovered
    ? null
    : 'the picture never moved again before the run ended, so this viewer was left on a frozen frame by a ' +
        'fault the product is supposed to recover from';
}

/** Which of the overlay's states describe this fault honestly, and whether one of them is owed. */
interface FrozenOverlayExpectation {
  /**
   * Every state that is TRUE of this fault. Anything outside it is the client lying to a viewer.
   *
   * ⭐ A set rather than the one state a past run produced. The three non-terminal states each name a
   * different reason and all three carry the same operative claim to somebody watching a stopped
   * picture: we know, and we are still trying. Which one fires depends on which internal counter
   * crossed first, and that is a function of the rung count and the byte source rather than of
   * anything the viewer experiences. `ended` is the one that is categorically different, because it
   * is terminal and tells them to stop waiting, so on a fault the broadcast survives it is a lie and
   * on the fault that ends it, it is the truth.
   */
  truthful: readonly ViewerFeedState[];
  /**
   * Whether the client must have said one of them, or may correctly have stayed quiet.
   *
   * ⚠️ False is not "silence is fine", it is "this client is not yet known to be able to speak here".
   * See issue #100: where the gateway keeps answering and only the slot is empty, the counter that
   * would catch it is `UNSERVED_SLOT_POLL_LIMIT`, whose poll rate collapses during exactly the stall
   * it exists to detect, and one long freeze is a single playback stall rather than the burst
   * `degraded` needs. Requiring a message there would assert a fix that has not landed.
   */
  mustSpeak: boolean;
}

/**
 * Why what the client told the viewer while their picture was stopped was not true, or null.
 *
 * ⭐ Judged as states rather than as prose. The overlay's wording is a product decision, so asserting
 * the sentence would turn a green scenario red on a copy edit while a genuinely broken terminal state
 * stayed green for as long as the words survived. ⛔ A message the client is no longer known to render
 * throws out of `readFeedState` rather than reading as silence, which is the honest answer to no
 * longer knowing what the viewer was looking at.
 *
 * ⛔ **Silence is a claim, not an absence.** The client renders nothing for `live`, so a stopped
 * picture under no overlay is a viewer being told everything is fine while they look at a frozen
 * frame. Where {@link FrozenOverlayExpectation.mustSpeak} is set, that is refused.
 *
 * ⚠️ This once asserted the recorded silence EXACTLY, so a fix for #100 would have turned three cases
 * red for the product improving. Under the owner ruling of 2026-08-29 a correctness suite goes green
 * when the product gets better, so a client that starts explaining a fault it used to sit through in
 * silence now passes.
 */
export function frozenOverlayRefusal(
  recovery: CrashRecoveryResult,
  { truthful, mustSpeak }: FrozenOverlayExpectation,
): string | null {
  // The live state is the overlay rendering nothing, which is silence rather than something said.
  const shown: ViewerFeedState[] = recovery.saidWhileFrozen
    .map((message) => readFeedState(message))
    .filter((state) => state !== FEED_STATE_LIVE);

  const lies = shown.filter((state) => !truthful.includes(state));
  if (lies.length > 0) {
    return (
      `the client showed ${lies.join(', ')} while the picture was stopped, and that is not true of this ` +
      `fault: only ${truthful.join(', ')} describe what was happening to this viewer. A frozen frame ` +
      'under a wrong explanation is worse than one under none, because the viewer acts on it'
    );
  }

  if (mustSpeak && shown.length === 0) {
    return (
      'the client showed nothing at all while the picture was stopped, and rendering nothing is how it ' +
      `says the feed is live. This viewer was told everything was fine while they looked at a frozen ` +
      `frame, where ${truthful.join(', ')} was available and true`
    );
  }

  return null;
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
