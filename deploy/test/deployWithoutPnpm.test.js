import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScript, runScriptOk } from './helpers/sandbox.js';

after(removeSandboxes);

/**
 * When the build last wrote the file the image runs. Old enough that naming it is the difference
 * between deploying a build and deploying whatever the tree was last left holding. A local time,
 * because that is what `stat` prints.
 */
const DIST_BUILT = new Date('2026-01-02T03:04:05');

/**
 * Later, and on the directory rather than on the build output, because the two move apart and only
 * one of them is the build's age. `pnpm build` rewrites `dist/index.js` in place and a directory's
 * time follows entries being added or removed, so a line that dates the directory reports a fresh
 * rebuild as old. This value is here so that line cannot pass.
 */
const DIST_DIR_TOUCHED = new Date('2026-06-07T08:09:10');

function seedDist(sandbox, { entry = true } = {}) {
  const dist = join(sandbox.root, 'packages', 'stream-uploader', 'dist');
  mkdirSync(dist, { recursive: true });
  if (entry) {
    writeFileSync(join(dist, 'index.js'), '');
    utimesSync(join(dist, 'index.js'), DIST_BUILT, DIST_BUILT);
  }
  utimesSync(dist, DIST_DIR_TOUCHED, DIST_DIR_TOUCHED);
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
  it('ships the dist that is there and names when it was built', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE, pnpm: false });
    seedDist(sandbox);

    const run = await runScriptOk(sandbox, 'deploy.sh', ['stream-uploader']);

    assert.deepEqual(sandbox.pnpmCalls(), [], 'a host with no pnpm was asked to run one');
    assert.match(run.stdout, /packages\/stream-uploader\/dist/);
    assert.match(run.stdout, /2026-01-02 03:04:05/, 'the dist was deployed without saying how stale it is');
    assert.doesNotMatch(run.stdout, /2026-06-07/, 'the line dates the dist directory rather than the build');
  });

  it('names a dist that has no index.js rather than dating the directory', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE, pnpm: false });
    seedDist(sandbox, { entry: false });

    const run = await runScriptOk(sandbox, 'deploy.sh', ['stream-uploader']);

    assert.match(run.stdout, /no dist\/index\.js/, 'a dist the image cannot run was deployed silently');
    assert.doesNotMatch(run.stdout, /2026-06-07/, 'the line dates the dist directory rather than the build');
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
