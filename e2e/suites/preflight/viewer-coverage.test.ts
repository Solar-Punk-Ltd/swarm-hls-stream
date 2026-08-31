import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { loadConfig } from '../../src/config.js';
import { viewerCoverageRefusal } from '../../src/viewerCoverage.js';

/**
 * Preflight — the run must be unambiguous about whether a real browser watched the broadcast.
 *
 * ⛔ Every viewer leg of this suite was an HTTP poll until the viewer suites arrived, so nothing under
 * `suites/` had ever opened a player. Now that some do, they can skip, and a skipped suite reaches no
 * column at all: `node --test` prints `# tests 0`, `# fail 0`, `# skipped 0` and exits 0. The summary
 * of a sitting where nobody watched is then character-for-character the summary of one where a real
 * Chrome played the broadcast for four minutes, and that difference is the only evidence this project
 * has about what a viewer gets.
 *
 * Unlike the viewer suites this launches no browser and dials no host, so it costs nothing and
 * refuses while the stack is still cold.
 *
 * **This one never skips.** A preflight that can skip has the defect it was written to catch.
 *
 * The verdict lives in `src/viewerCoverage.ts` because nothing under `suites/` runs in CI. Its rules
 * are covered by `test/viewerCoverage.test.ts` and therefore by the unit run, leaving this file as
 * wiring and a failure message.
 */
/**
 * Read at module scope, not inside the `describe`, for the reason `abr-coverage.test.ts` records: a
 * throw inside a `describe` callback prints `not ok` and is still reported as `# fail 0` with exit 0.
 * A misspelt `E2E_EXPECT_BROWSER` or `BROWSER_FETCH_BACKEND` would therefore be waved through by the
 * very gate that reads it. Thrown during import instead, it fails the file and the run.
 */
const cfg = loadConfig();
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);

describe('preflight — the run says whether a real viewer watched', () => {
  it('opens a player, or declares that it does not', () => {
    console.log(`  declared: ${cfg.viewerExpectation}, byte source: ${backend ?? 'the build default'}`);

    const refusal = viewerCoverageRefusal({
      expectation: cfg.viewerExpectation,
      backend,
      repoDir: cfg.browserRepoDir,
    });

    if (refusal === null) {
      return;
    }

    assert.fail(
      `${refusal}\n` +
        'Nothing has been run and nothing on the deployment was touched. E2E_EXPECT_BROWSER can go in ' +
        "this profile's env alongside E2E_SSH_TARGET, so a deployment declares itself once:\n" +
        cfg.envFiles.map((path) => `  ${path}`).join('\n') +
        '\nBROWSER_FETCH_BACKEND names the arm and belongs in the environment of the run, not in a ' +
        'profile, because it is what the run is a reading of rather than what the deployment is.',
    );
  });
});
