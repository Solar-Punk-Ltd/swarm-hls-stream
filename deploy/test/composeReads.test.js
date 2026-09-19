import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

/**
 * That the arms a gateway probe names are the arms the node runs.
 *
 * ⛔ This is a control, not a nicety. A probe writes its arms into the stack's env file, and a stack
 * whose compose file does not read them measures nothing at all: both arms are then the same run, the
 * difference comes out at or near zero, and zero reads as the finding "funding makes no difference to
 * a viewer" rather than as a harness with its control disconnected.
 *
 * Since T27 on 2026-09-17 the gateway's mode is two keys rather than one. An endpoint is what puts the
 * node on a chain and an empty one is the whole of what makes it ultra-light, and swap is what lets a
 * node on a chain pay its peers. A stack that reads one key and not the other cannot produce the light
 * arm, and bee refuses to start at all with swap asked for and no chain, so a probe that wrote swap
 * alone would spend its wait on a container that never came up.
 *
 * The guard was written and then installed as a bare call to a function in `_lib.sh`, in two scripts
 * that are copied to the measurement host one file at a time and say in their own headers that they
 * never source it. Under `set -u` and no `set -e` that is one `command not found` line on standard
 * error and a probe that carries on, which is why these cases run the real scripts and read what
 * they exit with rather than testing the guard's text.
 */

/**
 * A configuration in which neither probe can spend any time, so a case about a refusal stays cheap
 * even when the refusal does not happen.
 *
 * ⛔ Not a nicety. A probe that was supposed to stop and did not goes on to do the thing for real,
 * which waits four minutes on a gateway API and two more on a host that will never quieten, and then
 * runs an EXIT trap that waits again. Run against unguarded scripts this file did not finish in ten
 * minutes, and killing the shell does not help, because the trap is the slow part. Every name below
 * is one probe's or the other's, and each ignores the other's.
 *
 * ⭐ `ARM_PLAN` carries a light arm on purpose, because a light arm is the thing the endpoint check
 * is about, and points it at a reference pattern that does not exist, which is refused before the
 * arm reaches docker. So a run that gets past the check ends in seconds and the case fails on the
 * exit code rather than hanging. `ROUNDS: '0'` is not the lever it looks like: BSD `seq 1 0` counts
 * DOWN and gives two rounds where GNU gives none.
 */
const NOTHING_TO_MEASURE = {
  ROUNDS: '1',
  ARM_PLAN: 'L:true:0:0:1:0:1:0:no-such-pattern',
  LOAD_SETTLE_MAX_S: '0',
  WARM_SETTLE_S: '0',
  WARM_S: '0',
  COLD_S: '0',
};

const RPC_KEY = 'BEE_GATEWAY_RPC_ENDPOINT';
const SWAP_KEY = 'BEE_GATEWAY_SWAP_ENABLE';
const BOTH_KEYS = [RPC_KEY, SWAP_KEY];

/**
 * The stack's own chain endpoint, which is what a light gateway is pointed at.
 *
 * ⭐ The slash, the `=` and the `&` are the test rather than decoration. This value is written into an
 * env file, and both of the obvious ways to write one mangle it: a `/` closes sed's substitution early
 * and an `&` in its replacement is the whole match again.
 */
const STACK_RPC = 'https://rpc.example.test/v1?key=a&chain=gnosis';

/** A compose file for the stack the probe drives, reading whichever mode keys it is given. */
function composeReading(keys) {
  const endpoint = keys.includes(RPC_KEY) ? '${BEE_GATEWAY_RPC_ENDPOINT:-}' : '';
  const swap = keys.includes(SWAP_KEY) ? '${BEE_GATEWAY_SWAP_ENABLE:-false}' : 'false';
  return [
    'services:',
    '  bee-gateway:',
    '    command:',
    `      - --blockchain-rpc-endpoint=${endpoint}`,
    `      - --swap-enable=${swap}`,
    '',
  ].join('\n');
}

/** What a stack's env file holds before a probe touches it. No endpoint key, which is every stack. */
function stackEnv({ rpcEndpoint = STACK_RPC } = {}) {
  return [
    'STAMP=stamp',
    'STREAM_KEY=key',
    ...(rpcEndpoint === null ? [] : [`RPC_ENDPOINT=${rpcEndpoint}`]),
    'BEE_GATEWAY_SWAP_ENABLE=false',
    '',
  ].join('\n');
}

after(removeSandboxes);

/**
 * A sandbox holding both a copy of the scripts and the stack they drive, which are two different
 * checkouts on the measurement host: the probes are synced to `~/phase06` and the stack they flip
 * lives at `~/swarm-hls-stream-latbench`. The guard has to read the stack's compose file and not the
 * one beside itself, which is the second half of the same defect.
 */
