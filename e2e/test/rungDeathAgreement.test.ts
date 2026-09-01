import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT_DIR } from '../src/config.js';

/**
 * The player and the master must agree about when a rung has stopped.
 *
 * Two copies of one rule exist on purpose. `packages/client/.../feedState.ts` decides when a viewer
 * leaves a rung, and `packages/stream-uploader/src/libs/LadderLiveness.ts` decides when the master
 * stops advertising it. The uploader's is a deliberate port rather than a second invention, because
 * the client's took eight attempts and three of the failures shipped.
 *
 * ⛔ Both files say in prose that if one constant moves the other must move with it, and until
 * 2026-09-01 that sentence was the whole of the enforcement. Disagreement is not a crash: the master
 * would go on naming a rung the player had already left, or drop one the player was still happily
 * watching, and either reads as a viewer-side fault a long way from the number that caused it.
 *
 * Read out of the source rather than imported. e2e must not reach past a package boundary into
 * another package's internals, and the client is a browser package this runner cannot load anyway.
 * Same mirror-and-prove arrangement as `logLevel.test.ts` against the uploader's call sites and
 * `ports.test.ts` against `_lib.sh`.
 */

const CONSTANT = 'RUNG_DEATH_LAG_SEGMENTS';

const SOURCES = {
  'the player, which decides when a viewer leaves a rung': join(
    ROOT_DIR,
    'packages',
    'client',
    'src',
    'components',
    'SwarmHlsPlayer',
    'feedState.ts',
  ),
  'the uploader, which decides what the master advertises': join(
    ROOT_DIR,
    'packages',
    'stream-uploader',
    'src',
    'libs',
    'LadderLiveness.ts',
  ),
} as const;

/** The declared value, or null when the constant is not declared in that file at all. */
function declaredValue(path: string): number | null {
  const found = new RegExp(`${CONSTANT}\\s*(?::\\s*number)?\\s*=\\s*(\\d+)`).exec(readFileSync(path, 'utf8'));
  return found ? Number(found[1]) : null;
}

describe('the player and the master agree about when a rung has stopped', () => {
  for (const [whose, path] of Object.entries(SOURCES)) {
    it(`finds ${CONSTANT} declared in ${whose}`, () => {
      assert.notEqual(
        declaredValue(path),
        null,
        `${CONSTANT} is not declared in ${path}. Either it was renamed, in which case rename it here ` +
          'too, or one side stopped using segment lag to judge a rung, which is a change this test ' +
          'exists to make someone look at rather than a rename.',
      );
    });
  }

  it('reads the same number on both sides', () => {
    const [player, uploader] = Object.values(SOURCES).map(declaredValue);

    assert.equal(
      player,
      uploader,
      `${CONSTANT} is ${player} in the player and ${uploader} in the uploader. They must match, or the ` +
        'master will advertise a rung the viewer has already left, or drop one the viewer is still ' +
        'watching. Neither shows up as an error: it shows up as a viewer-side fault a long way from ' +
        'the number that caused it.',
    );
  });
});
