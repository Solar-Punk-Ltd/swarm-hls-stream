/**
 * Whether a run is honest about whether a real browser watched the broadcast.
 *
 * ⛔ The defect this exists for is `abrCoverage`'s, one layer over, and it is worse here. Every viewer
 * leg of this suite was an HTTP poll until now, so nothing under `suites/` had ever opened a player.
 * A viewer suite that skips reports as `# tests 0`, `# fail 0`, `# skipped 0`, exit 0: the summary of
 * a run where nobody watched the broadcast is character-for-character the summary of one where a real
 * Chrome played it for four minutes. That difference is the whole reason these suites exist, and it
 * would be invisible in the only artefact an operator reads.
 *
 * A browser-less run is still a legitimate thing to run. It declares itself once, with
 * `E2E_EXPECT_BROWSER=false`, and the gate never asks again.
 *
 * ⭐ The byte source is part of the declaration rather than a detail of it. `BROWSER_FETCH_BACKEND`
 * unset means "whatever the build defaults to", so a viewer verdict filed without it is a reading of
 * an arm nobody chose. `byteSourceFromEnv` already refuses a typo, which leaves the silence.
 *
 * The verdict lives here rather than in the suites because nothing under `suites/` runs in CI. This
 * file is reached by `test/viewerCoverage.test.ts`, so the gate's own logic is covered by the unit
 * run and the suites are left with the wiring.
 */

import { type ByteSource, GATEWAY_BYTES, WEEB3_BYTES } from './browser/fetchBackendSweep.js';

/** What the operator said this run is for, out of `E2E_EXPECT_BROWSER`. */
export type ViewerExpectation = 'browser' | 'none' | 'undeclared';

/** Not exported: the shape is an argument, and exporting it would add a name nothing else needs. */
interface ViewerCoverage {
  expectation: ViewerExpectation;
  /** The byte source the run named, or null where it named none. */
  backend: ByteSource | null;
}

/**
 * `E2E_EXPECT_BROWSER` as an expectation, refusing a spelling it does not know.
 *
 * The accepted words are `E2E_EXPECT_ABR`'s, so an operator setting both does not have to remember
 * two vocabularies. A typo throws rather than reading as undeclared, because that would silently turn
 * an operator who did declare into one who did not, on the exact run they were being careful about.
 */
export function readViewerExpectation(raw: string): ViewerExpectation {
  const value = raw.trim();

  if (value === '') {
    return 'undeclared';
  }
  if (value === 'true' || value === '1') {
    return 'browser';
  }
  if (value === 'false' || value === '0') {
    return 'none';
  }

  throw new Error(`E2E_EXPECT_BROWSER must be one of true, 1, false, 0, or unset. Got '${raw}'.`);
}

/** Why this run must not proceed, or `null` when what it will cover matches what it claims. */
export function viewerCoverageRefusal({ expectation, backend }: ViewerCoverage): string | null {
  if (expectation === 'undeclared') {
    return (
      'This run has not said whether a real browser should watch the broadcast, so the viewer suites ' +
      'would skip and leave no trace in the run summary: a skipped suite reports as zero tests rather ' +
      'than as skipped ones. Say which run this is. E2E_EXPECT_BROWSER=false runs without a viewer on ' +
      'purpose and is never asked again. E2E_EXPECT_BROWSER=true opens a real player and refuses until ' +
      'the browser arm is wired.'
    );
  }

  if (expectation === 'browser' && backend === null) {
    return (
      'This run asked for a real viewer and named no byte source, so the arm would read segments from ' +
      `whatever the client build defaults to and the verdict would be filed against a condition nobody ` +
      `chose. Set BROWSER_FETCH_BACKEND to ${WEEB3_BYTES} for a Swarm node in the viewer's own tab, or ` +
      `to ${GATEWAY_BYTES} for the gateway, which is the control.`
    );
  }

  return null;
}

/**
 * Why a viewer suite is skipping, or `false` to run it.
 *
 * ⛔ Only ever a declared browser-less run. An undeclared one is stopped by
 * {@link viewerCoverageRefusal} before it reaches here, and returning a skip for it would be this
 * gate committing the defect it was written to catch.
 */
export function viewerSkipReason(expectation: ViewerExpectation): string | false {
  return expectation === 'none'
    ? 'E2E_EXPECT_BROWSER=false: this run declared itself browser-less, so no player watches the broadcast'
    : false;
}
