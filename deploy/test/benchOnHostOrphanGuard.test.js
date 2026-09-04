import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

after(removeSandboxes);

const SCRIPTS = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'deploy/scripts');

/**
 * That a bench launched on the deployment host leaves nothing running behind it, and that a second
 * one cannot start on top of the first.
 *
 * ⛔ Both faults happened within two minutes of each other on 2026-09-04 and between them they cost
 * a postage batch the owner had paid for and a stage arming. The local script was killed, the
 * container on the host kept running, passed its own preflight gates and broadcast for about a
 * minute on a stage armed for a different test. `docker ps` showed it under a name Docker had
 * invented, so stopping it meant guessing which of the running containers was ours. Then a second
 * launch went out against the same host and profile while the first container was still alive, and
 * two harness runs drove one stage.
 *
 * Three controls answer that, and all three are in `bench-on-host.sh`: the container carries a name
 * derived from the profile and the slot, a remote read before the rsync refuses a target that is
 * already running one, and a trap stops it when the local script is interrupted.
 */
const REMOTE_BENCH_DIR = 'swarm-hls-bench';

/** The owner's authorisation to spend, which the script refuses to run without. */
const SPEND_LEDGER = '.spend-ledger.env';
const OWNER_LEDGER = 'authorised_at=2026-09-03T09:32:45Z\n';

/** What the script's own defaults name, so a test asserting on the name does not restate the flags. */
const DEFAULT_CONTAINER = 'latbench-harness-slot7';

function benchSandbox() {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.remoteHome, REMOTE_BENCH_DIR), { recursive: true });
  writeFileSync(join(sandbox.root, SPEND_LEDGER), OWNER_LEDGER);
  return sandbox;
}

describe('bench-on-host names its container after the profile and the slot', () => {
  it('launches the run under that name', async () => {
    const sandbox = benchSandbox();

    const run = await runScript(sandbox, 'bench-on-host.sh', ['--no-setup', '--script', 'bench:latency']);

    assert.equal(run.exitCode, 0, `bench-on-host.sh failed: ${run.stdout}${run.stderr}`);
    const launches = sandbox.sshCommands().filter((command) => command.includes('docker run '));
    assert.equal(launches.length, 1, `expected one launch with --no-setup, got ${launches.length}`);
    assert.match(launches[0], new RegExp(`docker run --rm --name ${DEFAULT_CONTAINER} `));
  });

  /**
   * ⛔ Both phases or neither. The install and the run are two containers in one launch, and a name
   * that covered only the second would leave an interrupt during the install with nothing to stop.
   *
   * Read from the file rather than watched going out, because the sandbox cannot drive the setup
   * path at all: its stand-in remote host lives inside the checkout the rsync would copy, and the
   * copy refuses to recurse into itself. So this holds the two phases to the ONE `docker run` string
   * the script builds, which is what makes the name the same for both by construction.
   */
  it('builds one docker run string, so the install and the run cannot differ', () => {
    const script = readFileSync(join(SCRIPTS, 'bench-on-host.sh'), 'utf8');

    const built = script.match(/^DOCKER_RUN="docker run [^"]*/m);
    assert.ok(built, 'bench-on-host.sh no longer builds a DOCKER_RUN string');
    assert.match(built[0], /--name \$\{HARNESS_CONTAINER\}/);
    assert.equal((script.match(/docker run /g) ?? []).length, 1, 'a second docker run could carry another name');

    const installPhase = script.match(/^.*pnpm install --frozen-lockfile.*$/m);
    const runPhase = script.match(/^.*\$\{RUN_ENV\} \$\{IMAGE\} \$\{CONTAINER_CMD\}.*$/m);
    assert.match(installPhase[0], /\$\{DOCKER_RUN\}/, 'the install stopped using the named container');
    assert.match(runPhase[0], /\$\{DOCKER_RUN\}/, 'the run stopped using the named container');
  });

  it('puts the slot in the name, so two slots on one host do not collide', async () => {
    const sandbox = benchSandbox();

    await runScript(sandbox, 'bench-on-host.sh', ['--no-setup', '--portSlot', '1']);
    await runScript(sandbox, 'bench-on-host.sh', ['--no-setup', '--portSlot', '2']);

    const names = sandbox
      .sshCommands()
      .filter((command) => command.includes('docker run '))
      .map((command) => command.match(/--name (\S+)/)?.[1]);
    assert.deepEqual(names, ['latbench-harness-slot1', 'latbench-harness-slot2']);
  });

  it('puts the profile in the name, so two stages on one host do not collide', async () => {
    const sandbox = benchSandbox();

    await runScript(sandbox, 'bench-on-host.sh', ['--no-setup', '--profile', 'latbench']);
    await runScript(sandbox, 'bench-on-host.sh', ['--no-setup', '--profile', 'default']);

    const names = sandbox
      .sshCommands()
      .filter((command) => command.includes('docker run '))
      .map((command) => command.match(/--name (\S+)/)?.[1]);
    assert.deepEqual(names, ['latbench-harness-slot7', 'default-harness-slot7']);
  });

  /**
   * The name is interpolated into a docker command carried over ssh, where anything but the shape
   * docker accepts for a container name has no business. Screened the way `--shape-kbps` is, and to
   * the same rule `_lib.sh` holds a profile and a slot to everywhere else.
   */
  it('refuses a profile that cannot be a container name', async () => {
    const sandbox = benchSandbox();

    const run = await runScript(sandbox, 'bench-on-host.sh', ['--no-setup', '--profile', 'Lat bench']);

    assert.notEqual(run.exitCode, 0, 'a profile that is not a usable container name was accepted');
    assert.match(run.stderr, /--profile/);
    assert.equal(sandbox.sshCommands().length, 0, 'the refusal came after a read of the host');
  });

  it('refuses a slot that cannot be a container name', async () => {
    const sandbox = benchSandbox();

    const run = await runScript(sandbox, 'bench-on-host.sh', ['--no-setup', '--portSlot', 'seven']);

    assert.notEqual(run.exitCode, 0, 'a slot that is not a whole number was accepted');
    assert.match(run.stderr, /--portSlot/);
    assert.equal(sandbox.sshCommands().length, 0, 'the refusal came after a read of the host');
  });
});
