import assert from 'node:assert/strict';
import { chmodSync,readFileSync, writeFileSync  } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

/**
 * That a poll which could not be taken is not read as a broadcast that ended.
 *
 * `publish-clock.sh` starts ffmpeg detached and then waits by polling `docker inspect` over ssh, so
 * that a dropped connection costs one poll instead of the run. It did not. `|| echo missing` guards
 * `docker inspect` failing on the far side and cannot guard `ssh` failing on the near side: that
 * exits 255 having written only to stderr, so the command substitution came back empty, the `case`
 * fell through to `break`, and the loop left while ffmpeg was still broadcasting. `.State.ExitCode`
 * then read 0, because it reads 0 for a *running* container, so the script deleted the live
 * publisher and reported `publish finished` with exit 0.
 *
 * These drive the real script with a stubbed `ssh` that fails on demand, and assert on what happened
 * to the container rather than on the exit code, because the exit code was 0 in the broken case too.
 */

const CONTAINER_RUNS_FOR_POLLS = 5;

/**
 * An `ssh` that models one container and fails on the invocations named in `failOn`.
 *
 * Records whether a `docker rm -f` ever arrived while the container was still running, which is the
 * harm rather than a proxy for it: the old code deleted a publisher mid-broadcast.
 */
function sshStubFailingOn(statePath, failOn) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const STATE = ${JSON.stringify(statePath)};
const FAIL_ON = ${JSON.stringify(failOn)};
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));

state.calls += 1;
const call = state.calls;
const body = fs.readFileSync(0, 'utf8');

function save() {
  fs.writeFileSync(STATE, JSON.stringify(state));
}

if (FAIL_ON.includes(call)) {
  // What a refused connection looks like: stderr only, exit 255, nothing on stdout.
  process.stderr.write('ssh: connect to host streamhost port 22: Connection refused\\n');
  save();
  process.exit(255);
}

if (body.includes('.State.Running')) {
  state.runningPolls += 1;
  const stillRunning = state.runningPolls <= ${CONTAINER_RUNS_FOR_POLLS};
  state.running = stillRunning;
  save();
  process.stdout.write(stillRunning ? 'true\\n' : 'false\\n');
  process.exit(0);
}

if (body.includes('.State.ExitCode')) {
  save();
  process.stdout.write('0\\n');
  process.exit(0);
}

if (body.includes('docker rm -f')) {
  if (state.running) {
    state.killedWhileLive = true;
  }
  save();
  process.exit(0);
}

