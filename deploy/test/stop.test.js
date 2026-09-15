import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScript, runScriptOk } from './helpers/sandbox.js';

after(removeSandboxes);

const COMPOSE = join(dirname(dirname(fileURLToPath(import.meta.url))), 'docker-compose.yml');

function composeCalls(calls) {
  return calls.filter((call) => call.startsWith('compose '));
}

/** The service list a compose subcommand was handed, which is the only thing `stop` actually honours. */
function trailingServices(call, subcommand) {
  const at = call.split(/\s+/).indexOf(subcommand);
  return at === -1 ? [] : call.split(/\s+/).slice(at + 1);
}

describe('stop.sh service filter (OPS-3)', () => {
  // `parse_profile_args` puts the non-flag argv into REST_ARGS and the script even re-applies it
  // with `set --`, and then every loop below reads the target's full service list instead. An
  // operator stopping one service took the whole stack down, with the script printing the list of
  // everything it was about to stop as if that had been asked for.
  //
  // The assertion is on the subcommand rather than on `--profile` flags on purpose. Compose ignores
  // `--profile` when choosing what `down` removes, measured against v5.3.1 in the OPS-2 work, so a
  // test that only checked the flags would pass with the whole stack still coming down.
  it('never issues compose down when a service is named', async () => {
    const sandbox = makeSandbox();

    await runScriptOk(sandbox, 'stop.sh', ['stream-uploader']);

    const teardown = composeCalls(sandbox.calls());
    assert.ok(teardown.length > 0, 'no compose call at all was issued');
    for (const call of teardown) {
      assert.doesNotMatch(
        call,
        /(^|\s)down(\s|$)/,
        `a service stop reached compose down, which stops every co-located service: ${call}`,
      );
    }
  });

  it('stops the named service through an explicit service list', async () => {
    const sandbox = makeSandbox();

    await runScriptOk(sandbox, 'stop.sh', ['stream-uploader']);

    const stopped = composeCalls(sandbox.calls()).find((call) => / stop(\s|$)/.test(call));
    assert.ok(stopped, `no compose stop was issued; calls: ${sandbox.calls().join(' | ')}`);
    assert.deepEqual(trailingServices(stopped, 'stop'), ['stream-uploader']);
  });

  it('stops only the named services when several are given', async () => {
    const sandbox = makeSandbox();

    await runScriptOk(sandbox, 'stop.sh', ['srs', 'client']);

    const stopped = composeCalls(sandbox.calls()).find((call) => / stop(\s|$)/.test(call));
    assert.ok(stopped, `no compose stop was issued; calls: ${sandbox.calls().join(' | ')}`);
    assert.deepEqual(trailingServices(stopped, 'stop').sort(), ['client', 'srs']);
  });

  // The other half, and the one a narrow patch breaks. With no service named the operator asked for
  // the whole target, so `down` stays: it is what removes the project's network rather than leaving
  // it behind on every full stop.
  it('still uses compose down when no service is named', async () => {
    const sandbox = makeSandbox();

    await runScriptOk(sandbox, 'stop.sh', []);

    const teardown = composeCalls(sandbox.calls()).find((call) => / down(\s|$)/.test(call));
    assert.ok(teardown, `no compose down was issued; calls: ${sandbox.calls().join(' | ')}`);
  });

  // Not a duplicate of the local case: the remote branch builds its own compose command inside a
  // heredoc, so it can drift from the local one while every assertion above still passes. That is
  // exactly how OPS-2 had three sweeps to fix rather than one.
  it('stops only the named service on a remote host', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE });

    await runScriptOk(sandbox, 'stop.sh', ['srs']);

    const teardown = composeCalls(sandbox.remoteCalls());
    assert.ok(teardown.length > 0, 'the remote host was sent no compose call at all');
    for (const call of teardown) {
      assert.doesNotMatch(call, /(^|\s)down(\s|$)/, `a remote service stop reached compose down: ${call}`);
    }
    const stopped = teardown.find((call) => / stop(\s|$)/.test(call));
    assert.ok(stopped, `no remote compose stop was issued; calls: ${sandbox.remoteCalls().join(' | ')}`);
    assert.deepEqual(trailingServices(stopped, 'stop'), ['srs']);
  });

  // A service that is not in the stack has to be a refusal rather than a no-op. Compose treats an
  // unknown service in a `stop` list as an error but an unknown `--profile` as "select nothing", and
  // the script should not depend on which of those it happens to hit: a typo must never report
  // success while the service the operator meant to stop keeps running.
  it('refuses an unknown service name and reaches docker for nothing', async () => {
    const sandbox = makeSandbox();

    const run = await runScript(sandbox, 'stop.sh', ['strem-uploader']);

    assert.notEqual(run.exitCode, 0, 'a misspelled service name was accepted');
    assert.match(`${run.stdout}${run.stderr}`, /Unknown service: strem-uploader/);
    assert.deepEqual(sandbox.calls(), [], `docker was called despite the refusal: ${sandbox.calls().join(' | ')}`);
  });

  // The filter has to narrow per target, not only overall. With the stack split across two hosts,
  // handing the service list to a target that does not run it makes compose fail with "no such
  // service", and the operator sees an error from the one host that was never involved.
  it('touches only the target that runs the named service', async () => {
    const sandbox = makeSandbox({ config: { services: { srs: 'streamhost', client: 'localhost' } } });

    await runScriptOk(sandbox, 'stop.sh', ['srs']);

    assert.deepEqual(sandbox.calls(), [], `the local host was touched for a remote service: ${sandbox.calls()}`);
    const stopped = sandbox.remoteCalls().find((call) => / stop(\s|$)/.test(call));
    assert.ok(stopped, `no remote compose stop was issued; calls: ${sandbox.remoteCalls().join(' | ')}`);
  });

  // A service the config disables is a different case from a misspelled one: the name is real, so
  // the refusal above must not fire, and there is nothing running to stop.
  it('stops nothing when the named service is disabled on every target', async () => {
    const sandbox = makeSandbox({ config: { services: { srs: 'localhost', ome: false } } });

    const run = await runScriptOk(sandbox, 'stop.sh', ['ome']);

    assert.deepEqual(composeCalls(sandbox.calls()), [], 'a disabled service produced a compose call');
    assert.match(run.stdout, /No services to stop/, 'stopping nothing was reported as stopping everything');
    assert.doesNotMatch(run.stdout, /All services stopped/);
  });

  // The same shape for a service that genuinely is running, just not anywhere docker can reach it.
  // `native` is a documented mode, so an operator naming it is not making a mistake, and telling
  // them "All services stopped" after touching nothing is the worst available answer.
  it('says so rather than claiming success when the named service runs natively', async () => {
    const sandbox = makeSandbox({ config: { services: { srs: 'localhost', 'stream-uploader': 'native' } } });

    const run = await runScriptOk(sandbox, 'stop.sh', ['stream-uploader']);

    assert.deepEqual(sandbox.calls(), [], 'a native service produced a docker call');
    assert.match(run.stdout, /No services to stop/);
  });
});

