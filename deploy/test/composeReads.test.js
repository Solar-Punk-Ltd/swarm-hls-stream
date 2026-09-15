import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

/**
 * That a gateway probe refuses to run once the compose file has stopped reading the key whose two
 * values are its arms.
 *
 * ⛔ This is a control, not a nicety. A probe that flips `BEE_GATEWAY_SWAP_ENABLE` in the env file
 * measures nothing at all once compose ignores that key: both arms are then the same run, the
 * difference comes out at or near zero, and zero reads as the finding "funding makes no difference
 * to a viewer" rather than as a harness with its control disconnected. Compose stopped reading it on
 * 2026-09-15, so the condition is live on every run from that day.
 *
 * The guard was written and then installed as a bare call to a function in `_lib.sh`, in two scripts
 * that are copied to the measurement host one file at a time and say in their own headers that they
 * never source it. Under `set -u` and no `set -e` that is one `command not found` line on standard
 * error and a probe that carries on, which is why these cases run the real scripts and read what
 * they exit with rather than testing the guard's text.
 */

const REFUSAL = /no longer reads \$\{BEE_GATEWAY_SWAP_ENABLE\}/;

/** A compose file for the stack the probe drives, with or without the key its arms are written to. */
const COMPOSE_WITHOUT_KEY = [
  'services:',
  '  bee-gateway:',
  '    command:',
  '      - --blockchain-rpc-endpoint=',
  '      - --swap-enable=false',
  '',
].join('\n');

const COMPOSE_WITH_KEY = COMPOSE_WITHOUT_KEY.replace(
  '--swap-enable=false',
  '--swap-enable=${BEE_GATEWAY_SWAP_ENABLE:-false}',
);

after(removeSandboxes);

/**
 * A sandbox holding both a copy of the scripts and the stack they drive, which are two different
 * checkouts on the measurement host: the probes are synced to `~/phase06` and the stack they flip
 * lives at `~/swarm-hls-stream-latbench`. The guard has to read the stack's compose file and not the
 * one beside itself, which is the second half of the same defect.
 */
function stackSandbox(compose) {
  const sandbox = makeSandbox();
  const stack = join(sandbox.root, 'stack');
  mkdirSync(join(stack, 'deploy'), { recursive: true });
  writeFileSync(join(stack, 'deploy', 'docker-compose.yml'), compose);

  const out = join(sandbox.root, 'probe-out');
  mkdirSync(out, { recursive: true });

  return {
    sandbox,
    env: {
      STACK_DIR: stack,
      OUT_DIR: out,
      // Host-side helpers the probes shell out to. Pointed inside the sandbox so that a probe which
      // got past the guard could still not read anything of the measurement host's.
      ACCT: join(sandbox.root, 'acct.sh'),
      METRICS: join(sandbox.root, 'metrics.sh'),
      REFS: join(sandbox.root, 'refs.txt'),
    },
  };
}

const PROBES = ['cold-gateway-idle-cpu.sh', 'retrieval-debt-probe.sh'];

describe('a gateway probe whose arms compose no longer reads', () => {
  for (const probe of PROBES) {
    it(`${probe} refuses, before it touches docker`, async () => {
      const { sandbox, env } = stackSandbox(COMPOSE_WITHOUT_KEY);

      const run = await runScript(sandbox, probe, [], env);

      assert.equal(run.exitCode, 1, `expected a refusal, got ${run.exitCode}: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, REFUSAL);
      assert.deepEqual(sandbox.calls(), [], 'the probe reached docker after the guard should have stopped it');
    });

    /**
     * The defect itself. A call to a function the script never brings into scope prints this on
     * standard error and returns 127, and the probe then runs the whole sitting with its control
     * disconnected. Nothing else in these scripts can produce the line.
     */
    it(`${probe} refuses by its own guard rather than by a missing one`, async () => {
      const { sandbox, env } = stackSandbox(COMPOSE_WITHOUT_KEY);

      const run = await runScript(sandbox, probe, [], env);

      assert.doesNotMatch(run.stderr, /command not found/);
    });
  }

  /**
   * Without this, a guard that refused everything would pass both cases above and no probe could
   * run again at all. Only the cold-idle probe is driven past its guard here, because it is the one
   * whose next step stops it on its own: the stack in this sandbox has no env file, so the first
   * write it makes fails and it exits before reaching docker. The same shape is proven on the third
   * probe by `phase06Preflight.test.js`, which runs a whole green preflight through this guard.
   */
  it('cold-gateway-idle-cpu.sh runs on past the guard when compose does read the key', async () => {
    const { sandbox, env } = stackSandbox(COMPOSE_WITH_KEY);

    const run = await runScript(sandbox, 'cold-gateway-idle-cpu.sh', [], env);

    assert.doesNotMatch(run.stderr, REFUSAL);
    assert.doesNotMatch(run.stderr, /command not found/);
    assert.match(
      run.stdout,
      /cold gateway idle cost/,
      `the probe never reached its own first line: ${run.stdout}${run.stderr}`,
    );
    assert.deepEqual(sandbox.calls(), [], 'this case is only safe while it stops before docker');
  });
});