save();
process.exit(0);
`;
}

function sandboxWithSsh(failOn) {
  const sandbox = makeSandbox({ config: ALL_REMOTE });
  const statePath = join(sandbox.root, 'ssh-state.json');
  writeFileSync(statePath, JSON.stringify({ calls: 0, runningPolls: 0, running: true, killedWhileLive: false }));
  const sshPath = join(sandbox.binDir, 'ssh');
  writeFileSync(sshPath, sshStubFailingOn(statePath, failOn));
  chmodSync(sshPath, 0o755);

  // The wait sleeps ten seconds between polls, which is right for an hour-long broadcast and wrong
  // for a test. Stubbed rather than parameterised, so the script under test keeps its real constant.
  const sleepPath = join(sandbox.binDir, 'sleep');
  writeFileSync(sleepPath, '#!/bin/sh\nexit 0\n');
  chmodSync(sleepPath, 0o755);

  return { sandbox, readState: () => JSON.parse(readFileSync(statePath, 'utf8')) };
}

describe('publish-clock.sh waiting on a detached publisher', () => {
  after(removeSandboxes);

  it('survives a dropped poll instead of ending the broadcast on it', async () => {
    // Fails the third ssh call, which lands inside the wait loop while ffmpeg is still going.
    const { sandbox, readState } = sandboxWithSsh([3]);

    const run = await runScript(sandbox, 'publish-clock.sh', ['--seconds=1']);
    const state = readState();

    assert.equal(
      state.killedWhileLive,
      false,
      'the publisher was deleted while it was still broadcasting, which is the whole defect',
    );
    assert.ok(
      state.runningPolls > CONTAINER_RUNS_FOR_POLLS,
      `the wait stopped at the failed poll rather than retrying it: only ${state.runningPolls} polls were taken`,
    );
    assert.equal(run.exitCode, 0, `a single dropped poll must not fail the run: ${run.stdout}${run.stderr}`);
  });

  it('refuses to call it finished when the polls stop being answerable at all', async () => {
    // Six consecutive failures, which is the bound. A host that is genuinely gone must not be waited
    // on for the rest of the broadcast, and must not be reported as a broadcast that completed.
    const { sandbox, readState } = sandboxWithSsh([3, 4, 5, 6, 7, 8]);

    const run = await runScript(sandbox, 'publish-clock.sh', ['--seconds=1']);

    assert.notEqual(run.exitCode, 0, 'a wait that could not be taken must not report success');
    assert.match(
      `${run.stdout}${run.stderr}`,
      /publish UNKNOWN/,
      'the operator has to be told the broadcast may still be running, not that it finished',
    );
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /publish finished/);
    assert.equal(readState().killedWhileLive, false);
  });
});

/**
 * ⛔⛔⛔ THE ALARM PR #188 REMOVED IS STILL FIRING, THROUGH A SECOND PATH.
 *
 * #188 taught this script that a container removed by its own harness is a requested stop rather than
 * a failed broadcast, and it decides that by comparing the inspect result against the literal string
 * `missing`. A real `docker inspect` of a container that is gone writes an EMPTY LINE to stdout and
 * then exits non-zero, so the `|| echo missing` guarding it appends a second line and the value that
 * comes back is "\nmissing". The equality misses, the vanished branch is skipped, and the run falls
 * through to the generic failure wording.
 *
 * Observed on the floor-check sitting of 2026-08-14, in a broadcast this harness stopped on purpose:
 *
 *   ✗ publish FAILED (exit
 *   missing). Nothing usable was broadcast, so do not measure against this.
 *
 * ⭐⭐⭐ Gate lesson AHL is the whole point: an alarm that fires on every successful stop is one the
 * operator learns to skip, and the next time it is real nobody reads it.
 */
function sshStubVanishingAt(statePath, stopFilePath, requestStop) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const STATE = ${JSON.stringify(statePath)};
const STOP_FILE = ${JSON.stringify(stopFilePath)};
const REQUEST_STOP = ${JSON.stringify(Boolean(requestStop))};
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
state.calls += 1;
const body = fs.readFileSync(0, 'utf8');
function save() { fs.writeFileSync(STATE, JSON.stringify(state)); }

// ⛔ Two lines, not one. This is the shape the real docker emits and the reason the comparison failed.
const gone = () => '\\nmissing\\n';

if (body.includes('.State.Running')) {
  state.runningPolls += 1;
  if (state.runningPolls <= ${CONTAINER_RUNS_FOR_POLLS}) {
    state.running = true;
    save();
    process.stdout.write('true\\n');
    process.exit(0);
  }
  // ⛔⛔ The marker is written BEFORE the container goes, which is the order publisher-stop.sh
  // requires of every caller and the only order in which this can be told apart from a crash.
  if (REQUEST_STOP) { fs.writeFileSync(STOP_FILE, 'the harness stopped its own publisher\\n'); }
  state.running = false;
  save();
  process.stdout.write(gone());
  process.exit(0);
}

if (body.includes('.State.ExitCode')) {
  save();
  process.stdout.write(gone());
  process.exit(0);
}

if (body.includes('docker rm -f')) {
  if (state.running) { state.killedWhileLive = true; }
  save();
  process.exit(0);
}
save();
process.exit(0);
`;
}

function sandboxWithVanishingContainer(requestStop) {
  const sandbox = makeSandbox({ config: ALL_REMOTE });
  const statePath = join(sandbox.root, 'ssh-state.json');
  const stopFile = join(sandbox.root, 'PUBLISHER-STOP-REQUESTED');
  writeFileSync(statePath, JSON.stringify({ calls: 0, runningPolls: 0, running: true, killedWhileLive: false }));
  const sshPath = join(sandbox.binDir, 'ssh');
  writeFileSync(sshPath, sshStubVanishingAt(statePath, stopFile, requestStop));
  chmodSync(sshPath, 0o755);
  const sleepPath = join(sandbox.binDir, 'sleep');
  writeFileSync(sleepPath, '#!/bin/sh\nexit 0\n');
  chmodSync(sleepPath, 0o755);
  return { sandbox, stopFile };
}

describe('a publisher container that was removed while this script watched it', () => {
  after(removeSandboxes);

  it('reads a blank line before missing as the container being gone, not as an exit status', async () => {
    const { sandbox, stopFile } = sandboxWithVanishingContainer(true);

    const run = await runScript(sandbox, 'publish-clock.sh', ['--seconds=1', `--stop-file=${stopFile}`]);
    const output = `${run.stdout}${run.stderr}`;

    assert.doesNotMatch(output, /publish FAILED/, 'a stop this harness asked for was reported as a failed broadcast');
    assert.doesNotMatch(
      output,
      /Nothing usable was broadcast/,
      'it told the operator to discard a broadcast it stopped itself',
    );
    assert.match(output, /stopped on request/);
    assert.equal(run.exitCode, 0, output);
  });

  it('still fails loudly when nothing asked for the stop, so the fix above cannot mute a real one', async () => {
    const { sandbox, stopFile } = sandboxWithVanishingContainer(false);

    const run = await runScript(sandbox, 'publish-clock.sh', ['--seconds=1', `--stop-file=${stopFile}`]);
    const output = `${run.stdout}${run.stderr}`;

    assert.notEqual(run.exitCode, 0, 'a container removed by somebody else is a real failure');
    assert.match(output, /publish FAILED/);
    assert.match(output, /went away and nothing asked this script to stop/);
  });
});
