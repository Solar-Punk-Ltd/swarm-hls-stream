/**
 * Whether a run is honest about which renditions it covered.
 *
 * ⛔ The problem this exists for, measured 2026-08-27 against the two ABR suites as merged. Both are
 * gated on `ABR_ENABLED`, which is `false` in `.env.sample` and unset in every profile on the bench
 * host, so both skip. `node --test` reports a skipped *suite* as `# tests 0`, `# fail 0` and
 * `# skipped 0`, exit 0. The seven ABR cases reach no column at all, so the summary of a run that
 * never touched the ladder is character-for-character the summary of one that did.
 *
 * A warning printed at that point would scroll past twenty other suites. So the ambiguous run stops.
 * A single-rendition deployment is still a legitimate thing to run and declares itself once, with
 * `E2E_EXPECT_ABR=false`, after which the gate never asks again.
 *
 * The verdict is here rather than in the preflight because nothing under `suites/` runs in CI. This
 * file is reached by `test/abrCoverage.test.ts`, so the gate's own logic is covered by `pnpm verify`
 * and the preflight is left with nothing but the wiring.
 */

/** What the operator said this run is for, out of `E2E_EXPECT_ABR`. */
export type AbrExpectation = 'ladder' | 'single' | 'undeclared';

/** Not exported: the shape is an argument, and exporting it would add a name nothing else needs. */
interface AbrCoverage {
  expectation: AbrExpectation;
  enabled: boolean;
  rungs: readonly string[];
}

/** A ladder needs a second rung before a missing one is distinguishable from a present one. */
const MIN_LADDER_RUNGS = 2;

/**
 * `E2E_EXPECT_ABR` as an expectation, refusing a spelling it does not know.
 *
 * The accepted words are the ones `ABR_ENABLED` itself accepts, so an operator setting both does not
 * have to remember two vocabularies. A typo throws rather than reading as undeclared, because that
 * would silently turn an operator who did declare into one who did not, on the exact run they were
 * being careful about.
 */
export function readAbrExpectation(raw: string): AbrExpectation {
  const value = raw.trim();

  if (value === '') {
    return 'undeclared';
  }
  if (value === 'true' || value === '1') {
    return 'ladder';
  }
  if (value === 'false' || value === '0') {
    return 'single';
  }

  throw new Error(`E2E_EXPECT_ABR must be one of true, 1, false, 0, or unset. Got '${raw}'.`);
}

/**
 * Why this run must not proceed, or `null` when what it will cover matches what it claims.
 *
 * The caller adds the deployment's own env file paths to the reason, which this cannot know.
 */
export function abrCoverageRefusal({ expectation, enabled, rungs }: AbrCoverage): string | null {
  // First, because it is wrong however the run was declared, and because both ABR suites assert the
  // same thing in their own setup. Catching it here turns a timeout part-way through a paid sitting
  // into a refusal before the first frame is published.
  if (enabled && rungs.length < MIN_LADDER_RUNGS) {
    return (
      `ABR_ENABLED is on but ABR_LADDER names ${rungs.length} rung${rungs.length === 1 ? '' : 's'} ` +
      `(${rungs.join(', ') || 'none'}). A ladder needs at least ${MIN_LADDER_RUNGS} rungs before a ` +
      'rung going missing is visible, so the ABR suites would assert nothing. Name the full ladder ' +
      'explicitly rather than leaving the engine to its default, which the suite cannot read.'
    );
  }

  if (expectation === 'ladder' && !enabled) {
    return (
      'This run asked for ABR coverage and this deployment has ABR_ENABLED off, so both ABR suites ' +
      'would skip and the summary would not say so. Set ABR_ENABLED=true and redeploy, or drop ' +
      'E2E_EXPECT_ABR=true if the ladder is not what you meant to test.'
    );
  }

  if (expectation === 'single' && enabled) {
    return (
      'This run declared itself single-rendition and this deployment has ABR_ENABLED on, so the ' +
      'engine will transcode a ladder underneath it. Every timing and cost figure the run produces ' +
      'would be a ladder measured under a single stream label, which is a wrong number rather than ' +
      'a missing one. Set E2E_EXPECT_ABR=true, or turn ABR_ENABLED off and redeploy.'
    );
  }

  if (expectation === 'undeclared' && !enabled) {
    return (
      'This deployment has ABR_ENABLED off, so the ABR suites will skip and leave no trace in the ' +
      'run summary: a skipped suite reports as zero tests rather than as skipped ones. Say which ' +
      'run this is. E2E_EXPECT_ABR=false runs single-rendition on purpose and is never asked ' +
      'again. E2E_EXPECT_ABR=true refuses until ABR_ENABLED=true is deployed.'
    );
  }

  return null;
}
