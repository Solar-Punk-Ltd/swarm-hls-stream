import { describe, run } from './run.js';
import { mutationApplicability, surfacesTouched } from './surfaces.js';
import type { FactGroup } from './types.js';

/** Sum the added and removed line counts `git diff --numstat` reports for the given paths. */
function totalLines(numstat: string): number {
  let total = 0;
  for (const line of numstat.split('\n')) {
    const [added, removed] = line.split('\t');
    // A binary file reports "-" for both counts, which is not a line count and must not become NaN.
    if (Number.isFinite(Number(added))) {
      total += Number(added);
    }
    if (Number.isFinite(Number(removed))) {
      total += Number(removed);
    }
  }
  return total;
}

/**
 * The facts the diff-size ceiling and the mutation trigger are both decided on.
 *
 * Both rules used to be settled by the author's own description of their own change, which is the
 * shape of claim this whole artifact exists to remove.
 */
export async function collectDiff(base: string, head: string): Promise<FactGroup> {
  const range = `${base}..${head}`;
  const namesArgs = ['diff', '--name-only', range];
  const names = await run('git', namesArgs);
  const paths = names.stdout.split('\n').filter((p) => p.length > 0);

  const srcArgs = ['diff', '--numstat', range, '--', '*/src/*'];
  const srcStat = await run('git', srcArgs);

  const commitsArgs = ['rev-list', '--count', range];
  const commits = await run('git', commitsArgs);

  const surfaces = surfacesTouched(paths);
  const mutation = mutationApplicability(paths);

  return {
    title: 'Diff',
    facts: [
      { key: 'files changed', value: String(paths.length), command: describe('git', namesArgs) },
      { key: 'commits', value: commits.stdout.trim() || 'unknown', command: describe('git', commitsArgs) },
      { key: 'src lines changed', value: String(totalLines(srcStat.stdout)), command: describe('git', srcArgs) },
      {
        key: 'surfaces touched',
        value: surfaces.length > 0 ? `${surfaces.length} (${surfaces.join(', ')})` : 'none',
        command: describe('git', namesArgs),
      },
      {
        key: 'mutation check',
        value: mutation,
        command: describe('git', namesArgs),
      },
    ],
  };
}
