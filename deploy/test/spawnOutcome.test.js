import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { classifySpawn, SPAWN_ABSENT, SPAWN_OK, SPAWN_REFUSED, SPAWN_TIMED_OUT } from './helpers/spawnOutcome.js';

/**
 * OPS-28. The deploy suite ran 742 seconds against a nominal 12.8 and failed one test, then passed
 * on a re-run. The test shells out to `docker compose config` with no timeout and read the result
 * with two branches, so anything other than a missing binary or a clean exit was reported as the
 * compose file being refused.
 *
 * The cases below are driven through the real `spawnSync` wherever the case can be produced, rather
 * than through hand-built result objects, because the whole defect was a wrong belief about which
 * field `spawnSync` sets.
 */
describe('what a spawnSync result actually says', () => {
  it('calls a missing binary absent, which is the one case worth skipping over', () => {
    const outcome = classifySpawn(spawnSync('definitely-not-a-real-binary-9e3a', [], { encoding: 'utf-8' }));

    assert.equal(outcome.kind, SPAWN_ABSENT);
  });

  /**
   * The case that made the fix more than adding a timeout. `spawnSync` reports a timeout kill in the
   * same `error` field as a missing binary, so a check reading `error` alone turns a hung command
   * into "not installed" and skips in silence. Driven through a real sleep so the assertion is about
   * what node does rather than about what this file believes node does.
   */
  it('calls a command that never answered timed out, not absent', () => {
    const outcome = classifySpawn(spawnSync('sleep', ['30'], { encoding: 'utf-8', timeout: 250 }));

    assert.equal(outcome.kind, SPAWN_TIMED_OUT);
    assert.match(outcome.detail, /did not answer inside its timeout/);
  });

  it('calls a non-zero exit refused, and carries what the command said', () => {
    const outcome = classifySpawn(spawnSync('sh', ['-c', 'echo nope >&2; exit 3'], { encoding: 'utf-8' }));

    assert.equal(outcome.kind, SPAWN_REFUSED);
    assert.match(outcome.detail, /exit 3/);
    assert.match(outcome.detail, /nope/);
  });

  it('calls a clean exit ok', () => {
    assert.equal(classifySpawn(spawnSync('true', [], { encoding: 'utf-8' })).kind, SPAWN_OK);
  });

  /**
   * A command killed by a signal without node setting `error`, which happens when something outside
   * this process reaps it. It is not the compose file's fault and must not be reported as refusal.
   */
  it('calls a signalled command timed out rather than refused', () => {
    const outcome = classifySpawn({ error: new Error('killed'), signal: 'SIGKILL', status: null, stderr: '' });

    assert.equal(outcome.kind, SPAWN_TIMED_OUT);
    assert.match(outcome.detail, /SIGKILL/);
  });
});
