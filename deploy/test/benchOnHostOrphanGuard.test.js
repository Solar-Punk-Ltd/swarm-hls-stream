import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

after(removeSandboxes);

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

/**
 * The cap the script puts on the stop, shortened from its default of 20s so a stop that never
 * answers can be read without sitting out the real one. The stub below then hangs well past it, so
 * the arm either gives up on its own or the deadline above ends the test.
 */
const SHORT_STOP_DEADLINE_SECONDS = '1';
const STOP_HANGS_SECONDS = 30;

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
 * A `docker` that answers `ps` with one harness container in `state` and hands every other call to
 * the ordinary stub, which journals it.
 *
 * The sandbox's own stub reads compose label filters and nothing else, so the guard's `--filter
 * name=` read comes back empty there. That is the free target every other test in this file sees,
 * and it is why a busy one has to be arranged.
 *
 * ⛔ A container that is not running is reported only when the read passes `-a`, which is what docker
 * itself does. A stub that answered either read the same way would report a guard blind to an exited
 * container as if it could see one.
 */
function dockerReportsHarness(sandbox, state) {
  writeExecutable(
    join(sandbox.binDir, 'docker'),
    `#!/bin/sh
if [ "$1" = "ps" ]; then
  case "${state}:$*" in
    running:*) echo ${state} ;;
    *" -a "*) echo ${state} ;;
  esac
  exit 0
fi
exec node -- "$0.cjs" "$@"
`,
  );
}

/**
 * Replaces `ssh` with a wrapper that treats the stop the handler issues differently and hands every
 * other call to the sandbox's own stub, which is what actually runs the remote command and journals
 * it. The wrapper sees the full argv, options included, which the stub deliberately strips.
 */
function sshOnStop(sandbox, body) {
  const passthrough = join(sandbox.binDir, 'ssh-passthrough');
  copyFileSync(join(sandbox.binDir, 'ssh'), passthrough);
  chmodSync(passthrough, 0o755);
  writeExecutable(
    join(sandbox.binDir, 'ssh'),
    `#!/bin/sh\ncase "$*" in *'docker stop'*) ${body} ;; esac\nexec ${passthrough} "$@"\n`,
  );
}

/**
 * An `rsync` that reports success and copies nothing, which is what lets the setup path run in a
 * sandbox at all. The stand-in remote host is a directory inside the checkout the real sync copies,
 * and a copy cannot recurse into itself.
 */
function rsyncCopiesNothing(sandbox) {
  writeExecutable(join(sandbox.binDir, 'rsync'), '#!/bin/sh\nexit 0\n');
}

