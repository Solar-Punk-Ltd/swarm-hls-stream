import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where `pnpm-workspace.yaml` says packages live. Kept as a literal because reading YAML to find two globs is worse. */
const WORKSPACE_ROOTS = ['packages', '.'] as const;
const STANDALONE_PACKAGES = ['deploy'] as const;

function hasTestScript(packageJsonPath: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
    return typeof manifest.scripts?.test === 'string';
  } catch {
    return false;
  }
}

/**
 * Every workspace directory that has a `test` script, as `pnpm -r` prefixes it in its output.
 *
 * This exists to answer "which package did not report", which is a question the test output alone
 * cannot answer. A parser that only reads what was printed cannot distinguish a package that ran
 * clean from one whose totals never arrived, and this repository has the second case: the uploader
 * runs with `--test-force-exit`, which calls `process.exit()` and truncates pending stdout writes to
 * a pipe, so its summary is lost whenever pnpm pipes it. The largest suite in the workspace was
 * silently absent from the artifact until this cross-check named it.
 */
export function packagesWithTests(repoRoot: string): string[] {
  const found: string[] = [];

  for (const root of WORKSPACE_ROOTS) {
    if (root === '.') {
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(join(repoRoot, root));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (hasTestScript(join(repoRoot, root, entry, 'package.json'))) {
        found.push(`${root}/${entry}`);
      }
    }
  }

  for (const standalone of STANDALONE_PACKAGES) {
    if (hasTestScript(join(repoRoot, standalone, 'package.json'))) {
      found.push(standalone);
    }
  }

  return found.sort();
}

/** The packages that were supposed to report a total and did not. */
export function packagesMissingTotals(expected: readonly string[], reported: readonly string[]): string[] {
  const seen = new Set(reported);
  return expected.filter((p) => !seen.has(p));
}
