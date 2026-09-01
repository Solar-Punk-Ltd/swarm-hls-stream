/**
 * The questions a squeezed viewer's run is asked, and the order they have to be asked in.
 *
 * ## What a squeeze arm is
 *
 * One broadcast, one viewer, and their connection made worse partway through. `browser:quality` opens
 * a real player, watches it settle on a rung, caps the tab's download at a bandwidth the upper rungs
 * cannot fit inside, keeps sampling, lifts the cap and keeps sampling. `suites/viewer/quality-switch`
 * drives it and this is what it judges on.
 *
 * ## ⛔ Why the order matters more here than anywhere else in this harness
 *
 * Three things have to be true before "the player stepped down" means anything: there was a viewer,
 * the player was choosing its own rung, and the cap actually reached it. Chromium applies network
 * emulation itself and whether it reaches a given transport is the browser's business, not something
 * this can assert from outside. An in-tab node carries segment bytes over its own peer connections.
 * ⭐ So a run whose player never noticed the cap is refused as an instrument failure, and never
 * reported as a ladder that does not adapt.
 *
 * ## ⛔ No timing is judged
 *
 * Owner ruling of 2026-08-29. Whether the player came down, kept playing and went back up is
 * correctness. How many seconds each took is measured, carried in the artifact and printed. None of
 * it refuses a run.
 *
 * ## Why the rules live here rather than in the suite
 *
 * Nothing under `suites/` runs in CI and the file costs a broadcast, so a rule written inline is a
 * rule nothing checks until a paid broadcast is already burning. Reached from
 * `test/qualityArm.test.ts`, these are covered by the unit run.
 */

import { DEFAULT_BYTE_SOURCE_SETTLE_SECONDS } from '../browser/byteSourceArm.js';
import { WEEB3_BYTES } from '../browser/fetchBackendSweep.js';
import {
  describeLevelRequests,
  fragmentLogVerdict,
  type FragmentRequestTimeline,
} from '../browser/fragmentRequests.js';
import { type QualitySwitchVerdict } from '../browser/qualitySwitch.js';

import { type BrowserArmResult } from './browser.js';
import { weeb3ArmRefusal } from './browserVerdict.js';

/**
 * The driver's own windows, restated here because a suite cannot import the driver.
 *
 * ⛔ `browser/quality.ts` runs its own `main()` on import, so a suite that pulled it in would launch a
 * browser. `test/qualityArm.test.ts` greps the driver and fails if these drift, which is the only
 * thing that makes a mirror safe.
 */
export const SQUEEZE_SETTLE_SECONDS = 45;
export const SQUEEZE_SECONDS = 60;
export const SQUEEZE_RECOVER_SECONDS = 60;

/**
 * The most broadcast a squeeze arm may buy.
 *
 * One broadcast paid by the minute, the same ceiling a crash arm is held to and for the same reason:
 * this is the knob that decides what the promoted suites cost every time they run.
 */
const MAX_ARM_MINUTES = 6;

/**
 * How much wall clock one squeeze arm gets, derived from the driver's windows rather than picked.
 *
 * ⛔ It must outlast the whole timeline: the in-tab node's settle before the measurement opens, the
 * baseline the step down is measured against, the squeeze itself and the watch for the climb back.
 * Everything outside that is budgeted separately by `BROWSER_ARM_OVERHEAD_MS`.
 *
 * ⭐ A budget rather than a watch. `browser:quality` never reads `BROWSER_WATCH_SECONDS` and its
 * windows are its own, so this decides when the harness gives up and nothing about how long the
 * viewer watches.
 */
export function squeezeArmMinutes(): number {
  const timelineS =
    DEFAULT_BYTE_SOURCE_SETTLE_SECONDS + SQUEEZE_SETTLE_SECONDS + SQUEEZE_SECONDS + SQUEEZE_RECOVER_SECONDS;
  const minutes = Math.ceil(timelineS / 60);

  if (minutes > MAX_ARM_MINUTES) {
    throw new Error(
      `a squeeze arm would need ${minutes} minutes of broadcast against a ceiling of ${MAX_ARM_MINUTES}. ` +
        'An arm is one paid broadcast, so windows this long are a sitting to be authorised rather than a ' +
        'suite to be run.',
    );
  }
  return minutes;
}

/** What an arm was asked to be, checked against what the artifact says it was. */
interface QualityArmExpectation {
  maxSegmentRequests: number;
}

/**
 * Why this run is not a viewer whose connection was squeezed, or null.
 *
 * ⛔ Everything here is about the RUN rather than the product. Each of these makes every reading
 * below it a property of the harness, so a suite that asserted past one of them would be certifying
 * its own instrument.
 */