/** An `ssh` that cannot reach the target at all, which is what a read of a dead host looks like. */
function sshCannotReachTarget(sandbox) {
  writeExecutable(
    join(sandbox.binDir, 'ssh'),
    '#!/bin/sh\necho "ssh: connect to host manager-host port 22: Operation timed out" >&2\nexit 255\n',
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
async function interruptedRun(sandbox, args, { signal = 'SIGINT', stopExitCode = 0, env = {} } = {}) {
  const marker = join(sandbox.root, 'container-started');
  dockerRunBlocks(sandbox, { marker, stopExitCode });

  const child = spawn('bash', [sandbox.scriptPath('bench-on-host.sh'), ...args], {
    detached: true,
    env: { ...process.env, ...env, PATH: `${sandbox.binDir}:${process.env.PATH ?? ''}` },
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
   * ⭐ Read off the docker command the far side's stub was handed rather than off this script's own
   * source, because the source only ever showed that both phases spelled the same variable, and a
   * variable can be reassigned between them. What stubbing the rsync buys is the setup path itself:
   * the stand-in remote host lives inside the checkout the real sync would copy, and a copy cannot
   * recurse into itself, which is why no case here had ever driven the install at all.
   */
  it('installs under the same name it runs under, so an interrupt during setup has something to stop', async () => {
    const sandbox = benchSandbox();
    rsyncCopiesNothing(sandbox);

    const run = await runScript(sandbox, 'bench-on-host.sh', ['--script', 'bench:latency']);

    assert.equal(run.exitCode, 0, `bench-on-host.sh failed: ${run.stdout}${run.stderr}`);
    const launches = sandbox.remoteCalls().filter((call) => call.startsWith('run '));
    assert.equal(launches.length, 2, `expected the install and the driver, got: ${launches.join(' | ')}`);

    const install = launches.find((call) => call.endsWith('pnpm install --frozen-lockfile'));
    assert.ok(install, `no install phase reached docker: ${launches.join(' | ')}`);
    assert.deepEqual(
      launches.map((call) => call.match(/--name (\S+)/)?.[1]),
      [DEFAULT_CONTAINER, DEFAULT_CONTAINER],
    );
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
    dockerReportsHarness(sandbox, 'running');

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
    dockerReportsHarness(sandbox, 'running');

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
    assert.match(sandbox.sshCommands()[0], /docker ps -a --filter 'name=\^latbench-harness-slot1\$'/);
  });

  /**
   * ⛔⛔ A container that has exited still holds its name, and docker refuses to create a second one
   * under it. A guard reading only the running list called that target free, the rsync then replaced
   * the tree with `--delete`, the image was rebuilt, and the launch died inside `docker run` on a
   * name clash after all the setup had been paid for.
   *
   * Not removed here. Removing a container this script did not create, on a name an operator may be
   * keeping for its logs, is a destructive act taken on a guess, so the refusal hands over the exact
   * command instead.
   */
  it('finds a container of ours that has exited, and names the removal rather than doing it', async () => {
    const sandbox = makeSandbox();
    writeFileSync(join(sandbox.root, SPEND_LEDGER), OWNER_LEDGER);
    dockerReportsHarness(sandbox, 'exited');

    const run = await runScript(sandbox, 'bench-on-host.sh', ['--script', 'bench:latency']);

    assert.notEqual(run.exitCode, 0, 'a launch went out onto a name docker would have refused');
    assert.equal(existsSync(join(sandbox.remoteHome, REMOTE_BENCH_DIR)), false, 'the rsync ran before the refusal');
    assert.match(run.stderr, new RegExp(`${DEFAULT_CONTAINER} is exited on manager-host`));
    assert.match(run.stderr, new RegExp(`ssh manager-host 'docker rm ${DEFAULT_CONTAINER}'`));
    assert.deepEqual(
      sandbox.remoteCalls().filter((call) => call.startsWith('rm ')),
      [],
      'the guard removed a container instead of naming it',
    );
  });

  /**
   * ⛔ A read that failed answered nothing, and nothing is not the same as free. The refusal has to
   * say which read it was, because ssh's own message says only that a host did not answer and leaves
   * the operator to work out that a guard was what asked.
   */
  it('refuses a target it could not read, and says the read is what failed', async () => {
    const sandbox = makeSandbox();
    writeFileSync(join(sandbox.root, SPEND_LEDGER), OWNER_LEDGER);
    sshCannotReachTarget(sandbox);

    const run = await runScript(sandbox, 'bench-on-host.sh', ['--script', 'bench:latency']);

    assert.notEqual(run.exitCode, 0, 'a target that could not be read was treated as free');
    assert.equal(existsSync(join(sandbox.remoteHome, REMOTE_BENCH_DIR)), false, 'the rsync ran before the refusal');
    assert.match(run.stderr, new RegExp(`could not be read for ${DEFAULT_CONTAINER}`));
    assert.match(run.stderr, /cannot be called free/);
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

  /**
   * ⛔⛔ A connect timeout bounds the handshake and nothing after it. This repository has already lost
   * six readings to an ssh that connected and then sat on a wedged agent, and every one of them read
   * as a product fault. An interrupt is the worst place for that: the operator has asked for the
   * terminal back, and the handler holding it is the only thing between them and it.
   */
  it('gives up on a stop that never answers, and says the container may still be running', async () => {
    const sandbox = benchSandbox();
    sshOnStop(sandbox, `exec sleep ${STOP_HANGS_SECONDS}`);

    const run = await interruptedRun(sandbox, ['--no-setup'], {
      env: { BENCH_STOP_DEADLINE_SECONDS: SHORT_STOP_DEADLINE_SECONDS },
    });

    assert.match(run.stderr, new RegExp(`did not answer within ${SHORT_STOP_DEADLINE_SECONDS}s`));
    assert.match(run.stderr, new RegExp(`${DEFAULT_CONTAINER} may still be running`));
    assert.match(run.stderr, new RegExp(`ssh manager-host 'docker stop ${DEFAULT_CONTAINER}'`));
    assert.equal(run.exitCode, EXIT_ON_INT, 'a stop that hit the cap changed the exit code');
  });

  /**
   * ⛔ The other half of the same fault, and the one a cap cannot fix on its own. An ssh that stops to
   * ask for a passphrase has not failed and has not hung, it is waiting on a human who is trying to
   * leave. `BatchMode=yes` turns every such prompt into an immediate refusal.
   */
  it('runs the stop under BatchMode, so a prompt cannot hold the terminal at all', async () => {
    const sandbox = benchSandbox();
    const argv = join(sandbox.root, 'stop-argv');
    sshOnStop(sandbox, `printf '%s\\n' "$*" > ${argv}`);

    await interruptedRun(sandbox, ['--no-setup']);

    const recorded = readFileSync(argv, 'utf8');
    assert.match(recorded, /-o BatchMode=yes/, `the stop can still be asked for a passphrase: ${recorded}`);
    assert.match(recorded, /-o ConnectTimeout=/, `the stop lost its connect timeout: ${recorded}`);
  });
});
