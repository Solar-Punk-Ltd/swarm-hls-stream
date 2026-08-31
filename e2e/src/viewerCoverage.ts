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
  /** `E2E_BROWSER_REPO_DIR`, the host path the browser container bind-mounts as `/repo`. */
  repoDir: string;
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
export function viewerCoverageRefusal({ expectation, backend, repoDir }: ViewerCoverage): string | null {
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

  // ⛔⛔⛔ Measured 2026-08-30: this preflight went green, sixteen suites then published for twelve
  // minutes and passed, and every viewer suite failed on `browserArmHostSetup` because this one
  // variable was unset. 0.61 BZZ of broadcast to discover an empty string. The gate above asks
  // whether the run DECLARED a viewer and never asked whether it could launch one, which is the
  // same defect one layer up that this whole module exists to catch.
  if (expectation === 'browser' && repoDir.trim() === '') {
    return (
      'This run asked for a real viewer and set no E2E_BROWSER_REPO_DIR, so no viewer suite can ' +
      'launch a browser at all: every one of them would reach `browserArmHostSetup` and throw, ' +
      'after the paid suites ahead of them had already published. It is the absolute path of the ' +
      'bench checkout ON THE HOST, the directory deploy/scripts/bench-on-host.sh rsyncs to, because ' +
      'the browser container bind-mounts it as /repo and nothing inside a mount can work out where ' +
      'it came from.'
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

/**
 * The gate a viewer suite opens with: stop an ambiguous run, or say why this one skips.
 *
 * ⛔ `repoDir` is required rather than defaulted off `process.env`. The deployment declares it in the
 * profile's env file, which only `loadConfig` reads, so a default that reached past the config made a
 * value declared exactly where the refusal says to put it invisible to the gate that asks for it.
 *
 * Called at module scope so an undeclared run fails the file during import. A throw inside a
 * `describe` callback prints `not ok` and is still reported as `# fail 0` with exit 0, which is the
 * defect this whole module exists for, one level down.
 */
export function viewerGate(
  expectation: ViewerExpectation,
  backend: ByteSource | null,
  repoDir: string,
): string | false {
  const refusal = viewerCoverageRefusal({ expectation, backend, repoDir });
  if (refusal !== null) {
    throw new Error(refusal);
  }
  return viewerSkipReason(expectation);
}

/**
 * The byte source a viewer suite is a reading of, once the gate has let the run through.
 *
 * Reached only from inside a case that is running, which by then means the expectation was `browser`
 * and {@link viewerCoverageRefusal} has already established there is one. The throw is here so the
 * type says so as well, and so a future change that let a null through fails loudly rather than
 * filing a verdict against an unnamed condition.
 */
export function requireByteSource(backend: ByteSource | null): ByteSource {
  if (backend === null) {
    throw new Error(
      'a viewer case ran with no byte source named, which the coverage gate should have refused. ' +
        'Set BROWSER_FETCH_BACKEND, and treat this message as a defect in the gate rather than in the run.',
    );
  }
  return backend;
}
