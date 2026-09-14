import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(PACKAGE_ROOT, '..', '..', 'node_modules', '.bin', 'tsx');
const IMPORT_ONLY = join(PACKAGE_ROOT, 'test', 'helpers', 'importOnly.ts');

/**
 * Everything a test file reaches by importing an engine, which is where the coupling lived.
 *
 * `registry.ts` imports both engines and `load.ts` imports the registry, so a test that names only
 * the loader still evaluates both. All four are listed rather than just the two leaves, because a
 * reader looking at a failure should see which layer introduced the read.
 */
const ENGINE_MODULES = ['src/engines/srs.js', 'src/engines/ome.js', 'src/engines/registry.js', 'src/engines/load.js'];

/**
 * The five variables `utils/config.ts` calls `required()` on, present and empty.
 *
 * Present and empty rather than absent, and the difference is what makes this test mean the same
 * thing on every machine. `utils/env.ts` runs `dotenv.config()` at import against the repository
 * root, so on a developer's machine an absent variable is filled in from a `.env` that CI does not
 * have, and the test would then prove different things in the two places, which is the exact defect
 * it exists to prevent. dotenv never overrides a variable that is already set, so an empty one stays
 * empty everywhere, and `required()` refuses it with "set but empty" wherever this runs.
 */
const BLANKED = {
  BEE_URL: '',
  STAMP: '',
  STREAM_KEY: '',
  STREAM_LIST_TOPIC: '',
  API_AUTH_TOKEN: '',
};

/** Imports one module in a fresh process whose five required variables are blank. */
function importInHostileEnv(specifier: string): { status: number | null; stderr: string } {
  const run = spawnSync(TSX, [IMPORT_ONLY, join(PACKAGE_ROOT, specifier)], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...BLANKED },
  });
  return { status: run.status, stderr: run.stderr ?? '' };
}

/**
 * That importing an engine costs nothing but the import.
 *
 * ⛔⛔⛔ Five test files once threw before a single test body ran, because every engine imported
 * `utils/config.ts` and that module built its exported object at module scope out of five
 * `required()` reads. The failure was invisible in the place it mattered and loud in the place it
 * did not: CI has no `.env`, so it failed there on every run for weeks with "Missing required env
 * var: BEE_URL", while the same suite was green on any laptop that had once configured a
 * deployment. A second session hit the other half of the same coupling on the same day, "Required
 * env var is set but empty: STAMP", because its `.env` carried a blank one.
 *
 * ⭐ A suite that passes only where an untracked file happens to exist reports nothing about the
 * tree, so the guard is here rather than in the five files: it fails whoever reintroduces the
 * import, in one place, naming the module that did it.
 *
 * What this does NOT assert is that a *factory* reads no environment. `createSrsEngineFromEnv` and
 * `createOmeEngineFromEnv` are supposed to: that is what "FromEnv" means, they are called once from
 * `index.ts`, and the tests that exercise them set their own variables first. The line is between
 * importing a module and calling into it.
 */
describe('importing an engine reads nothing the environment has to supply', () => {
  for (const specifier of ENGINE_MODULES) {
    it(`imports ${specifier} with every required variable blank`, () => {
      const run = importInHostileEnv(specifier);

      assert.equal(
        run.status,
        0,
        `importing ${specifier} failed with the five required variables blank, so something in its ` +
          `graph reads them at module scope:\n${run.stderr}`,
      );
    });
  }
});
