import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * How long the stubbed container holds the run open. Long enough that the signal lands while it is
 * in flight, short enough that the handler, which waits for that ssh, does not hold up the suite.
 */
const CONTAINER_HOLDS_SECONDS = 3;
const INTERRUPT_DEADLINE_MS = 20_000;
const POLL_MS = 20;

/** 128 plus the signal number, which is what a shell reports for a run a signal ended. */
const EXIT_ON_INT = 130;
const EXIT_ON_TERM = 143;

function benchSandbox() {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.remoteHome, REMOTE_BENCH_DIR), { recursive: true });
  writeFileSync(join(sandbox.root, SPEND_LEDGER), OWNER_LEDGER);
  return sandbox;
}

function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/**
 * A `docker` that answers `ps` with one running harness container and hands every other call to the
 * ordinary stub, which journals it.
 *
 * The sandbox's own stub reads compose label filters and nothing else, so the guard's `--filter
 * name=` read comes back empty there. That is the free target every other test in this file sees,
 * and it is why a busy one has to be arranged.
 */
function dockerReportsRunning(sandbox, name) {
  writeExecutable(
    join(sandbox.binDir, 'docker'),
    `#!/bin/sh\nif [ "$1" = "ps" ]; then echo ${name}; exit 0; fi\nexec node -- "$0.cjs" "$@"\n`,
  );
}

/**
 * A `docker` whose `run` blocks after journalling itself, which is the window an operator kills the
 * local script in. `stopExitCode` is what its `stop` answers, so the failed-stop path is this same
 * stub with one number changed.
 */
