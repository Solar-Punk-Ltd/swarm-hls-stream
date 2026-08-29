/**
 * What a viewer's player did when their connection was squeezed, and what it did when it was let go.
 *
 * ## The question
 *
 * An adaptive ladder exists so that a viewer whose connection degrades keeps watching at a lower
 * quality instead of stopping. Every ABR test this project had read the uploader's log, which can
 * only say the rungs were published. Whether a player ever uses them had never been observed.
 *
 * ## ⛔ Two readings, and they are not the same reading
 *
 * The rung SELECTED is the player's decision. The resolution DELIVERED is what the decoder managed to
 * produce. A player that chose to step down and could not get the frames out reads as unchanged in
 * the second and changed in the first, and calling either one "the quality switch" hides the other.
 * Both are carried through and the suite says which one it is asserting.
 *
 * ## ⛔ No timing is judged here
 *
 * Owner ruling of 2026-08-29. Whether the player came down, kept playing and went back up is
 * correctness. How many seconds it took is measured, carried and printed, and refuses nothing.
 */

import { advanceOf, type PhaseAdvance, phaseOf, type ViewerSample } from './session.js';

/** When the download cap went on and when it came off, on the clock that applied it. */
export interface ThrottleWindow {
  throttledAtMs: number;
  releasedAtMs: number;
  /** What the link was capped to, carried so a verdict can be read without the driver's log. */
  kbps: number;
}

/** One stretch of the run, described by what the player chose and what it delivered across it. */
export interface QualityPhase {
  advance: PhaseAdvance;
  /** The lowest rung selected anywhere in this stretch, by height. Null where none was reported. */
  lowestRungHeight: number | null;
  /** The tallest rung selected anywhere in this stretch, by height. Null where none was reported. */
  tallestRungHeight: number | null;
  /** The rung selected by the LAST sample of this stretch, which is where it left the player. */
  endedOnRungHeight: number | null;
  /** Every distinct resolution the decoder produced in this stretch, in first-seen order. */
  resolutions: readonly string[];
  /** The player's own bandwidth estimate at the last sample of the stretch, in kbps. */
  bandwidthEstimateKbps: number | null;
}

export interface QualitySwitchVerdict {
  throttledToKbps: number;
  before: QualityPhase;
  during: QualityPhase;
  after: QualityPhase;
  /** Level changes hls.js counted across the whole run, end minus start. */
  switchesCounted: number;
  /**
   * Whether the player was choosing its own rung in EVERY sample.
   *
   * ⛔ Read before any other field. A pinned player rides one rung by instruction, so its not
   * stepping down proves nothing about the ladder and its stepping down was not ABR.
   */
  abrEnabledThroughout: boolean;
  /** Wall time from the cap going on to the first sample selecting a lower rung. Null where none did. */
  steppedDownAfterMs: number | null;
  /** Wall time from the cap coming off to the first sample selecting a taller rung. Null where none did. */
  climbedBackAfterMs: number | null;
}

const heights = (samples: readonly ViewerSample[]): number[] =>
  samples.map((sample) => sample.selectedRungHeight).filter((height): height is number => height !== null);

const lastOf = <T>(values: readonly T[]): T | null => (values.length === 0 ? null : values[values.length - 1]);

function distinctResolutions(samples: readonly ViewerSample[]): readonly string[] {
  const seen: string[] = [];
  for (const sample of samples) {
    if (sample.resolution !== null && !seen.includes(sample.resolution)) {
      seen.push(sample.resolution);
    }
  }
  return seen;
}

function qualityPhase(samples: readonly ViewerSample[], from: number, to: number): QualityPhase {
  const phase = phaseOf(samples, from, to);
  const rungs = heights(phase.samples);
  const estimates = phase.samples
    .map((sample) => sample.bandwidthEstimateKbps)
    .filter((kbps): kbps is number => kbps !== null);

  return {
    advance: advanceOf(phase),
    lowestRungHeight: rungs.length === 0 ? null : Math.min(...rungs),
    tallestRungHeight: rungs.length === 0 ? null : Math.max(...rungs),
    endedOnRungHeight: lastOf(rungs),
    resolutions: distinctResolutions(phase.samples),
    bandwidthEstimateKbps: lastOf(estimates),
  };
}

/**
 * The first moment after `from` that the player selected a rung on the far side of `reference`.
 *
 * Wall time from `from`, so a caller reads "it came down N seconds in" without knowing when the run
 * started. Null where it never did, which is the case a suite refuses on.
 */
function firstCrossingAfter(
  samples: readonly ViewerSample[],
  from: number,
  reference: number | null,
  crossed: (height: number, reference: number) => boolean,
): number | null {
  if (reference === null) {
    return null;
  }
  const crossing = samples.find(
    (sample) =>
      sample.atMs >= from && sample.selectedRungHeight !== null && crossed(sample.selectedRungHeight, reference),
  );
  return crossing === undefined ? null : crossing.atMs - from;
}

/**
 * ⛔ The baseline is where the player was when the cap landed, not the tallest it ever reached.
 *
 * The client starts at the top rung deliberately and may settle downwards on its own before anything
 * is squeezed. Measuring the step down against the tallest rung of the whole baseline would credit
 * the throttle with a descent the player had already made.
 */
export function judgeQualitySwitch(samples: readonly ViewerSample[], window: ThrottleWindow): QualitySwitchVerdict {
  const end = samples.length === 0 ? window.releasedAtMs : samples[samples.length - 1].atMs + 1;
  const before = qualityPhase(samples, Number.NEGATIVE_INFINITY, window.throttledAtMs);
  const during = qualityPhase(samples, window.throttledAtMs, window.releasedAtMs);
  const after = qualityPhase(samples, window.releasedAtMs, end);

  const counted = samples.map((sample) => sample.qualitySwitches);

  return {
    throttledToKbps: window.kbps,
    before,
    during,
    after,
    switchesCounted: counted.length === 0 ? 0 : Math.max(...counted) - Math.min(...counted),
    abrEnabledThroughout: samples.length > 0 && samples.every((sample) => sample.abrEnabled),
    steppedDownAfterMs: firstCrossingAfter(
      samples,
      window.throttledAtMs,
      before.endedOnRungHeight,
      (height, baseline) => height < baseline,
    ),
    climbedBackAfterMs: firstCrossingAfter(
      samples,
      window.releasedAtMs,
      during.endedOnRungHeight,
      (height, squeezed) => height > squeezed,
    ),
  };
}
