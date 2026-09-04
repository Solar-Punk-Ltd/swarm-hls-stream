import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT_DIR } from '../src/config.js';
import { MAX_WEEB3_SEGMENT_REQUESTS } from '../src/harness/crashArm.js';

/**
 * Every viewer suite has to mean the same thing by "the node served the video".
 *
 * ## What the number is, in one sentence
 *
 * The most gateway segment requests an in-tab arm may make across a whole run before the harness
 * refuses to file it as an in-tab reading at all.
 *
 * ## ⛔⛔ Why a copy of it is dangerous rather than untidy
 *
 * An in-tab arm's headline is that it made almost no `/bytes/` requests, and a client that never
 * loaded a node at all produces the same near-zero. This ceiling is the whole of what separates
 * "the node served the video" from "the gateway did", so a suite carrying a looser copy files a
 * gateway reading under an in-tab label, and one carrying a tighter copy refuses a correct arm.
 * Neither shows up as an error. Both show up as a number in an artifact.
 *
 * ## ⛔⛔⛔ And why nothing else would catch it
 *
 * Nothing under `e2e/suites/` runs in continuous integration. Those files are only executed by a
 * paid broadcast, so a copy drifting is invisible until an arm passes that should have refused, and
 * the sitting that finds out has already been bought. This test is under `e2e/test/`, which
 * `pnpm verify` runs and which costs nothing.
 *
 * Read out of the source rather than imported: a suite file registers its tests at import time and
 * expects a deployment. Same mirror-and-prove arrangement as `rungDeathAgreement.test.ts` for the
 * two rung-death limits and `logLevel.test.ts` for the uploader's own call sites.
 */

const CONSTANT = 'MAX_WEEB3_SEGMENT_REQUESTS';

/**
 * Where the ceiling is declared, and what each one is for.
 *
 * The harness holds the one every scenario arm imports. The three viewer suites declare their own
 * because each has a paragraph of its own about why its watch does not need a looser one, and that
 * reasoning is worth keeping next to the suite it is about. What is not worth keeping is the freedom
 * for the numbers to differ.
 */
const DECLARED_IN = {
  'the harness, which every crash and rung arm imports': join('src', 'harness', 'crashArm.ts'),
  'V1, a viewer watching a live broadcast': join('suites', 'viewer', 'live-playback.test.ts'),
  'V4, a viewer playing a recording back': join('suites', 'viewer', 'vod-playback.test.ts'),
  'V5, a viewer watching a broadcast end': join('suites', 'viewer', 'broadcast-ended.test.ts'),
} as const;

/** The declared value of the ceiling in one file, or null where it is not declared there at all. */
function declaredValue(path: string): number | null {
  const source = readFileSync(join(ROOT_DIR, 'e2e', path), 'utf8');
  const found = new RegExp(`${CONSTANT}\\s*(?::\\s*number)?\\s*=\\s*(\\d+)`).exec(source);
  return found === null ? null : Number(found[1]);
}

describe('every suite agrees how many gateway reads an in-tab arm may make', () => {
  for (const [whose, path] of Object.entries(DECLARED_IN)) {
    it(`finds ${CONSTANT} declared in ${whose}`, () => {
      assert.notEqual(
        declaredValue(path),
        null,
        `${CONSTANT} is not declared in e2e/${path}. Either it was renamed, in which case rename it ` +
          'here too, or that suite stopped bounding its gateway reads, which is a change this test ' +
          'exists to make someone look at rather than a rename.',
      );
    });
  }

  it('reads the same ceiling in all of them', () => {
    const disagreeing = Object.entries(DECLARED_IN)
      .map(([whose, path]) => [whose, declaredValue(path)] as const)
      .filter(([, value]) => value !== MAX_WEEB3_SEGMENT_REQUESTS);

    assert.deepEqual(
      disagreeing,
      [],
      `these declare a different ceiling from the harness's ${MAX_WEEB3_SEGMENT_REQUESTS}: ` +
        `${disagreeing.map(([whose, value]) => `${whose} says ${value}`).join(', ')}. A looser copy ` +
        'files a gateway reading under an in-tab label and a tighter one refuses a correct arm, and ' +
        'neither is visible until a paid broadcast has already been spent.',
    );
  });

  /**
   * ⛔ Pinned to single digits rather than only to each other, because "they all say 40" would
   * satisfy the equality above. The gap this sits inside is what makes it mean anything: every
   * weeb-3 arm of the 2026-08-27 matrix made 8 or 9 against the gateway control's 366 in the same
   * sitting, and V4's own control was 61, which is the narrowest gap any of these has to fit in.
   */
  it('stays in single digits, which is the boundary the measured gap supports', () => {
    assert.ok(
      MAX_WEEB3_SEGMENT_REQUESTS > 0 && MAX_WEEB3_SEGMENT_REQUESTS < 10,
      `the ceiling is ${MAX_WEEB3_SEGMENT_REQUESTS}. An arm reads through the gateway while its own ` +
        'node boots, so the honest figure is a handful rather than a zero, and a ceiling loose enough ' +
        'to admit a recording served half from the gateway would pass an arm that proves nothing.',
    );
  });
});
