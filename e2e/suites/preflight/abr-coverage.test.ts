import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { abrCoverageRefusal } from '../../src/abrCoverage.js';
import { loadConfig } from '../../src/config.js';

/**
 * Preflight — the run must be unambiguous about whether it covered the ABR ladder.
 *
 * ⛔ What this is here to stop, measured 2026-08-27. Both ABR suites are gated on `ABR_ENABLED`,
 * which is `false` in `.env.sample` and unset in every profile on the bench host. Run them as they
 * stand and `node --test` prints `# tests 0`, `# fail 0`, `# skipped 0` and exits 0: a skipped suite
 * reaches no column at all, not even the skipped one. So the summary of a sitting that never
 * transcoded a rung is indistinguishable from the summary of one that exercised all four, and the
 * difference is a paid sitting.
 *
 * Unlike the ABR suites this reads no rung and dials no host, so it costs nothing and refuses while
 * the stack is still cold. It sorts ahead of the chequebook preflight, which means a misdeclared run
 * stops before anything is asked of the deployment at all.
 *
 * **This one never skips.** A preflight that can skip has the defect it was written to catch.
 *
 * The verdict lives in `src/abrCoverage.ts` because nothing under `suites/` runs in CI. Its rules are
 * covered by `test/abrCoverage.test.ts` and therefore by `pnpm verify`, leaving this file as wiring
 * and a failure message.
 */
/**
 * Read at module scope, not inside the `describe`, and that placement is the point.
 *
 * `node --test` counts and exit-codes `it()` cases only. A throw inside a `describe` callback prints
 * `not ok` and is still reported as `# fail 0` with exit 0, even in a multi-file run beside passing
 * suites (measured 2026-08-27). A misspelt `E2E_EXPECT_ABR` would therefore be waved through by the
 * very gate that reads it. Thrown during import instead, it fails the file and the run.
 */
const cfg = loadConfig();

describe('preflight — the run says which renditions it covers', () => {
  it('covers the ladder, or declares that it does not', () => {
    const ladder = cfg.abrEnabled ? `ladder of ${cfg.abrRungs.length}: ${cfg.abrRungs.join(', ')}` : 'off';
    console.log(`  ABR_ENABLED: ${cfg.abrEnabled} (${ladder}), declared: ${cfg.abrExpectation}`);

    const refusal = abrCoverageRefusal({
      expectation: cfg.abrExpectation,
      enabled: cfg.abrEnabled,
      rungs: cfg.abrRungs,
    });

    if (refusal === null) {
      return;
    }

    assert.fail(
      `${refusal}\n` +
        `Nothing has been run and nothing on the deployment was touched. E2E_EXPECT_ABR can go in ` +
        `this profile's env alongside E2E_SSH_TARGET, so a deployment declares itself once:\n` +
        cfg.envFiles.map((path) => `  ${path}`).join('\n'),
    );
  });
});