function stackSandbox(keys, env = null) {
  const sandbox = makeSandbox();
  const stack = join(sandbox.root, 'stack');
  mkdirSync(join(stack, 'deploy'), { recursive: true });
  writeFileSync(join(stack, 'deploy', 'docker-compose.yml'), composeReading(keys));
  const envFile = join(stack, '.env');
  if (env !== null) {
    writeFileSync(envFile, env);
  }

  const out = join(sandbox.root, 'probe-out');
  mkdirSync(out, { recursive: true });

  return {
    sandbox,
    envFile,
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

describe('a gateway probe whose arms the stack cannot run', () => {
  for (const probe of PROBES) {
    for (const [missing, reads] of [
      ['both keys', []],
      ['the endpoint', [SWAP_KEY]],
      ['swap', [RPC_KEY]],
    ]) {
      it(`${probe} refuses a stack that does not read ${missing}, before it touches docker`, async () => {
        const { sandbox, env } = stackSandbox(reads);

        const run = await runScript(sandbox, probe, [], { ...env, ...NOTHING_TO_MEASURE });

        assert.equal(run.exitCode, 1, `expected a refusal, got ${run.exitCode}: ${run.stdout}${run.stderr}`);
        assert.match(run.stderr, /does not read/);
        assert.match(run.stderr, /cannot produce the light arm/);
        assert.deepEqual(sandbox.calls(), [], 'the probe reached docker after the guard should have stopped it');
      });
    }

    it(`${probe} names the key the stack is missing rather than the pair`, async () => {
      const { sandbox, env } = stackSandbox([SWAP_KEY]);

      const run = await runScript(sandbox, probe, [], { ...env, ...NOTHING_TO_MEASURE });

      assert.match(run.stderr, new RegExp(`does not read ${RPC_KEY}[,.]`), run.stderr);
    });

    /**
     * The defect itself. A call to a function the script never brings into scope prints this on
     * standard error and returns 127, and the probe then runs the whole sitting with its control
     * disconnected. Nothing else in these scripts can produce the line.
     */
    it(`${probe} refuses by its own guard rather than by a missing one`, async () => {
      const { sandbox, env } = stackSandbox([]);

      const run = await runScript(sandbox, probe, [], { ...env, ...NOTHING_TO_MEASURE });

      assert.doesNotMatch(run.stderr, /command not found/);
    });

    /**
     * A stack that reads both keys and has no endpoint to give is the other half of the same
     * question, and it is the shape a fresh deployment has: `BEE_GATEWAY_RPC_ENDPOINT` is new and
     * absent everywhere, so the value a light arm needs is the stack's own `RPC_ENDPOINT`. Without
     * one the arm cannot exist, and bee would refuse to start with swap on and no chain, which is
     * four minutes of waiting and then a failure that names none of this.
     */
    it(`${probe} refuses a light arm on a stack that names no chain endpoint`, async () => {
      const { sandbox, env } = stackSandbox(BOTH_KEYS, stackEnv({ rpcEndpoint: null }));

      const run = await runScript(sandbox, probe, [], { ...env, ...NOTHING_TO_MEASURE, ARM_SWAP: 'true' });

      assert.equal(run.exitCode, 1, `expected a refusal, got ${run.exitCode}: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, /names no RPC_ENDPOINT/);
      assert.deepEqual(sandbox.calls(), [], 'the probe reached docker with an arm it cannot set');
    });
  }

  /**
   * Without this, a guard that refused everything would pass every case above and no probe could
   * run again at all. Only the cold-idle probe is driven past its guard here, because it is the one
   * whose next step stops it on its own: the stack in this sandbox has no env file, so the first
   * write it makes fails and it exits before reaching docker. The same shape is proven on the third
   * probe by `phase06Preflight.test.js`, which runs a whole green preflight through this guard.
   */
  it('cold-gateway-idle-cpu.sh runs on past the guard when compose does read both keys', async () => {
    const { sandbox, env } = stackSandbox(BOTH_KEYS);

    const run = await runScript(sandbox, 'cold-gateway-idle-cpu.sh', [], { ...env, ...NOTHING_TO_MEASURE });

    assert.doesNotMatch(run.stderr, /does not read/);
    assert.doesNotMatch(run.stderr, /command not found/);
    assert.match(
      run.stdout,
      /cold gateway idle cost/,
      `the probe never reached its own first line: ${run.stdout}${run.stderr}`,
    );
    assert.deepEqual(sandbox.calls(), [], 'this case is only safe while it stops before docker');
  });
});

/**
 * What compose is actually handed, which is the only place an arm exists.
 *
 * ⛔ The env file is not the whole of it, and that is why this reads the process environment too.
 * Compose prefers a value exported into the shell it runs in over the same key in its `--env-file`,
 * and the deployment host exports endpoint settings for the stack, so an arm written only into the
 * file can be overridden by the host without anything saying so. Both arms are asserted against a
 * poisoned environment for that reason.
 *
 * Driven through `cold-gateway-idle-cpu.sh`, whose every window can be set to zero seconds, so the
 * whole probe runs in a test. The other two set their arms the same way and are not reachable this
 * cheaply: `retrieval-debt-probe.sh` needs a reference corpus and `phase06-light-vs-ultralight.sh`
 * needs a broadcast.
 */
describe('the arm a probe hands to compose', () => {
  /**
   * A docker that records what compose was called with, what it was told, and what it was handed.
   *
   * Only compose calls are recorded, because only compose resolves the file. Every other call this
   * probe makes inherits the same environment and decides nothing, so recording those would report
   * a value this probe never chose as the arm it set.
   */
  function recordingDocker(sandbox) {
    const journal = join(sandbox.root, 'compose-calls.txt');
    writeFileSync(journal, '');
    const stub = join(sandbox.binDir, 'docker');
    writeFileSync(
      stub,
      [
        '#!/bin/sh',
        `journal=${JSON.stringify(journal)}`,
        '[ "$1" = "compose" ] || exit 0',
        'printf "call %s\\n" "$*" >> "$journal"',
        `printf "shell ${SWAP_KEY}=%s\\n" "\${${SWAP_KEY}-<unset>}" >> "$journal"`,
        `printf "shell ${RPC_KEY}=%s\\n" "\${${RPC_KEY}-<unset>}" >> "$journal"`,
        'next=0',
        'for arg in "$@"; do',
        '  if [ "$next" = 1 ]; then sed "s/^/file /" "$arg" >> "$journal"; next=0; fi',
        '  if [ "$arg" = "--env-file" ]; then next=1; fi',
        'done',
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(stub, 0o755);
    return () => readFileSync(journal, 'utf8');
  }

  /** One whole run of the probe with every window at zero, so only its arm handling is exercised. */
  async function runProbe(armSwap, shellEnv = {}) {
    const stack = stackSandbox(BOTH_KEYS, stackEnv());
    const composeCalls = recordingDocker(stack.sandbox);
    // A curl that answers, so the wait for the gateway API is not four minutes of a port nobody
    // is listening on.
    const curl = join(stack.sandbox.binDir, 'curl');
    writeFileSync(curl, '#!/bin/sh\nexit 0\n');
    chmodSync(curl, 0o755);

    const run = await runScript(stack.sandbox, 'cold-gateway-idle-cpu.sh', [], {
      ...stack.env,
      ...NOTHING_TO_MEASURE,
      ...shellEnv,
      ARM_SWAP: armSwap,
    });

    return { run, composeCalls: composeCalls(), envFile: readFileSync(stack.envFile, 'utf8') };
  }

  it('puts the light arm on the chain, endpoint and swap together', async () => {
    const { run, composeCalls } = await runProbe('true');

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.match(composeCalls, new RegExp(`^file ${SWAP_KEY}=true$`, 'm'), composeCalls);
    assert.ok(
      composeCalls.includes(`file ${RPC_KEY}=${STACK_RPC}`),
      `the endpoint reached compose mangled: ${composeCalls}`,
    );
  });

  it('states the ultra-light arm rather than leaving it to whatever the host exports', async () => {
    const { run, composeCalls } = await runProbe('false', { [RPC_KEY]: 'http://poison.invalid' });

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.match(composeCalls, new RegExp(`^file ${SWAP_KEY}=false$`, 'm'), composeCalls);
    assert.match(composeCalls, new RegExp(`^file ${RPC_KEY}=$`, 'm'), composeCalls);
    assert.doesNotMatch(composeCalls, /poison\.invalid/, 'the host environment chose the arm');
  });

  /**
   * The env file says what was asked for and the environment compose runs in says what it gets, and
   * when they disagree the environment wins. A probe that wrote the file and left the key alone in
   * its own shell would pass every assertion above while running the other arm.
   */
  it('tells compose the arm in the one place that outranks the env file', async () => {
    const { composeCalls } = await runProbe('false', { [RPC_KEY]: 'http://poison.invalid' });

    assert.match(composeCalls, new RegExp(`^shell ${RPC_KEY}=$`, 'm'), composeCalls);
    assert.match(composeCalls, new RegExp(`^shell ${SWAP_KEY}=false$`, 'm'), composeCalls);
  });

  /**
   * ⛔ The probe changes a live deployment, so the arm it leaves behind is the arm that deployment
   * runs until somebody notices. The endpoint key is absent from every stack today, and putting it
   * back as present-and-empty is not the state it was found in.
   */
  it('leaves the stack exactly as it found it', async () => {
    const { envFile } = await runProbe('true');

    assert.equal(envFile, stackEnv(), envFile);
  });

  it('puts the endpoint key back to absent on the arm that never needed it either', async () => {
    const { envFile } = await runProbe('false');

    assert.equal(envFile, stackEnv(), envFile);
  });
});