function dockerRunBlocks(sandbox, { marker, stopExitCode }) {
  writeExecutable(
    join(sandbox.binDir, 'docker'),
    `#!/bin/sh
node -- "$0.cjs" "$@" || exit $?
if [ "$1" = "run" ]; then : > ${marker}; exec sleep ${CONTAINER_HOLDS_SECONDS}; fi
if [ "$1" = "stop" ]; then exit ${stopExitCode}; fi
exit 0
`,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path) {
  const until = Date.now() + INTERRUPT_DEADLINE_MS;
  while (Date.now() < until) {
    if (existsSync(path)) {
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`the stubbed container never started: ${path} was never written`);
}

/**
 * Signals the script itself once the stubbed container is up, which is `kill <pid>` from another
 * terminal. Bash holds the signal until the foreground command returns, so the handler runs when
 * the run's ssh comes back and while the container is still marked in flight.
 *
 * ⛔ Deliberately NOT a signal to the whole process group, which is what a terminal's Ctrl-C sends.
 * That reaches the same handler, but measured with /bin/bash over 60 attempts per arm it does not
 * always reach it at all: 4 in 60 for TERM and 1 in 60 for INT, the shell died on the signal at 143
 * or 130 without running its trap, and the container survived. So the trap is best effort and the
 * busy-target guard is the control that always holds. A test on the group path would be a test that
 * fails one run in twenty for a reason that is not a regression.
 *
 * The process group is still its own, so the cleanup below can take the stubbed container with it.
 */
async function interruptedRun(sandbox, args, { signal = 'SIGINT', stopExitCode = 0 } = {}) {
  const marker = join(sandbox.root, 'container-started');
  dockerRunBlocks(sandbox, { marker, stopExitCode });

  const child = spawn('bash', [sandbox.scriptPath('bench-on-host.sh'), ...args], {
    detached: true,
    env: { ...process.env, PATH: `${sandbox.binDir}:${process.env.PATH ?? ''}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));

  try {
    await waitForFile(marker);
    process.kill(child.pid, signal);
    const exitCode = await Promise.race([
      closed,
      sleep(INTERRUPT_DEADLINE_MS).then(() => {
        throw new Error(`the script did not exit after ${signal}: ${stdout}${stderr}`);
      }),
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already reaped, which is the passing path.
    }
  }
}

/** Every `docker stop` the script issued, as the far side's stub recorded it. */
function stopCalls(sandbox) {
  return sandbox.remoteCalls().filter((call) => call.startsWith('stop '));
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

describe('bench-on-host refuses a target that is already running a harness container', () => {
  /**
   * ⛔ Before the rsync, which runs with `--delete`. A second launch that got as far as the sync
   * would have replaced the tree the live container is running from, under a broadcast that is
   * already being paid for.
   */
  it('stops before anything is copied to the host', async () => {
    const sandbox = makeSandbox();
    writeFileSync(join(sandbox.root, SPEND_LEDGER), OWNER_LEDGER);
    dockerReportsRunning(sandbox, DEFAULT_CONTAINER);

    const run = await runScript(sandbox, 'bench-on-host.sh', ['--script', 'bench:latency']);

    assert.notEqual(run.exitCode, 0, 'a second run was allowed onto a busy stage');
    assert.equal(existsSync(join(sandbox.remoteHome, REMOTE_BENCH_DIR)), false, 'the rsync ran before the refusal');
    const reads = sandbox.sshCommands();
    assert.equal(reads.length, 1, `the refusal reached the host more than once: ${reads.join(' | ')}`);
    assert.match(reads[0], /docker ps/);
  });

  /**
   * ⛔ `--no-setup` is the repeat-run path a sweep takes, and an overlap does the same harm there.
   * The operator also has to be able to act on the message without reading `docker ps` and guessing,
   * which is the half of this that a bare refusal would miss.
   */
  it('refuses --no-setup too, and names the container and the command that stops it', async () => {
    const sandbox = benchSandbox();
    dockerReportsRunning(sandbox, DEFAULT_CONTAINER);

    const run = await runScript(sandbox, 'bench-on-host.sh', ['--no-setup']);

    assert.notEqual(run.exitCode, 0, '--no-setup was allowed onto a busy stage');
    assert.equal(sandbox.sshCommands().length, 1, 'the run went out anyway');
    assert.match(run.stderr, new RegExp(`${DEFAULT_CONTAINER} is already running`));
    assert.match(run.stderr, /two harness runs on one stage read each other's broadcasts/);
    assert.match(run.stderr, new RegExp(`ssh manager-host 'docker stop ${DEFAULT_CONTAINER}'`));
  });

  /**
   * A different slot on the same host is a different stage and a co-tenant's container is not ours
   * at all, so the read is anchored on the whole name rather than left as the substring match
   * `--filter name=` is by default.
   */
  it('reads only the container this profile and slot would launch', async () => {
    const sandbox = benchSandbox();

    const run = await runScript(sandbox, 'bench-on-host.sh', ['--no-setup', '--portSlot', '1']);

    assert.equal(run.exitCode, 0, `a free target was refused: ${run.stdout}${run.stderr}`);
    assert.match(sandbox.sshCommands()[0], /docker ps --filter 'name=\^latbench-harness-slot1\$'/);
  });
});

describe('bench-on-host stops the remote container when it is interrupted', () => {
  /**
   * ⛔ A run that ended on its own has nothing left to stop: `--rm` took the container before ssh
   * returned. A stop here would fail on every green run and print an alarm about a container that
   * is not there.
   */
  it('issues no docker stop on a clean run', async () => {
    const sandbox = benchSandbox();

    const run = await runScript(sandbox, 'bench-on-host.sh', ['--no-setup']);

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.deepEqual(stopCalls(sandbox), [], 'a green run stopped a container that had already gone');
  });

  /**
   * ⛔ Nor on a red one, for the same reason. A suite that fails leaves the container removed too,
   * and a warning printed after every red run is a warning an operator learns to skip.
   */
  it("keeps a red run's own exit code and stops nothing", async () => {
    const sandbox = benchSandbox();
    writeExecutable(
      join(sandbox.binDir, 'docker'),
      '#!/bin/sh\nnode -- "$0.cjs" "$@" || exit $?\nif [ "$1" = "run" ]; then exit 3; fi\nexit 0\n',
    );

    const run = await runScript(sandbox, 'bench-on-host.sh', ['--no-setup']);

    assert.equal(run.exitCode, 3, "the run's exit code was not the script's");
    assert.deepEqual(stopCalls(sandbox), [], 'a red run stopped a container that had already gone');
    assert.doesNotMatch(run.stderr, /may still be running/);
  });

  it('stops exactly the container it named, once', async () => {
    const sandbox = benchSandbox();

    const run = await interruptedRun(sandbox, ['--no-setup']);

    assert.deepEqual(stopCalls(sandbox), [`stop ${DEFAULT_CONTAINER}`]);
    assert.match(run.stderr, new RegExp(`stopping ${DEFAULT_CONTAINER} on manager-host`));
    assert.equal(run.exitCode, EXIT_ON_INT);
  });

  it('stops it on a TERM as well as on an interrupt', async () => {
    const sandbox = benchSandbox();

    const run = await interruptedRun(sandbox, ['--no-setup'], { signal: 'SIGTERM' });

    assert.deepEqual(stopCalls(sandbox), [`stop ${DEFAULT_CONTAINER}`]);
    assert.equal(run.exitCode, EXIT_ON_TERM);
  });

  /**
   * ⛔ The one thing worse than not stopping the container is not saying so. A stop that failed
   * leaves a broadcast running on a stage the operator believes is free.
   */
  it('says the container may still be running when the stop fails, and keeps the exit code', async () => {
    const sandbox = benchSandbox();

    const run = await interruptedRun(sandbox, ['--no-setup'], { stopExitCode: 9 });

    assert.equal(run.exitCode, EXIT_ON_INT, 'a failed stop changed the exit code');
    assert.match(run.stderr, new RegExp(`${DEFAULT_CONTAINER} may still be running`));
    assert.match(run.stderr, new RegExp(`ssh manager-host 'docker stop ${DEFAULT_CONTAINER}'`));
  });
});
