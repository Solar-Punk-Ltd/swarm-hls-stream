/**
 * What a `spawnSync` result actually says, as one of four answers rather than as a status code and
 * an `error` field a caller has to know the rules for. This is OPS-28.
 *
 * `deploy/test/healthcheck.test.js` shells out to `docker compose config` to prove the compose file
 * is one compose will load, which is the only check there that a unit test of the probe cannot do.
 * It read the result with two branches: `check.error` meant docker was absent and skip, and anything
 * else went to `assert.equal(check.status, 0, 'docker compose refused the file')`. Both are wrong at
 * the edges, and the edges are what showed up.
 *
 * On 2026-08-03 that suite took 742 seconds against a nominal 12.8 and failed this one test, then
 * passed on a re-run. There was no timeout on the spawn, so a docker that does not answer blocks the
 * whole suite for as long as it likes. **The trigger was never established and is not claimed here.**
 * What is established is that `docker compose config` does not need the daemon: it exits 0 with
 * `DOCKER_HOST` pointed at a socket that does not exist, so "the daemon was down" is ruled out
 * rather than assumed.
 *
 * Adding a timeout alone would have moved the misreporting rather than ended it. `spawnSync` reports
 * a timeout in the same `error` field as a missing binary, so a hung docker would then have been
 * reported as docker being absent and the test would have skipped in silence. The four cases are
 * separated here so each one is named for what it is.
 */

/** The binary is not installed. A machine without docker cannot answer this question. */
export const SPAWN_ABSENT = 'absent';
/** The binary was found and did not answer inside the timeout. */
export const SPAWN_TIMED_OUT = 'timedOut';
/** It ran and exited non-zero, which for `compose config` means the file was refused. */
export const SPAWN_REFUSED = 'refused';
export const SPAWN_OK = 'ok';

/**
 * Classify a `spawnSync` result.
 *
 * @param {import('node:child_process').SpawnSyncReturns<string>} result
 * @returns {{kind: string, detail: string}}
 */
export function classifySpawn(result) {
  if (result.error) {
    // `spawnSync` puts a timeout kill and a missing binary in the same field, and only the code
    // tells them apart. Reading `error` alone is what would have turned a hung docker into a skip.
    if (result.error.code === 'ETIMEDOUT' || result.signal !== null) {
      return { kind: SPAWN_TIMED_OUT, detail: describeTimeout(result) };
    }
    return { kind: SPAWN_ABSENT, detail: result.error.message };
  }
  if (result.status !== 0) {
    return { kind: SPAWN_REFUSED, detail: `exit ${result.status}: ${result.stderr ?? ''}`.trim() };
  }
  return { kind: SPAWN_OK, detail: '' };
}

function describeTimeout(result) {
  const killed = result.signal === null ? '' : ` and was killed with ${result.signal}`;
  return `the command did not answer inside its timeout${killed}`;
}
