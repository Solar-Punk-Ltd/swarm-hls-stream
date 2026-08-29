import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runProfile } from '../../src/config.js';
import { describeRunProfile, runProfileRefusal } from '../../src/profiles.js';

/**
 * Preflight: the run is the run the profile says it is.
 *
 * A run profile is a saved, named set of the env values that decide what a sitting IS: where the
 * segment bytes come from, and what the run claims to cover. `in-browser` is the default and reads
 * bytes from a Swarm node in the viewer's own tab. `light-client` reads them through a gateway.
 *
 * This checks only what can be settled with no network and no deployment: a declaration no parser
 * accepts, and a run that declared nothing. It costs nothing and refuses while the stack is cold.
 * Whether the deployment can deliver what the profile asks for is a live question and is not asked
 * here.
 *
 * **This one never skips.** A preflight that can skip has the defect it was written to catch.
 *
 * The verdict lives in `src/profiles.ts` because nothing under `suites/` runs in CI. Its rules are
 * covered by `test/profiles.test.ts` and therefore by `pnpm verify`, leaving this file as wiring and
 * a failure message.
 */
/**
 * Read at module scope, and that placement is the point.
 *
 * `node --test` counts and exit-codes `it()` cases only. A throw inside a `describe` callback prints
 * `not ok` and is still reported as `# fail 0` with exit 0, even in a multi-file run beside passing
 * suites. Importing `config.js` is what applies the profile, so an unknown profile name throws
 * during import and fails the file rather than being waved through.
 */
const refusal = runProfileRefusal({
  byteSource: process.env.BROWSER_FETCH_BACKEND,
  abrExpectation: process.env.E2E_EXPECT_ABR,
  segmentSeconds: process.env.E2E_EXPECT_SEGMENT_S,
});

describe('preflight: the run is the profile it says it is', () => {
  it('agrees with what it declared, before anything is asked of the deployment', () => {
    console.log(`  ${describeRunProfile(runProfile)}`);

    if (refusal === null) {
      return;
    }

    assert.fail(
      `${refusal}\n` +
        'Nothing has been run and nothing on the deployment was touched. This run reads ' +
        `${runProfile.path}, and a value already exported beats that file by design, so check the ` +
        'environment before the file:\n' +
        (runProfile.skipped.length === 0
          ? '  the environment overrode nothing\n'
          : runProfile.skipped
              .map((key) => `  the environment set ${key}, so the profile stood down on it`)
              .join('\n') + '\n'),
    );
  });
});
