import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRYPOINT = join(ROOT, 'engines/srs/entrypoint.sh');
const COMPOSE = join(ROOT, 'deploy/docker-compose.yml');

/**
 * The real `aof_ratio_for` out of the real entrypoint, run in a shell.
 *
 * Taken from the script by name rather than copied here, the way the tuning
 * suite takes that script's own sed lines, so an edit there cannot leave this
 * passing against a function that no longer exists.
 */
function aofRatioFor(fragment, ceiling, explicit = '') {
  const script = readFileSync(ENTRYPOINT, 'utf8');
  const start = script.indexOf('aof_ratio_for() {');
  assert.notEqual(start, -1, 'the entrypoint defines no aof_ratio_for');
  const end = script.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'aof_ratio_for is not closed at the start of a line');
  const definition = script.slice(start, end + 3);

  const call = `${definition}\naof_ratio_for ${JSON.stringify(fragment)} ${JSON.stringify(ceiling)} ${JSON.stringify(
    explicit,
  )}`;
  return execFileSync('bash', ['-c', `set -e\n${call}`], { encoding: 'utf8' }).trim();
}

/** What SRS force-closes at: the pair, multiplied out, to three decimals. */
function ceilingOf(fragment, ceiling) {
  return Number((Number(fragment) * Number(aofRatioFor(fragment, ceiling))).toFixed(3));
}

describe('the length a segment is force-closed at', () => {
  /**
   * SRS takes a ratio and force-closes at `HLS_FRAGMENT * ratio`. Held as a
   * ratio, the ceiling scaled with a field the operator edits: the shipped pair
   * is 0.5 and 5.0, which is 2.5s, and moving the segment length to 2 in the
   * settings drawer took it to 10s with nothing anywhere saying so. Levi hit
   * exactly that on 2026-09-15, on a stream asking for 2s segments and getting
   * 2.067s to 10.033s. What the ceiling has to clear is a number of seconds,
   * `GOP + 0.135s` of constant overshoot, so seconds is what it is set in.
   */
  it('does not move when the segment length does', () => {
    // Up to the ceiling itself and no further: a fragment above it is the one pair that cannot be
    // expressed, because the fragment is a floor on the segment and the ceiling is a roof on it.
    const held = ['0.5', '1', '1.5', '2', '2.5'].map((fragment) => ceilingOf(fragment, '2.5'));

    assert.deepEqual(held, [2.5, 2.5, 2.5, 2.5, 2.5]);
  });

  it('is the number of seconds it was asked for', () => {
    assert.equal(ceilingOf('0.5', '2.5'), 2.5);
    assert.equal(ceilingOf('2', '3.2'), 3.2);
  });

  it('refuses a ceiling under the segment length, which would cut every segment off a keyframe', () => {
    assert.throws(() => aofRatioFor('2', '1.5'), /below/i);
  });

  it('still lets a probe drive the ratio directly, because three of them do', () => {
    assert.equal(aofRatioFor('0.5', '2.5', '3.3'), '3.3');
  });

  it('is a value the container is actually handed', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    assert.match(compose, /HLS_SEGMENT_MAX:\s*\$\{HLS_SEGMENT_MAX/, 'the container never sees the ceiling');
  });
});
