import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = join(ROOT, 'deploy/scripts');
const PUBLISHER = 'publish-clock.sh';

/**
 * That a publisher this project tore down ON PURPOSE stops reading as a publisher that died.
 *
 * ⛔⛔⛔ THE ALARM FIRED ON EVERY SUCCESSFUL SITTING. A harness budgets slack per arm and stops the
 * broadcast the moment its arms are done, by removing the container `publish-clock.sh` is watching.
 * With nothing left to read an exit status from it synthesised 127, so the #93 sitting of 2026-08-13
 * ended with "publish FAILED (exit 127). Nothing usable was broadcast" after eight good arms, 363,952
 * push-synced chunks and 0.7321 BZZ, with 595s of the broadcast unused.
 *
 * ⭐⭐⭐ An alarm that fires on every good run is one the operator learns to skip, and the next time it
 * is real nobody reads it. That is gate lesson AHL, and it is why HALF the cases below are about the
 * quieting NOT working: a container that exits non-zero is still loud with a marker sitting next to
 * it, and a marker left behind by a previous sitting cannot vouch for this one.
 *
 * These drive the real `publish-clock.sh` against a stubbed `docker` that models one container's
 * lifecycle, rather than asserting on a reading of the script.
 */

/** Poll at which the stubbed container does something. Late enough that the wait has really looped. */
const ACT_AT_POLL = 3;

/**
 * A `docker` that models one publisher container, and the harness actions that happen to it.
 *
 * The plan fires at a poll rather than at a wall-clock moment so the run is deterministic, and it
 * writes the marker BEFORE removing the container because that is the order `stop_publisher` does it
 * in. Reversing those two is exactly the race the ordering rule in `publisher-stop.sh` exists for, so
 * a stub that got it wrong would be testing a harness this repo does not have.
 */
function dockerStub({
  stateDir,
  markerPath,
  markerAtPoll = 0,
  vanishAtPoll = 0,
  exitAtPoll = 0,
  exitCode = 0,
  signalAtPoll = 0,
}) {
  const q = (value) => JSON.stringify(value);
  return `#!/bin/bash
STATE=${q(stateDir)}
MARKER=${q(markerPath)}
CONTAINER="$STATE/container"
POLLS="$STATE/polls"

case "$1" in
  run)
    echo running > "$CONTAINER"
    echo 0 > "$POLLS"
    exit 0
    ;;
  inspect)
    case "$*" in
      *State.Running*)
        polls=$(( $(cat "$POLLS") + 1 ))
        echo "$polls" > "$POLLS"
        if [ ${markerAtPoll} -ne 0 ] && [ "$polls" -ge ${markerAtPoll} ]; then
          printf 'stopped on purpose\\n' > "$MARKER"
        fi
        if [ ${vanishAtPoll} -ne 0 ] && [ "$polls" -ge ${vanishAtPoll} ]; then
          rm -f "$CONTAINER"
        fi
        if [ ${exitAtPoll} -ne 0 ] && [ "$polls" -ge ${exitAtPoll} ]; then
          echo ${exitCode} > "$CONTAINER"
        fi
        # An operator's Ctrl-C, delivered without needing to race the script from the test. The
        # container is named after the publisher's own pid, so it is in the name being asked about.
        if [ ${signalAtPoll} -ne 0 ] && [ "$polls" -eq ${signalAtPoll} ]; then
          kill -TERM "\${4##*-}" 2>/dev/null || true
        fi
        # What the daemon does for a name it does not have: stderr, and a non-zero status.
        [ -f "$CONTAINER" ] || { echo "Error: No such object: $4" >&2; exit 1; }
        if [ "$(cat "$CONTAINER")" = running ]; then echo true; else echo false; fi
        exit 0
        ;;
      *State.ExitCode*)
        [ -f "$CONTAINER" ] || { echo "Error: No such object: $4" >&2; exit 1; }
        code="$(cat "$CONTAINER")"
        # 0 for a running container, which is the reason the wait may not ask this while it is live.
        if [ "$code" = running ]; then echo 0; else echo "$code"; fi
        exit 0
        ;;
    esac
    exit 0
    ;;
  rm)
    rm -f "$CONTAINER"
    exit 0
    ;;
  logs)
    [ -f "$CONTAINER" ] || { echo "Error response from daemon: No such container: $4" >&2; exit 1; }
    exit 0
    ;;
esac
exit 0
`;
}

