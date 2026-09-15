import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScript, runScriptOk } from './helpers/sandbox.js';

after(removeSandboxes);

/**
 * Old enough that naming it is the difference between deploying a build and deploying whatever the
 * tree was last left holding. A local time, because that is what `stat` prints.
 */
const DIST_MODIFIED = new Date('2026-01-02T03:04:05');

function seedDist(sandbox) {
  const dist = join(sandbox.root, 'packages', 'stream-uploader', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.js'), '');
  utimesSync(dist, DIST_MODIFIED, DIST_MODIFIED);
}

/**
 * That a host with no pnpm deploys the build output it was shipped rather than dying inside a build.
 *
 * streaming-infra-manager runs this script inside its api container, which installs bash, jq, git,
 * docker-cli, compose, rsync and openssh-client and never enables corepack. It builds the uploader on
 * the operator's machine and rsyncs the result, and `Dockerfile.uploader` copies `dist/` rather than
 * building it, so a deployment host needs a dist and never a toolchain. Its profiles are local today
 * and a local deploy whose dist is present never reaches pnpm, so the first remote profile it deploys
 * would be the first run to report `pnpm: command not found` from inside a build function.
 */
describe('a deploy on a host without pnpm', () => {
  it('ships the dist that is there and names how old it is', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE, pnpm: false });
    seedDist(sandbox);

    const run = await runScriptOk(sandbox, 'deploy.sh', ['stream-uploader']);

    assert.deepEqual(sandbox.pnpmCalls(), [], 'a host with no pnpm was asked to run one');
    assert.match(run.stdout, /packages\/stream-uploader\/dist/);
    assert.match(run.stdout, /2026-01-02 03:04:05/, 'the dist was deployed without saying how stale it is');
  });

  it('refuses with a pointer when there is no dist either', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE, pnpm: false });

    const run = await runScript(sandbox, 'deploy.sh', ['stream-uploader']);

    assert.equal(run.exitCode, 1, `expected a refusal: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /packages\/stream-uploader\/dist is missing/);
    assert.match(run.stdout, /pnpm install && pnpm build/, 'the refusal does not say how to get a dist');
  });
});

describe('a deploy on a host with pnpm', () => {
  it('still rebuilds before a remote deploy', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE });
    seedDist(sandbox);

    await runScriptOk(sandbox, 'deploy.sh', ['stream-uploader']);

    assert.deepEqual(sandbox.pnpmCalls(), ['install', 'build']);
  });

  it('skips the build for a local deploy whose dist is already there', async () => {
    const sandbox = makeSandbox();
    seedDist(sandbox);

    await runScriptOk(sandbox, 'deploy.sh', ['stream-uploader']);

    assert.deepEqual(sandbox.pnpmCalls(), []);
  });
});
