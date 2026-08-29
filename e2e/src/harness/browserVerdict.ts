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

/**
 * Why this run is not a viewer who watched the broadcast, or null.
 *
 * ⛔ The instrument comes first and before any figure is read. Chromium pauses muted video and
 * throttles timers on a hidden page, hls.js loads fragments off those timers, and the previous
 * attempt at watching in a browser ended 578 seconds behind live with nothing in the number saying
 * so. Those figures are properties of the harness, and a suite that failed a product on them, or
 * passed one, would be reporting on the harness either way.
 *
 * ⭐ **It asks whether the picture moved, never how fast.** Owner ruling of 2026-08-29: these suites
 * check that the feature works, properly and stably, and how much of the wall clock a viewer kept up
 * with is a performance reading. This once held an advance ratio against a floor of 0.95 taken from a
 * single-rendition 720p broadcast. The same client on a four rung ABR ladder delivers 0.80 of the
 * wall clock, because an in-browser node admits about one segment a second and half second segments
 * therefore cap it near half of real time. That is a known property of the configuration and not a
 * defect in this code, and a suite that failed it would be calling a slower deployment a broken one.
 * `advanceRatio` is printed by every caller and filed in the artifact instead.
 */
export function viewerPlaybackRefusal(result: BrowserArmResult): string | null {
  if (!result.instrumentSound) {
    return (
      'the browser was not a usable instrument for this run, so its figures are properties of the ' +
      `harness rather than of the product: ${result.instrumentFailures.join('; ') || 'no reason recorded'}`
    );
  }

  if (result.fatalErrors > 0) {
    return `the player raised ${result.fatalErrors} fatal error(s), so the picture stopped for good rather than stuttering`;
  }

  // ⛔ Before the progress check below, because it is the more specific account of the same silence.
  // A run that never played reports zero rebuffers, zero fatal errors and no resolution at all, which
  // is the same shape as a perfect one on every field but this one.
  if (result.resolutions.length === 0) {
    return (
      'the player never reported a resolution, so nothing was decoded and its zero rebuffers and zero ' +
      'errors are the silence of a viewer who saw no picture rather than the record of a good one'
    );
  }

  // The floor is zero rather than a share of the wall clock: a picture that decoded a first frame and
  // then sat on it for the whole watch is the one outcome here that means the feature did not work.
  if (result.advanceRatio <= 0) {
    return (
      'playback never moved forward across the whole watch, so the viewer decoded a frame and then sat ' +
      `on it (${result.rebufferCount} rebuffers over ${result.samples} samples)`
    );
  }

  return null;
}

interface Weeb3ArmExpectation {
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
      "the other condition and nothing about it is a reading of a node in the viewer's own tab"
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

/**
 * The multiplication sign the client renders between the two numbers.
 *
 * ⛔ U+00D7, not the letter x. `useHlsQoeMetrics` builds the string as `${videoWidth}×${videoHeight}`,
 * so a ladder expectation assembled with an ASCII x matches nothing and passes every run, which is
 * the same silence this check exists to remove.
 */
const RESOLUTION_SEPARATOR = /[x×]/;

/** `1280×720` and `1280x720` are the same resolution, whichever separator produced them. */
function normaliseResolution(resolution: string): string {
  return resolution.trim().split(RESOLUTION_SEPARATOR).join('×');
}

/**
 * Why the quality this viewer received is not one the deployment configured, or null.
 *
 * ⛔⛔ **Phase 1 of `docs/e2e-viewer-coverage-plan.md`.** Every watching suite already captured the
 * resolutions a viewer passed through and printed them under "observed, not asserted". A viewer
 * silently riding a rung nobody configured therefore passed every test, on a reading that was
 * already being taken.
 *
 * ⭐ **It asks whether the rung is one the ladder declares, never which one.** Which rung a player
 * settles on is its own adaptive decision, and pinning it here would be a performance threshold
 * wearing a correctness coat. Owner rule of 2026-08-29: these suites check that the feature works,
 * not how well.
 *
 * ⚠️ **It cannot catch a failure to switch.** A viewer pinned to one legitimate rung for an entire
 * watch passes this, and that is exactly what V2 is for.
 *
 * @param ladder Every resolution `ABR_LADDER` declares, as `cfg.abrLadderResolutions`. Empty on a
 *   single-rendition deployment, where there is no ladder to be outside of and this says nothing.
 */
export function ladderResolutionRefusal(result: BrowserArmResult, ladder: readonly string[]): string | null {
  if (ladder.length === 0 || result.resolutions.length === 0) {
    return null;
  }

  const declared = new Set(ladder.map(normaliseResolution));
  const strangers = result.resolutions.filter((seen) => !declared.has(normaliseResolution(seen)));
  if (strangers.length === 0) {
    return null;
  }

  return (
    `this viewer was served ${strangers.join(', ')}, which the deployment's ladder does not declare ` +
    `(it declares ${ladder.join(', ')}), so they watched a quality nobody configured`
  );
}
