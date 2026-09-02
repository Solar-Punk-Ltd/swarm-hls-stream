/**
 * The two hls.js rules that decide which rung a player may take, and the numbers this client runs
 * them with.
 *
 * hls.js (`abr-controller.ts`, `findBestLevel`) compares a candidate rung's bitrate against an
 * ADJUSTED bandwidth: the measured estimate times `abrBandWidthFactor` when the candidate sits at or
 * below the current level, and times `abrBandWidthUpFactor` when it sits above. A rung is taken only
 * when its bitrate is under that adjusted figure. So a link capped at exactly a rung's bitrate never
 * carries that rung, and climbing to a rung needs an estimate well above it.
 *
 * Both numbers live here because two things read them: the client hands them to hls.js, and the e2e
 * harness uses them to say which rungs a cap left within a player's reach. A copy in each would be a
 * report describing a player that no longer exists. Measured 2026-09-02: a viewer capped at 2800 kbps,
 * the 720p rung's own bitrate, could not take 720p on the way down (it needed 2947) and needed a
 * 4000 kbps estimate to climb back to it (`docs/bench/browser-quality-2026-09-02T12-52-16-340Z.md`).
 */

/** Fraction of the measured bandwidth a rung must sit under to be chosen going down or staying. hls.js's own default. */
export const ABR_BANDWIDTH_FACTOR = 0.95;

/** Fraction of the measured bandwidth a rung must sit under to be climbed to. hls.js's own default. */
export const ABR_BANDWIDTH_UP_FACTOR = 0.7;

/**
 * Whether a player measuring `bandwidthKbps` may take a rung cut at `rungKbps`, going down or staying.
 *
 * Necessary, never sufficient: hls.js also asks that the fragment arrive before the buffer runs dry,
 * which can refuse a rung this admits and never admits one this refuses.
 */
export function isRungAffordable(rungKbps: number, bandwidthKbps: number): boolean {
  return rungKbps < bandwidthKbps * ABR_BANDWIDTH_FACTOR;
}

/**
 * Floating point puts 2800 / 0.7 at 4000.0000000000005, and a ceiling of that reads 4001. A quotient
 * landing within this much above a whole number is that whole number.
 */
const DIVISION_SLACK_KBPS = 1e-6;

/** The bandwidth estimate a player needs before it climbs to a rung cut at `rungKbps`, in whole kbps. */
export function estimateNeededToClimbKbps(rungKbps: number): number {
  return Math.ceil(rungKbps / ABR_BANDWIDTH_UP_FACTOR - DIVISION_SLACK_KBPS);
}
