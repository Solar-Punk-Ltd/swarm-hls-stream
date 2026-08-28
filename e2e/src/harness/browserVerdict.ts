/**
 * The two questions a viewer scenario asks of a browser arm.
 *
 * They live here rather than inline in the suites because nothing under `suites/` runs in CI: a
 * verdict written inside a scenario is a verdict nothing checks until a paid broadcast is already
 * burning. Reached from `test/browserVerdict.test.ts`, they are covered by the unit run and the
 * suites are left with the thresholds and the wiring.
 *
 * ⭐ Both return the reason a run is not what it claims, or null. That is the idiom
 * `byteSourceArmIsComparable` and `gatewayArmIsComparable` already use. A boolean would let a suite
 * print "assertion failed" where the harness could have said which of four things went wrong, on a
 * run that cost minutes of broadcast to produce.
 */

import { WEEB3_BYTES } from '../browser/fetchBackendSweep.js';

import { type BrowserArmResult } from './browser.js';

export interface PlaybackExpectation {
  /**
   * The lowest share of wall clock the picture may keep up with and still count as watched.
   *
   * Judged against `overallAdvanceRatio`, which is media seconds delivered per wall second across the
   * whole watch with stalls included, so the shortfall below one is time the viewer spent looking at
   * a frozen frame.
   */
  minAdvanceRatio: number;
}

/**
 * Why this run is not a viewer who watched the broadcast, or null.
 *
 * ⛔ The instrument comes first and before any figure is read. Chromium pauses muted video and
 * throttles timers on a hidden page, hls.js loads fragments off those timers, and the previous
 * attempt at watching in a browser ended 578 seconds behind live with nothing in the number saying
 * so. Those figures are properties of the harness, and a suite that failed a product on them, or
 * passed one, would be reporting on the harness either way.
 */
export function viewerPlaybackRefusal(result: BrowserArmResult, { minAdvanceRatio }: PlaybackExpectation): string | null {
  if (!result.instrumentSound) {
    return (
      'the browser was not a usable instrument for this run, so its figures are properties of the ' +
      `harness rather than of the product: ${result.instrumentFailures.join('; ') || 'no reason recorded'}`
    );
  }

  if (result.fatalErrors > 0) {
    return `the player raised ${result.fatalErrors} fatal error(s), so the picture stopped for good rather than stuttering`;
  }

  if (result.advanceRatio < minAdvanceRatio) {
    return (
      `playback kept up with ${result.advanceRatio.toFixed(3)} of the wall clock against a floor of ` +
      `${minAdvanceRatio}, so the viewer spent the rest of the watch on a frozen frame ` +
      `(${result.rebufferCount} rebuffers over ${result.samples} samples)`
    );
  }

  // ⛔ Last, and it is the check that separates a flawless run from one that decoded nothing. A run
  // that never played reports zero rebuffers, zero fatal errors and no resolution at all, which is
  // the same shape as a perfect one on every field but this one.
  if (result.resolutions.length === 0) {
    return (
      'the player never reported a resolution, so nothing was decoded and its zero rebuffers and zero ' +
      'errors are the silence of a viewer who saw no picture rather than the record of a good one'
    );
  }

  return null;
}

export interface Weeb3ArmExpectation {
  /**
   * The most `/bytes/` requests an in-tab arm may make over the whole run.
   *
   * An arm legitimately reads through the gateway while its own node boots, which is 4.5 MB of wasm
   * and a peer dial, so the count is a handful rather than a zero. What it must not be is the
   * hundreds a gateway viewer makes.
   */
  maxSegmentRequests: number;
}

/**
 * Why this arm is not the in-tab node it is filed as, or null.
 *
 * ⛔⛔ Two witnesses, and the run needs both. The readback says what the client BELIEVES, and on
 * 2026-08-13 both arms of a paid sitting answered honestly and correctly while fetching every one of
 * their 253 segments from one node. The request count is what the network DID.
 *
 * ⭐ The driver's own gate has already refused an arm whose zero came from never loading a node at
 * all, using the wasm chunk as the witness, and it throws before writing nothing a reader could take
 * for a result. So a state file that exists is one whose zero has already been separated from the
 * broken kind, and what is left for a suite is the count.
 */
export function weeb3ArmRefusal(result: BrowserArmResult, { maxSegmentRequests }: Weeb3ArmExpectation): string | null {
  const { requested, reported } = result.proof;

  if (requested !== WEEB3_BYTES) {
    return (
      `this arm asked for ${requested ?? 'no byte source at all'} rather than ${WEEB3_BYTES}, so it is ` +
      'the other condition and nothing about it is a reading of a node in the viewer\'s own tab'
    );
  }

  if (reported !== requested) {
    return (
      `this arm asked for ${requested} and the client reports ${reported}, so the switch did not take. ` +
      'Both conditions would then be one, every metric would agree, and the run would report that an ' +
      'in-tab node performs exactly like a gateway.'
    );
  }

  if (result.segmentRequests > maxSegmentRequests) {
    return (
      `this arm made ${result.segmentRequests} segment requests of the gateway against a ceiling of ` +
      `${maxSegmentRequests}, so its video did not come from the node in the tab however the client ` +
      'answered when asked'
    );
  }

  return null;
}
