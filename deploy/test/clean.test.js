import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { ALL_REMOTE, forceRemovedIds, makeSandbox, removeSandboxes, removedVolumes } from './helpers/sandbox.js';

const execFileAsync = promisify(execFile);

after(removeSandboxes);

/**
 * Runs the real `clean.sh` inside a sandbox whose `docker` is a stub. Driving the script rather than
 * a extracted function is the point: the defect this file guards lives in the ordering between
 * compose and the sweep that follows it, and a unit test of either half would have missed it.
 */
async function runClean(sandbox, args) {
  const result = await execFileAsync('bash', [sandbox.cleanScript, '--yes', ...args], {
    env: { ...process.env, PATH: `${sandbox.binDir}:${process.env.PATH ?? ''}` },
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

describe('clean.sh straggler sweep (OPS-2)', () => {
  // The sweep exists to catch containers `compose down` could not see, so it filters on the compose
  // project label. That label is on every container in the stack, so with a service named on the
  // command line it force-removed the ones the operator did not ask about: cleaning one service
  // took the live stack with it, after compose had already done the right thing.
  it('force-removes only the named service, not the rest of the stack', async () => {
    const sandbox = makeSandbox();

    await runClean(sandbox, ['stream-uploader']);

    assert.deepEqual(
      forceRemovedIds(sandbox.calls()),
      ['c-stream-uploader'],
      'cleaning one service force-removed containers belonging to other services, which is the live stack',
    );
  });

  it('force-removes only the named services when several are given', async () => {
    const sandbox = makeSandbox();

    await runClean(sandbox, ['srs', 'client']);

    assert.deepEqual(forceRemovedIds(sandbox.calls()).sort(), ['c-client', 'c-srs']);
  });

  // The other half of the fix, and the one a narrow patch breaks. Scoping the sweep must not cost
  // the drift safety net: with no service named, the operator asked for the whole project, so a
  // container whose service definition has since vanished from the config still has to be caught.
  it('still sweeps the whole project when no service is named', async () => {
    const sandbox = makeSandbox();

    await runClean(sandbox, []);

    assert.deepEqual(
      forceRemovedIds(sandbox.calls()).sort(),
      ['c-bee-gateway', 'c-bee-uploader', 'c-client', 'c-srs', 'c-stream-uploader'],
      'an unfiltered clean must still catch stragglers compose could no longer see',
    );
  });

  // A scoped sweep that asked docker for the wrong project would quietly remove nothing and pass
  // every assertion above, since the stub answers only its own project.
  it('scopes the sweep to the profile it was given', async () => {
    const sandbox = makeSandbox({ project: 'streamer1' });

    await runClean(sandbox, ['--profile=streamer1', 'srs']);

    assert.deepEqual(forceRemovedIds(sandbox.calls()), ['c-srs']);
  });

  it('leaves the compose down call alone, so a service clean still goes through compose first', async () => {
    const sandbox = makeSandbox();

    await runClean(sandbox, ['srs']);

    const down = sandbox.calls().find((call) => call.startsWith('compose ') && call.includes(' down'));
    assert.ok(down, `no compose down was issued; calls: ${sandbox.calls().join(' | ')}`);
    assert.match(down, /--profile srs/);
    assert.doesNotMatch(down, /--profile client/);
  });

  // There are three sweeps, not one, and fixing the one the finding named would have left the other
  // two destroying the stack. This is the copy that runs over ssh, and it is a separate
  // implementation rather than a call into the same helper, so it needs its own proof.
  it('force-removes only the named service on a remote host', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE });

    await runClean(sandbox, ['srs']);

    assert.deepEqual(
      forceRemovedIds(sandbox.remoteCalls()),
      ['c-srs'],
      'cleaning one service on a remote host force-removed the rest of that host',
    );
  });

  it('still sweeps the whole project on a remote host when no service is named', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE });

    await runClean(sandbox, []);

    assert.deepEqual(forceRemovedIds(sandbox.remoteCalls()).sort(), [
      'c-bee-gateway',
      'c-bee-uploader',
      'c-client',
      'c-srs',
      'c-stream-uploader',
    ]);
  });

  // The third sweep. It fires when config.json no longer lists localhost at all, which is exactly
  // when an operator is least expecting local containers to be touched.
  it('force-removes only the named service in the post-loop local sweep', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE });

    await runClean(sandbox, ['srs']);

    assert.deepEqual(
      forceRemovedIds(sandbox.calls()),
      ['c-srs'],
      'the sweep that runs when config.json points everything remote took the whole local project',
    );
  });

  // Volumes carry the project label and have no per-service equivalent, so a service-scoped clean
  // cannot tell one service's data from another's. Removing them anyway destroys recordings the
  // operator never named, and `--volumes` is the flag most likely to be typed in a hurry.
  it('refuses to remove volumes when the clean is scoped to a service', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE });

    await runClean(sandbox, ['--volumes', 'srs']);

    assert.deepEqual(
      removedVolumes(sandbox.calls()),
      [],
      "a service-scoped clean removed project-wide volumes, which is every other service's data too",
    );
  });

  it('still removes volumes when the whole project is cleaned with --volumes', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE });

    await runClean(sandbox, ['--volumes']);

    assert.deepEqual(removedVolumes(sandbox.calls()), ['v-uploader-state']);
  });
});
