/**
 * Ordered most specific first, because a path belongs to the first surface that claims it and
 * several of these overlap. Location beats filename: `packages/x/test/a.config.ts` is a test rather
 * than a config, and `deploy/test/clean.test.js` is the deploy surface rather than the test one.
 */
const SURFACE_MATCHERS: ReadonlyArray<{ surface: string; matches: (path: string) => boolean }> = [
  { surface: 'protocol', matches: (p) => p.startsWith('docs/reviews/') },
  { surface: 'ci', matches: (p) => p.startsWith('.github/') },
  { surface: 'deploy', matches: (p) => /^(deploy|engines|nodes)\//.test(p) },
  { surface: 'tests', matches: (p) => /(^|\/)test\//.test(p) },
  { surface: 'src', matches: (p) => /(^|\/)src\//.test(p) },
  {
    surface: 'config',
    matches: (p) =>
      // Dotfiles at any level, the manifests, and anything named like a config. The dotfile clause is
      // deliberately broad: 14 tracked files landed in no surface at all before it, and a path in no
      // bucket makes the diff ceiling read lower than it is.
      /(^|\/)\.[^/]+$/.test(p) ||
      /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|[^/]*\.config\.[^/]+)$/.test(p) ||
      /\.(ya?ml|cjs|mjs)$/.test(p),
  },
  { surface: 'docs', matches: (p) => /\.(md|txt)$/.test(p) || /(^|\/)LICENSE$/.test(p) },
  { surface: 'client-assets', matches: (p) => /\.(html|css|svg|png|ico|webmanifest)$/.test(p) },
];

/**
 * The bucket for a path no matcher claims.
 *
 * Reported rather than dropped. Silently classifying a path as nothing makes the surface count
 * smaller, and the surface count is what the diff ceiling binds on, so a gap in the catalogue would
 * quietly widen the cap instead of being noticed.
 */
const UNCLASSIFIED = 'unclassified';

/** Every surface the given paths touch, in catalogue order, without duplicates. */
export function surfacesTouched(paths: readonly string[]): string[] {
  const found = new Set<string>();
  for (const path of paths) {
    const matched = SURFACE_MATCHERS.find(({ matches }) => matches(path));
    // Counting one path under two surfaces would inflate a cap that is measured in surfaces.
    found.add(matched ? matched.surface : UNCLASSIFIED);
  }
  return [...SURFACE_MATCHERS.map((m) => m.surface), UNCLASSIFIED].filter((s) => found.has(s));
}

/**
 * Whether the mutation check applies, is unavailable, or is genuinely not applicable.
 *
 * Three states rather than two, because "no runner exists for this package" and "there is no source
 * here at all" are different facts and only the second one means the check was not owed.
 */
type MutationState = 'applies' | 'unavailable' | 'not-applicable';

interface MutationApplicability {
  state: MutationState;
  /**
   * Changed source the harness does not reach, even when `state` is `applies`.
   *
   * A diff touching both a covered package and another one used to report a bare `applies`, so a
   * reviewer ran the check, got a real score, and read it as covering the whole change.
   */
  uncovered: string[];
}

/**
 * The packages `pnpm mutate` reaches, which are the ones the `mutate` globs of `stryker.config.json`
 * name. Anything else with a `src/` is uncovered. `pnpm mutate:client` runs a separate config over
 * `packages/client` that this fact has never counted, so a client change reads as uncovered here.
 * A test holds this list to the config.
 */
const MUTATION_COVERED_PACKAGES = ['packages/stream-uploader/', 'packages/shared/'] as const;

/** Source and tests, by location, matching how the surface matchers classify the same paths. */
function isMutatableSource(path: string): boolean {
  return /(^|\/)(src|test)\//.test(path) && !/^(deploy|engines|nodes)\//.test(path);
}

export function mutationApplicability(paths: readonly string[]): MutationApplicability {
  const mutatable = paths.filter(isMutatableSource);
  if (mutatable.length === 0) {
    return { state: 'not-applicable', uncovered: [] };
  }
  const uncovered = mutatable.filter((p) => !MUTATION_COVERED_PACKAGES.some((pkg) => p.startsWith(pkg)));
  const covered = mutatable.length - uncovered.length;
  return { state: covered > 0 ? 'applies' : 'unavailable', uncovered };
}
