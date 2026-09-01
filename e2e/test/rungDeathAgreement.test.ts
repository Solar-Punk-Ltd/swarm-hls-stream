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

/**
 * How many rungs each side will act on at once. Owner ruling 2026-09-01, after a broadcast ending
 * made the player delete three rungs of four and hls.js go fatal.
 *
 * ⚠️ The two names differ on purpose. The player's removal is irreversible, so its limit is per
 * session; the uploader recomputes what to advertise on every delivery, so its limit is per
 * evaluation. Same number, different sentence, and they must not drift apart: a master that drops a
 * rung the player kept, or keeps one the player dropped, is a viewer-side fault a long way from the
 * number that caused it.
 */
const DROP_LIMITS = {
  'the player': ['packages/client/src/components/SwarmHlsPlayer/rungHealth.ts', 'MAX_RUNGS_DROPPED_PER_LADDER'],
  'the uploader': ['packages/stream-uploader/src/libs/LadderLiveness.ts', 'MAX_RUNGS_DROPPED_AT_ONCE'],
} as const;

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

/** The declared value of `name` in `path`, or null when it is not declared there at all. */
function declaredValueOf(path: string, name: string): number | null {
  const found = new RegExp(`${name}\\s*(?::\\s*number)?\\s*=\\s*(\\d+)`).exec(readFileSync(path, 'utf8'));
  return found ? Number(found[1]) : null;
}

function declaredValue(path: string): number | null {
  return declaredValueOf(path, CONSTANT);
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

describe('the player and the master agree how much of a ladder may be dropped at once', () => {
  for (const [whose, [file, name]] of Object.entries(DROP_LIMITS)) {
    it(`finds ${name} declared in ${whose}`, () => {
      assert.notEqual(
        declaredValueOf(join(ROOT_DIR, file), name),
        null,
        `${name} is not declared in ${file}. Either it was renamed, or one side stopped limiting how ` +
          'much of a ladder it will take apart, which is the failure this limit was ruled in to stop.',
      );
    });
  }

  it('reads the same number on both sides', () => {
    const [player, uploader] = Object.values(DROP_LIMITS).map(([file, name]) =>
      declaredValueOf(join(ROOT_DIR, file), name),
    );

    assert.equal(
      player,
      uploader,
      `the player will drop ${player} rung(s) and the master will drop ${uploader}. They must match, ` +
        'or the two disagree about which rungs exist and neither says so.',
    );
  });

  /**
   * ⛔ Pinned to the ruling rather than only to each other, because "both sides say 3" would satisfy
   * the equality above and is not what was decided.
   */
  it('is one, which is what the owner ruled on 2026-09-01', () => {
    for (const [whose, [file, name]] of Object.entries(DROP_LIMITS)) {
      assert.equal(
        declaredValueOf(join(ROOT_DIR, file), name),
        1,
        `${whose} would take ${declaredValueOf(join(ROOT_DIR, file), name)} rungs out of a ladder. The ` +
          'ruling was one: a second rung going quiet is a broadcast ending, not two rungs failing.',
      );
    }
  });
});
