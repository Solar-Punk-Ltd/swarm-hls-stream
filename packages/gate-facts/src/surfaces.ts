/**
 * The lens catalogue's surfaces, as path predicates.
 *
 * The review gate selects lenses by surface and caps a pull request at one, so the surface list is a
 * fact about a diff rather than a judgement about it. Deriving it here is what makes that cap
 * checkable: self-classifying it in a comment nobody audits is how the first version of the rule
 * failed.
 */
/**
 * Ordered most specific first, because a path belongs to the first surface that claims it and
 * several of these overlap. Location beats filename: `packages/x/test/a.config.ts` is a test rather
 * than a config, and `deploy/test/clean.test.js` is the deploy surface rather than the test one.
 */
const SURFACE_MATCHERS: ReadonlyArray<{ surface: string; matches: (path: string) => boolean }> = [
  { surface: 'protocol', matches: (p) => p.startsWith('docs/reviews/') },
  { surface: 'ci', matches: (p) => p.startsWith('.github/') },
  { surface: 'deploy', matches: (p) => p.startsWith('deploy/') || p.startsWith('engines/') },
  { surface: 'tests', matches: (p) => /(^|\/)test\//.test(p) },
  { surface: 'src', matches: (p) => /(^|\/)src\//.test(p) },
  {
    surface: 'config',
    matches: (p) =>
      /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|\.eslintrc\.cjs|\.gitignore|.*\.config\.(json|ts|js|mjs))$/.test(
        p,
      ),
  },
  { surface: 'docs', matches: (p) => p.endsWith('.md') },
];

/** Every surface the given paths touch, in catalogue order, without duplicates. */
export function surfacesTouched(paths: readonly string[]): string[] {
  const found = new Set<string>();
  for (const path of paths) {
    for (const { surface, matches } of SURFACE_MATCHERS) {
      if (matches(path)) {
        found.add(surface);
        // Counting one path under two surfaces would inflate a cap that is measured in surfaces.
        break;
      }
    }
  }
  return SURFACE_MATCHERS.map((m) => m.surface).filter((s) => found.has(s));
}

/**
 * Whether the mutation check applies, is unavailable, or is genuinely not applicable.
 *
 * Three states rather than two, because "no runner exists for this package" and "there is no source
 * here at all" are different facts and only the second one means the check was not owed.
 */
export type MutationApplicability = 'applies' | 'unavailable' | 'not-applicable';

/** The one package the Stryker harness covers. Anything else with a `src/` reports as unavailable. */
const MUTATION_COVERED_PACKAGE = 'packages/stream-uploader/';

export function mutationApplicability(paths: readonly string[]): MutationApplicability {
  const sourceOrTest = paths.filter((p) => /(^|\/)(src|test)\//.test(p));
  if (sourceOrTest.length === 0) {
    return 'not-applicable';
  }
  return sourceOrTest.some((p) => p.startsWith(MUTATION_COVERED_PACKAGE)) ? 'applies' : 'unavailable';
}