export function qualityArmRefusal(result: BrowserArmResult, expectation: QualityArmExpectation): string | null {
  if (!result.instrumentSound) {
    return (
      'the browser was not a usable instrument for this run, so a rung that did or did not move is as ' +
      `likely to be the harness as the connection: ${result.instrumentFailures.join('; ') || 'no reason recorded'}`
    );
  }

  // ⛔⛔ Before the verdict itself. A viewer already on the bottom rung has nowhere to step down to,
  // so the question cannot be put to them at all, and failing them would report a property of the
  // byte source as a defect in the ladder. Live on 2026-08-30 the gateway profile did exactly this.
  if (result.cannotSqueeze !== null) {
    return `this viewer cannot be asked whether the ladder adapts: ${result.cannotSqueeze}`;
  }

  const { quality } = result;
  if (quality === null) {
    return (
      'this artifact carries no quality verdict, so it is a plain watch rather than a squeeze arm. This ' +
      "viewer's connection was never made worse, and a player that stayed on one rung did the only " +
      'correct thing available to it'
    );
  }

  if (result.resolutions.length === 0) {
    return 'the player never reported a resolution, so nothing was decoded and there was no quality to switch';
  }

  if (result.advanceRatio <= 0) {
    return (
      'the picture never moved forward at any point in this arm, so there was no playback for the cap to ' +
      'degrade and every verdict below would be about a frozen frame'
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

/**
 * Why this run is not evidence about adaptive bitrate, or null.
 *
 * ⛔ About whether the experiment HAPPENED, never about whether the product works. A pinned player
 * rides one rung by instruction, and a cap that changed nothing a viewer could feel is a cap that did
 * not land.
 *
 * ## ⛔⛔⛔ Why the player's own bandwidth estimate is NOT the gate, though it was
 *
 * The first version refused any run whose estimate stayed above the cap, reasoning that hls.js
 * measures its own fragment load timings and so cannot honestly read more than the link carries.
 * **That is false on the in-tab path and it hid a real defect.** Measured 2026-08-30 with a weeb-3
 * node in the tab: capped at 2800 kbps, the estimate read **74221 kbps**, and the viewer's playback
 * fell from **1.000 to 0.604** over the same window. The cap unmistakably reached the viewer. What it
 * did not reach was the MEASUREMENT: fragments come out of a local node at memory speed once the node
 * holds them, so hls.js times the handover and never the node's retrieval from Swarm.
 *
 * ⭐ So the estimate is carried and printed and decides nothing. The gate is what a viewer could
 * actually feel: either the player moved rung, or the picture got worse. Neither, and the cap changed
 * nothing observable.
 */
export function throttleRefusal(quality: QualitySwitchVerdict): string | null {
  if (!quality.abrEnabledThroughout) {
    return (
      'the level was pinned at some point in this run, so the player was not choosing its own rung. A ' +
      'pinned player that does not step down has obeyed an instruction rather than failed to adapt'
    );
  }

  // Either outcome proves the cap landed: a player that adapted well enough to keep playing, or a
  // player that did not and whose picture suffered for it. Only both being absent is a dead treatment.
  const adapted = quality.steppedDownAfterMs !== null;
  const degraded = quality.during.advance.ratio < quality.before.advance.ratio;
  if (adapted || degraded) {
    return null;
  }

  return (
    `the tab's download was capped at ${quality.throttledToKbps} kbps and nothing a viewer could feel ` +
    `changed: the player held ${quality.before.endedOnRungHeight ?? 'its'}p throughout and the picture ` +
    `advanced ${quality.during.advance.ratio.toFixed(3)} while capped against ` +
    `${quality.before.advance.ratio.toFixed(3)} before it. The cap did not land, so this run cannot say ` +
    'what the ladder would do on a genuinely worse connection'
  );
}

/**
 * Why this viewer did not step down when their connection could no longer carry their rung, or null.
 *
 * Measured against the rung the player was on WHEN THE CAP LANDED, which `judgeQualitySwitch` records
 * as the baseline. Not against the tallest rung of the whole settle: the client starts at the top
 * deliberately and may come down on its own, and crediting the cap with that descent would let a
 * player that ignores bandwidth pass.
 */
export function steppedDownRefusal(quality: QualitySwitchVerdict): string | null {
  const baseline = quality.before.endedOnRungHeight;
  if (baseline === null) {
    return 'the player had selected no rung when the cap landed, so there is nothing for it to have stepped down from';
  }
  if (quality.steppedDownAfterMs === null) {
    // ⛔ Which half failed. Deciding to come down and managing to are different faults with different
    // owners, and until 2026-09-01 this called both of them the first. V2 that day: the cap landed,
    // ABR asked for 360p three seconds later, and the player did not arrive until after the cap had
    // been lifted. Blaming ABR sent a reader to the one part that had worked.
    const decided =
      quality.abrChoseLowerAfterMs === null
        ? 'and ABR never asked for a lower rung, so the decision is what failed'
        : `and ABR asked for a lower rung ${(quality.abrChoseLowerAfterMs / 1000).toFixed(1)}s in, so the ` +
          'decision was right and the player could not act on it. A starving player cannot fetch the ' +
          'fragment it would switch to, so look at the buffer and the in-flight fragment, not at ABR';
    return (
      `this viewer rode ${baseline}p through a connection capped at ${quality.throttledToKbps} kbps and never ` +
      `came below it. The lowest rung they selected while capped was ${quality.during.lowestRungHeight ?? 'none'}p, ` +
      `${decided}. A ladder nobody descends is four times the publishing cost for one quality`
    );
  }
  return null;
}

/**
 * Why stepping down bought this viewer nothing, or null.
 *
 * ⭐ The half that makes the step down worth having. Coming down to a rung the link can carry is only
 * correct if the picture keeps moving, and a player that stepped down into a stall has adapted its way
 * into the same place it started.
 */
export function keptPlayingRefusal(quality: QualitySwitchVerdict): string | null {
  if (quality.during.advance.ratio > 0) {
    return null;
  }
  return (
    `the picture did not move at all across the ${Math.round(quality.during.advance.wallMs / 1000)}s the ` +
    `connection was capped at ${quality.throttledToKbps} kbps, over ${quality.during.advance.samples} samples. ` +
    'Whatever the player selected, this viewer was looking at a frozen frame, which is what an adaptive ' +
    'ladder exists to prevent'
  );
}

/**
 * Why this viewer was left on a worse quality than their connection can now carry, or null.
 *
 * Measured against the rung the squeeze LEFT them on rather than the original baseline, so a player
 * that climbed part of the way back has climbed. How far it got is measured and printed.
 *
 * ⛔ **Not applicable to a viewer the squeeze never moved.** Read live on 2026-08-30 against a viewer
 * who rode 1080p through the whole cap: this refused them for failing to climb back to a rung they
 * had never left, and called 1080p "the bottom rung" while doing it. Whether that viewer should have
 * stepped down is {@link steppedDownRefusal}'s question and it is the one worth answering, so saying
 * nothing here leaves the run's verdict to the check that can actually explain it.
 */
export function climbedBackRefusal(quality: QualitySwitchVerdict): string | null {
  if (quality.climbedBackAfterMs !== null) {
    return null;
  }

  const startedOn = quality.before.endedOnRungHeight;
  const lowest = quality.during.lowestRungHeight;
  if (startedOn === null || lowest === null || lowest >= startedOn) {
    return null;
  }

  return (
    `the cap came off and this viewer stayed on ${lowest}p, the rung the squeeze pushed them down to ` +
    `from ${startedOn}p, for the rest of the run. A ladder that only ever goes down leaves every viewer ` +
    'who had one bad minute watching a worse picture for the rest of the broadcast'
  );
}

/**
 * Which level the player ASKED for across the three phases, as one sentence.
 *
 * ⛔⛔ **Three silences, three sentences, and none of them may be printed as another.** A null
 * timeline is the BROWSER IMAGE having no instrument, because only a driver carrying it writes the
 * section at all, and the fix for that is rebuilding the image the arm runs in. A timeline whose state
 * is `absent` is the deployed CLIENT having none, and the fix is redeploying the client. A timeline
 * that recorded lines and shows a phase at zero is the player, which is the only one of the three that
 * is a finding about the product.
 *
 * ⛔ An observation. Nothing here refuses a run, per the owner ruling of 2026-08-29.
 */
export function levelsAskedForSummary(asked: FragmentRequestTimeline | null): string {
  if (asked === null) {
    return (
      'which level was asked for is not in this artifact at all: the browser image that ran this arm ' +
      'predates the instrument, so rebuild it before reading this run for a level'
    );
  }
  if (asked.state !== 'recorded') {
    return fragmentLogVerdict(asked);
  }

  return (
    `levels asked for: ${describeLevelRequests(asked.before)} before the cap, then ` +
    `${describeLevelRequests(asked.during)} while capped, then ${describeLevelRequests(asked.after)} after the lift`
  );
}

/** The line an operator reads while a squeeze arm runs, so a long arm shows what it is producing. */
export function qualityArmSummary(result: BrowserArmResult): string {
  const { quality } = result;
  if (quality === null) {
    return 'this arm drove no squeeze, so there is no rung timeline to report';
  }
  const rung = (height: number | null): string => (height === null ? 'no rung' : `${height}p`);

  return (
    `capped at ${quality.throttledToKbps} kbps: ${rung(quality.before.endedOnRungHeight)} before, down to ` +
    `${rung(quality.during.lowestRungHeight)} under it, up to ${rung(quality.after.tallestRungHeight)} after. ` +
    `${quality.switchesCounted} level changes, the picture advanced ${quality.during.advance.ratio.toFixed(3)} ` +
    `while capped, and the player's own estimate went ${quality.before.bandwidthEstimateKbps ?? '—'} → ` +
    `${quality.during.bandwidthEstimateKbps ?? '—'} → ${quality.after.bandwidthEstimateKbps ?? '—'} kbps. ` +
    // ⛔ An added observation, asserted nowhere. Every rung figure above is what the player DECODED or
    // what ABR would pick NEXT, and neither can tell a player riding a rung it cannot afford from one
    // asking for a cheaper rung that something upstream answers with the expensive one.
    `${levelsAskedForSummary(result.fragmentRequests)}`
  );
}
