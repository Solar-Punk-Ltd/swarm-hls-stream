/**
 * The questions a viewer whose rung went quiet is asked.
 *
 * ## What a rung-outage arm is
 *
 * One broadcast, one viewer, and the single rung they were watching stopped being produced while
 * three healthy ones carry on. `browser:rung-outage` reads which rung the player settled on, stops
 * that transcode inside the engine, keeps sampling, resumes it and keeps sampling.
 *
 * ## ⛔ The two halves, and why neither is allowed to stand alone
 *
 * The rung timeline says whether the player moved. The freeze verdict says whether the viewer paid
 * for it. Each reads as a success on its own and neither is one: a player that switched away
 * instantly and then stalled has helped nobody, and a picture that never stopped because the buffer
 * outlasted the outage was never tested. Both are asserted.
 *
 * ## ⛔ What is expected to be hard
 *
 * hls.js changes level on a fragment load ERROR. A Swarm feed that stops advancing does not error, it
 * stops offering fragments, and a player waiting for one it was never offered has nothing to react
 * to. **A red here is a real defect rather than a harness problem**, and the message says which of
 * the two it is so the next session does not have to work it out again.
 *
 * ## ⛔ No timing is judged
 *
 * Owner ruling of 2026-08-29. Whether the viewer kept watching is correctness. How long each part
 * took is measured, printed and filed, and refuses nothing.
 */

import { DEFAULT_BYTE_SOURCE_SETTLE_SECONDS } from '../browser/byteSourceArm.js';
import { WEEB3_BYTES } from '../browser/fetchBackendSweep.js';
import { type RungTimeline } from '../browser/qualitySwitch.js';

import { type BrowserArmResult } from './browser.js';
import { weeb3ArmRefusal } from './browserVerdict.js';

/**
 * The driver's own windows, restated here because a suite cannot import the driver.
 *
 * ⛔ `browser/rung-outage.ts` runs its own `main()` on import. `test/rungArm.test.ts` greps it and
 * fails if these drift, which is the only thing that makes a mirror safe.
 */
export const RUNG_SETTLE_SECONDS = 45;
export const RUNG_QUIET_SECONDS = 90;
export const RUNG_RECOVER_SECONDS = 60;

/** One broadcast paid by the minute, the same ceiling the crash and squeeze arms are held to. */
const MAX_ARM_MINUTES = 6;

/**
 * How much wall clock one rung-outage arm gets, derived from the driver's windows rather than picked.
 *
 * ⭐ A budget rather than a watch. The driver's windows are its own, so this decides when the harness
 * gives up on an arm and nothing about how long the viewer watches.
 */
export function rungArmMinutes(): number {
  const timelineS =
    DEFAULT_BYTE_SOURCE_SETTLE_SECONDS + RUNG_SETTLE_SECONDS + RUNG_QUIET_SECONDS + RUNG_RECOVER_SECONDS;
  const minutes = Math.ceil(timelineS / 60);

  if (minutes > MAX_ARM_MINUTES) {
    throw new Error(
      `a rung-outage arm would need ${minutes} minutes of broadcast against a ceiling of ${MAX_ARM_MINUTES}. ` +
        'An arm is one paid broadcast, so windows this long are a sitting to be authorised rather than a ' +
        'suite to be run.',
    );
  }
  return minutes;
}

interface RungArmExpectation {
  maxSegmentRequests: number;
}

/**
 * Why this run is not a viewer whose rung went quiet, or null.
 *
 * ⛔ Everything here is about the RUN rather than the product, and each one makes every reading below
 * it a property of the harness.
 */
export function rungArmRefusal(result: BrowserArmResult, expectation: RungArmExpectation): string | null {
  if (!result.instrumentSound) {
    return (
      'the browser was not a usable instrument for this run, so a rung that did or did not move is as ' +
      `likely to be the harness as the outage: ${result.instrumentFailures.join('; ') || 'no reason recorded'}`
    );
  }

  if (result.rungs === null || result.silencedRung === null) {
    return (
      'this artifact carries no rung timeline, so no rung was silenced under this viewer. Every rung was ' +
      'publishing for the whole run, and a player that stayed where it was did the only correct thing ' +
      'available to it'
    );
  }

  if (result.recovery === null) {
    return (
      'this artifact carries a rung timeline and no freeze verdict, so whether the viewer paid for the ' +
      'switch cannot be read. A player that moved rung and stalled doing it would pass every other check'
    );
  }

  if (result.resolutions.length === 0) {
    return 'the player never reported a resolution, so nothing was decoded and there was no rung to lose';
  }

  if (result.advanceRatio <= 0) {
    return (
      'the picture never moved forward at any point in this arm, so there was no playback for the outage ' +
      'to interrupt'
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

/** Why this run is not evidence about the ladder, or null. A pinned player rides one rung by instruction. */
export function ladderInPlayRefusal(rungs: RungTimeline): string | null {
  if (!rungs.abrEnabledThroughout) {
    return (
      'the level was pinned at some point in this run, so the player was not choosing its own rung. A ' +
      'pinned player that stays on a dead rung has obeyed an instruction rather than failed to adapt'
    );
  }
  if (rungs.before.endedOnRungHeight === null) {
    return 'the player had selected no rung when the outage landed, so there is nothing it can have moved off';
  }
  return null;
}

/**
 * Why this viewer stayed on a rung that had stopped being produced, or null.
 *
 * ⭐ The plan's own done-when: a viewer frozen on a dead rung while three healthy ones sit beside it
 * fails. The message names the mechanism, because the likely cause is a property of how hls.js
 * decides to switch rather than anything in this repo, and a session reading the red should not have
 * to rediscover that.
 */
export function movedOffDeadRungRefusal(rungs: RungTimeline, silencedRung: string): string | null {
  const before = rungs.before.endedOnRungHeight;
  if (rungs.during.endedOnRungHeight !== before) {
    return null;
  }
  return (
    `this viewer was watching ${silencedRung} when it stopped being produced and was still on ` +
    `${before}p at the end of the outage. hls.js changes level on a fragment load ERROR, and a feed ` +
    'that stops advancing does not error, it stops offering fragments, so a player waiting for one it ' +
    'was never offered has nothing to react to. Three healthy rungs were published throughout'
  );
}

/** Why moving rung bought this viewer nothing, or null. */
export function keptWatchingRefusal(rungs: RungTimeline): string | null {
  if (rungs.during.advance.ratio > 0) {
    return null;
  }
  return (
    `the picture did not move at all across the ${Math.round(rungs.during.advance.wallMs / 1000)}s one rung ` +
    `of the ladder was quiet, over ${rungs.during.advance.samples} samples. Whatever the player selected, ` +
    'this viewer sat in front of a frozen frame while three healthy rungs published beside them'
  );
}

/** The line an operator reads while a rung-outage arm runs. */
export function rungArmSummary(result: BrowserArmResult): string {
  const { rungs, recovery } = result;
  if (rungs === null) {
    return 'this arm silenced no rung, so there is no rung timeline to report';
  }
  const rung = (height: number | null): string => (height === null ? 'no rung' : `${height}p`);

  return (
    `silenced ${result.silencedRung ?? 'nothing'}: ${rung(rungs.before.endedOnRungHeight)} before, ` +
    `${rung(rungs.during.endedOnRungHeight)} during, ${rung(rungs.after.endedOnRungHeight)} after. ` +
    `${rungs.switchesCounted} level changes, the picture advanced ${rungs.during.advance.ratio.toFixed(3)} ` +
    `while it was quiet, and froze ${((recovery?.longestFreezeMs ?? 0) / 1000).toFixed(1)}s at its worst`
  );
}