/** Docker's own default, and what every service on this stack gets unless the file says otherwise. */
const DEFAULT_GRACE_SECONDS = 10;

/**
 * One service block of the compose file, as text, walked by indentation for the reason
 * `imageNames.test.js` and `uploaderEnv.test.js` both give: adding a YAML parser to a check that
 * exists to catch a missing line means the check and the deployment no longer read the file the same
 * way. Two levels, both fixed by the file's own style, a service name at two spaces and its keys at
 * four.
 */
function serviceBlock(compose, service) {
  const lines = compose.split('\n');
  const start = lines.indexOf(`  ${service}:`);
  assert.notEqual(start, -1, `${service} is not in the compose file`);
  const after = lines.slice(start + 1).findIndex((line) => /^ {2}\S/.test(line));
  return lines.slice(start + 1, after === -1 ? undefined : start + 1 + after).join('\n');
}

/**
 * ⛔ Every stop of the uploader is a drain, and docker kills a drain at ten seconds.
 *
 * SIGTERM runs `ServiceLifecycle.shutdown` into `StreamOrchestrator.cleanup`, which finalizes every
 * live stream over the network, one `stopStream` per rung. Killed halfway, some rungs are finalized
 * and the rest hold recovery entries that nothing clears until a replacement container starts
 * successfully and picks them up a minute later. `docker compose up -d` recreating the service is the
 * everyday way into that, so a deploy was routinely cutting its own drain, and `stop.sh` is the other
 * way in.
 */
describe('the uploader is given time to finish its drain', () => {
  it('declares a stop_grace_period long enough for a four-rung finalize', () => {
    const uploader = serviceBlock(readFileSync(COMPOSE, 'utf8'), 'stream-uploader');
    const grace = /^ {4}stop_grace_period: (\d+)s$/m.exec(uploader);

    assert.ok(
      grace,
      `the uploader takes docker's ${DEFAULT_GRACE_SECONDS}s default, which SIGKILLs a drain in progress`,
    );
    assert.ok(
      Number(grace[1]) > DEFAULT_GRACE_SECONDS,
      `${grace[1]}s is no more than the default this line exists to raise`,
    );
  });
});
