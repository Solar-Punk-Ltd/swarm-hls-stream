import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALL_REMOTE, GIT_STUB, makeSandbox, removeSandboxes, runScript, runScriptOk } from './helpers/sandbox.js';

after(removeSandboxes);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = join(ROOT, 'deploy/scripts');

/**
 * What the served client is judged against, computed by `deploy.sh` when it builds the image and by
 * `bench-on-host.sh` when it syncs the harness, so the `client-shape` preflight has two independent
 * readings of the same thing to compare.
 *
 * ⛔ Observed as the override file compose was pointed at, recorded by the docker stub while it still
 * existed, because both deploy paths delete it the moment compose returns. Compose interpolates build
 * args out of that file, so it is also the only place the computed VALUES ever appear: the argv
 * carries the path and nothing else.
 *
 * A REMOTE deploy, because that is the harder half to get right and the one that reaches the bench
 * host. The values have to survive being expanded into a heredoc on the operator's machine and
 * written back out on the far side.
 */
const CLIENT_STAMP_KEYS = [
  'CLIENT_BUILD_CLIENT_TREE',
  'CLIENT_BUILD_SHARED_TREE',
  'CLIENT_BUILD_HEAD',
  'CLIENT_BUILD_DIRTY',
  'CLIENT_BUILD_AT',
];

/**
 * The paths whose content decides whether a served client matches a checkout: the sources vite
 * compiles into the bundle, plus the image and the nginx template that decide how it is served.
 */
const CLIENT_SOURCE_PATHS = [
  'packages/client',
  'packages/shared',
  'deploy/Dockerfile.client',
  'deploy/client-nginx.conf.template',
];

async function deployClientRemotely(env = {}) {
  const sandbox = makeSandbox({ config: ALL_REMOTE, project: 'default' });
  const run = await runScriptOk(sandbox, 'deploy.sh', ['client'], env);
  return { sandbox, run, sent: sandbox.remoteEnvFiles() };
}

describe('deploy.sh minting the client build stamp', () => {
  it('carries the tree hashes it read into the override file the far side writes', async () => {
    const { sent } = await deployClientRemotely();

    assert.match(sent, new RegExp(`CLIENT_BUILD_CLIENT_TREE=${GIT_STUB.clientTree}`));
    assert.match(sent, new RegExp(`CLIENT_BUILD_SHARED_TREE=${GIT_STUB.sharedTree}`));
    assert.match(sent, new RegExp(`CLIENT_BUILD_HEAD=${GIT_STUB.head}`));
  });

  /**
   * ⛔ The committed tree rather than the working one. A hash of what is on disk could not be
   * compared against anything, since the harness on the host has no `.git` to hash and the whole
   * point is two sides naming the same commit.
   */
  it('reads the trees out of the head commit', async () => {
    const { sandbox } = await deployClientRemotely();
    const asked = sandbox.gitCalls().join('\n');

    assert.match(asked, /rev-parse HEAD:packages\/client/);
    assert.match(asked, /rev-parse HEAD:packages\/shared/);
  });

  it('judges dirtiness over every source that decides what a viewer is served', async () => {
    const { sandbox } = await deployClientRemotely();
    const status = sandbox.gitCalls().find((call) => call.includes('status --porcelain'));

    assert.ok(status, 'deploy.sh never asked git whether the client sources are clean');
    for (const path of CLIENT_SOURCE_PATHS) {
      assert.ok(status.includes(path), `the dirty check does not cover ${path}: ${status}`);
    }
  });

  /**
   * A tree hash describes a commit, so a build from uncommitted sources has a hash that names
   * something other than what was built. The gate refuses on this flag rather than trusting the
   * hashes it was given.
   */
  it('flags a build whose client sources have uncommitted changes', async () => {
    const { sent } = await deployClientRemotely({ GIT_STUB_DIRTY: '1' });

    assert.match(sent, /CLIENT_BUILD_DIRTY=1/);
  });

  it('reports a clean checkout as clean, so the flag means something', async () => {
    const { sent } = await deployClientRemotely();

    assert.match(sent, /CLIENT_BUILD_DIRTY=0/);
  });

  it('stamps a UTC instant, so a reader can say which build they are looking at', async () => {
    const { sent } = await deployClientRemotely();

    assert.match(sent, /CLIENT_BUILD_AT=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  });

  /**
   * ⛔ A deploy from a tree with no git must still work, or a release built from an export stops
   * being deployable. The gate then refuses on the empty tree hash, which asks for a redeploy from
   * a checkout rather than blocking this one.
   */
  it('still deploys when git cannot answer at all', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE, project: 'default' });

    const run = await runScript(sandbox, 'deploy.sh', ['client'], { GIT_STUB_FAIL: '1' });

    assert.equal(run.exitCode, 0, `a git-less deploy was refused: ${run.stdout}${run.stderr}`);
    assert.match(sandbox.remoteEnvFiles(), /^CLIENT_BUILD_CLIENT_TREE=\s*$/m);
  });

  /** Nothing else builds the client image, so nothing else has any use for these keys. */
  it('computes nothing for a deploy the client is not part of', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE, project: 'default' });

    await runScriptOk(sandbox, 'deploy.sh', ['bee-gateway']);

    const sent = sandbox.remoteEnvFiles();
    for (const key of CLIENT_STAMP_KEYS) {
      assert.doesNotMatch(sent, new RegExp(key), `${key} was computed for a deploy with no client`);
    }
  });
});

/**
 * ⛔⛔ The two sides have to agree on what "the client sources" are, or the gate compares one answer
 * against a different question. `deploy.sh` decides what the image records and `bench-on-host.sh`
 * decides what the harness expects, and a path added to one and not the other is a source that can
 * change a viewer's client while both sides still call it a match.
 */
describe('the two sides of the client stamp asking about the same sources', () => {
  const scripts = ['deploy.sh', 'bench-on-host.sh'].map((name) => ({
    name,
    body: readFileSync(join(SCRIPTS, name), 'utf8'),
  }));

  for (const path of CLIENT_SOURCE_PATHS) {
    it(`both scripts judge dirtiness over ${path}`, () => {
      for (const { name, body } of scripts) {
        assert.ok(body.includes(path), `${name} does not name ${path}`);
      }
    });
  }
});