/** A sandbox whose `docker` follows `plan`, with the poll sleep stubbed away. */
function sandboxFor(plan) {
  const sandbox = makeSandbox();
  const markerPath = join(sandbox.root, 'PUBLISHER-STOP-REQUESTED');
  writeFileSync(join(sandbox.root, 'polls'), '0');

  writeFileSync(join(sandbox.binDir, 'docker'), dockerStub({ stateDir: sandbox.root, markerPath, ...plan }));
  chmodSync(join(sandbox.binDir, 'docker'), 0o755);

  // The wait sleeps ten seconds between polls, which is right for an hour-long broadcast and wrong
  // for a test. Stubbed rather than parameterised, so the script under test keeps its real constant.
  writeFileSync(join(sandbox.binDir, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(sandbox.binDir, 'sleep'), 0o755);

  return { sandbox, markerPath };
}

async function publish({ sandbox, markerPath }, { staleMarker = false } = {}) {
  if (staleMarker) {
    writeFileSync(markerPath, 'left behind by an earlier sitting\n');
  }
  const run = await runScript(sandbox, 'publish-clock.sh', [
    '--host=localhost',
    '--seconds=1',
    `--stop-file=${markerPath}`,
  ]);
  return { ...run, output: `${run.stdout}${run.stderr}`, markerPath };
}

describe('a publisher torn down on purpose', () => {
  after(removeSandboxes);

  it('reports a stop it was asked for as a stop, not as a failed publish', async () => {
    // The sitting that produced the alarm: the marker is written and the container removed, in the
    // order `stop_publisher` does it, while the broadcast is still perfectly healthy.
    const run = await publish(sandboxFor({ markerAtPoll: ACT_AT_POLL, vanishAtPoll: ACT_AT_POLL }));

    assert.equal(run.exitCode, 0, `a teardown this project asked for is not a failure: ${run.output}`);
    assert.match(run.output, /publish stopped on request after \d+s of a \d+s broadcast/);
    assert.doesNotMatch(run.output, /publish FAILED/, 'this is the alarm that fired on every good run');
    assert.doesNotMatch(
      run.output,
      /Nothing usable was broadcast/,
      'the arms had already watched their full 360s, so this sentence was the false part',
    );
  });

  /**
   * ⛔⛔⛔ The case that matters most, because getting it wrong trades a noisy alarm for a silent one.
   * A publisher that dies mid-broadcast exits non-zero and its container stays, so the status is read
   * straight off it and the marker is never consulted. Nothing a harness writes can quiet this.
   */
  it('still fails loudly when the publisher died, even with a stop marker sitting next to it', async () => {
    const run = await publish(sandboxFor({ markerAtPoll: ACT_AT_POLL - 1, exitAtPoll: ACT_AT_POLL, exitCode: 1 }));

    assert.notEqual(run.exitCode, 0, `a publisher that died must not pass as a requested stop: ${run.output}`);
    assert.match(run.output, /publish FAILED \(exit 1\)/);
    assert.match(run.output, /Nothing usable was broadcast/);
    assert.ok(existsSync(run.markerPath), 'the marker was present the whole time and changed nothing');
  });

  /**
   * ⛔⛔ The other way the quieting could swallow a real failure. `phase06-light-vs-ultralight.sh`
   * writes every sitting into one fixed `OUT_DIR`, so a marker outliving its run is not hypothetical:
   * without the clear at startup, one sitting's teardown would vouch for the next one's death.
   */
  it('does not let a previous sitting’s marker vouch for this one', async () => {
    const run = await publish(sandboxFor({ vanishAtPoll: ACT_AT_POLL }), { staleMarker: true });

    assert.notEqual(run.exitCode, 0, `a stale marker must not quiet a container nobody asked to go: ${run.output}`);
    assert.match(run.output, /nothing asked this script to stop/);
  });

  /**
   * A container that goes without a request is still a failure, and a different one from the wording
   * this used to print. "Another publisher still holding the stream id" names a cause it cannot know,
   * and "nothing usable was broadcast" claims to know how much was, which nothing here does.
   */
  it('fails, and says what it does not know, when the container goes and nobody asked', async () => {
    const run = await publish(sandboxFor({ vanishAtPoll: ACT_AT_POLL }));

    assert.notEqual(run.exitCode, 0);
    assert.match(run.output, /the publisher container went away and nothing asked this script to stop/);
    assert.match(run.output, /How much was broadcast is unknown/);
    assert.doesNotMatch(run.output, /still holding/, 'that names a cause this branch cannot know');
  });

  /**
   * The second route to an intentional stop, and the one an operator takes. The handler used to fall
   * back into the wait, which then found the container the handler had just removed and reported the
   * interruption as a failed broadcast, so a Ctrl-C printed the same alarm by a different path.
   */
  it('treats a Ctrl-C as a stop it was asked for, rather than falling back into the wait', async () => {
    const run = await publish(sandboxFor({ signalAtPoll: ACT_AT_POLL }));

    assert.equal(run.exitCode, 0, `an interruption the operator asked for is not a failure: ${run.output}`);
    assert.match(run.output, /publish stopped on request after \d+s of a \d+s broadcast/);
    assert.doesNotMatch(run.output, /publish FAILED/);
  });

  it('still reports a broadcast that ran to its end as finished', async () => {
    const run = await publish(sandboxFor({ exitAtPoll: ACT_AT_POLL, exitCode: 0 }));

    assert.equal(run.exitCode, 0, run.output);
    assert.match(run.output, /publish finished/);
    assert.doesNotMatch(run.output, /stopped on request/);
  });
});

/**
 * That the harnesses actually say it, discovered rather than listed, so a new driver cannot opt out.
 *
 * ⛔ The reading half of this fix is worth nothing on its own: a publisher started without
 * `--stop-file=` has no way to tell the two cases apart and prints the false alarm exactly as before.
 * All three drivers had the same teardown and the same exposure.
 */
function driversThatPublish() {
  return readdirSync(SCRIPTS)
    .filter((name) => name.endsWith('.sh') && name !== PUBLISHER)
    .filter((name) => {
      const body = readFileSync(join(SCRIPTS, name), 'utf8');
      // The invocation path, not the bare name: every one of these files mentions the publisher in
      // prose, and the publisher's own usage line names itself.
      return body.startsWith('#!') && body.includes(`deploy/scripts/${PUBLISHER}`);
    });
}

/** The body of a script's `stop_publisher`, up to the closing brace in the first column. */
function stopPublisherBody(body) {
  const start = body.indexOf('stop_publisher() {');
  assert.notEqual(start, -1, 'a driver that starts a publisher has to have a way to stop one');
  const end = body.indexOf('\n}', start);
  return body.slice(start, end);
}

describe('every driver that starts a publisher says when it stops one', () => {
  it('finds the drivers, so an empty sweep cannot pass as agreement', () => {
    assert.ok(driversThatPublish().length >= 3, `expected the publishing drivers, found ${driversThatPublish()}`);
  });

  for (const name of driversThatPublish()) {
    it(`${name} hands the publisher a stop file and writes it before the teardown`, () => {
      const body = readFileSync(join(SCRIPTS, name), 'utf8');

      assert.match(body, /publisher-stop\.sh/, 'the contract lives in one file, and this must source it');
      assert.match(body, /--stop-file=\$\{PUBLISHER_STOP_FILE\}/);

      // ⛔⛔ Order, not merely presence. The publisher polls its own container, so a marker written
      // after the removal leaves a window in which it reports this teardown as a failed publish.
      const teardown = stopPublisherBody(body);
      const requestedAt = teardown.indexOf('request_publisher_stop');
      assert.notEqual(requestedAt, -1, `${name} removes a publisher without ever saying it meant to`);
      for (const ending of ['docker rm -f', 'kill "${PUBLISHER_PID}"']) {
        const endsAt = teardown.indexOf(ending);
        if (endsAt !== -1) {
          assert.ok(requestedAt < endsAt, `${name} runs \`${ending}\` before it requests the stop`);
        }
      }
    });
  }

  it('defines the request in exactly one file, so the two sides cannot drift', () => {
    const offenders = readdirSync(SCRIPTS)
      .filter((name) => name.endsWith('.sh') && name !== 'publisher-stop.sh')
      .filter((name) => /^\s*(request_publisher_stop)\s*\(\)/m.test(readFileSync(join(SCRIPTS, name), 'utf8')));

    assert.deepEqual(offenders, [], 'a second definition is how the writer and the reader stop agreeing');
  });
});
