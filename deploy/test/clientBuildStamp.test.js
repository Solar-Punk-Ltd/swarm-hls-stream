import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
   *
   * The `./` makes git read each path from the stack's own folder rather than from the repository
   * root. The real-git cases at the end of this file show why that matters.
   */
  it('reads the trees out of the head commit, from the stack folder', async () => {
    const { sandbox } = await deployClientRemotely();
    const asked = sandbox.gitCalls().join('\n');

    assert.match(asked, /rev-parse HEAD:\.\/packages\/client/);
    assert.match(asked, /rev-parse HEAD:\.\/packages\/shared/);
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

/** Where the stack sits inside a larger repository in the case that needs one. Any depth would do. */
const STACK_SUBFOLDER = 'apps/hls-stream';

/** The two packages the stamp names a tree for. */
const STAMPED_PACKAGES = ['packages/client', 'packages/shared'];

/**
 * Who a throwaway commit is by, given here so the fixture commits on a machine with no git identity
 * configured. The commit itself passes `commit.gpgsign=false` for a machine that signs by default.
 */
const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: 'client stamp fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'client stamp fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const STAMP_FUNCTION = /^client_build_stamp_text\(\) \{\n[\s\S]*?\n\}$/m;
const SOURCE_PATHS_ARRAY = /^CLIENT_SOURCE_PATHS=\(\n[\s\S]*?\n\)$/m;
const EXPECTED_TREE_FUNCTION = /^git_tree_or_empty\(\) \{\n[\s\S]*?\n\}$/m;

const fixtureDirs = [];

after(() => {
  for (const dir of fixtureDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * PATH and HOME and nothing else of this machine's, so a `GIT_DIR` or `GIT_INDEX_FILE` exported by
 * whatever launched the suite cannot point these git calls at some other repository.
 */
function machineEnv() {
  return { PATH: process.env.PATH, HOME: process.env.HOME };
}

/** One git call in `dir`, trimmed. A refusal throws with git's own message on it. */
function gitIn(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...machineEnv(), ...FIXTURE_IDENTITY },
    stdio: 'pipe',
  }).trim();
}

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtureDirs.push(dir);
  return dir;
}

/** One source file per stamped package, each with its own content so the two trees differ. */
function writeStampedPackages(stack) {
  for (const pkg of STAMPED_PACKAGES) {
    mkdirSync(join(stack, pkg, 'src'), { recursive: true });
    writeFileSync(join(stack, pkg, 'src', 'index.ts'), `export const origin = '${pkg}';\n`);
  }
}

/**
 * A throwaway repository with the stack at `stackPath` inside it, committed once. An empty
 * `stackPath` is the stack checked out on its own.
 */
function commitStackFixture(stackPath) {
  const repo = tempDir('client-stamp-repo-');
  const stack = join(repo, stackPath);
  writeStampedPackages(stack);
  gitIn(repo, 'init', '-q');
  gitIn(repo, 'add', '-A');
  gitIn(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
  return { repo, stack };
}

/**
 * The KEY=VALUE pairs the stamp function printed. It separates them with a backslash and an `n`
 * rather than a line break, and `deploy.sh` expands those later with `printf '%b'`.
 */
function parseStamp(printed) {
  const pairs = printed
    .split('\\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    });
  return Object.fromEntries(pairs);
}

/** The declarations each pattern matches in a shipped script, cut out so they can run alone. */
function liftFrom(scriptName, patterns) {
  const script = readFileSync(join(SCRIPTS, scriptName), 'utf8');
  return patterns.map((pattern) => {
    const found = pattern.exec(script);
    assert.ok(found, `${scriptName} no longer has what ${pattern} lifts out of it`);
    return found[0];
  });
}

/** The stamp function `deploy.sh` ships, run with `ROOT_DIR` at `stack`, and what it printed. */
function stampFrom(stack, env = {}) {
  const lifted = liftFrom('deploy.sh', [SOURCE_PATHS_ARRAY, STAMP_FUNCTION]);
  const printed = execFileSync('bash', ['-c', [...lifted, 'client_build_stamp_text'].join('\n')], {
    encoding: 'utf8',
    env: { ...machineEnv(), ...env, ROOT_DIR: stack },
  });
  return parseStamp(printed);
}

/**
 * The tree `bench-on-host.sh` expects for `pkg`, from the function it ships run with `REPO_ROOT` at
 * `stack`. The path goes in as an argument rather than into the program text.
 */
function expectedTreeFrom(stack, pkg, env = {}) {
  const [lifted] = liftFrom('bench-on-host.sh', [EXPECTED_TREE_FUNCTION]);
  return execFileSync('bash', ['-c', `${lifted}\ngit_tree_or_empty "$1"`, 'bash', pkg], {
    encoding: 'utf8',
    env: { ...machineEnv(), ...env, REPO_ROOT: stack },
  });
}

/**
 * ⛔⛔ What a path after `HEAD:` means to git, which the stub cannot say because it answers by exact
 * text. A bare `HEAD:packages/client` is read from the repository root, and `HEAD:./packages/client`
 * from the folder `-C` names. The two agree for a checkout of this repository on its own. They part
 * ways once the stack sits in a subfolder of a larger repository, where the bare form names nothing.
 * Git then prints the argument back before it fails, so the stamp named `HEAD:packages/client` as
 * the client's tree and the gate could never match it.
 *
 * So these lift the stamp function out of `deploy.sh` and run it against a real git in a throwaway
 * repository. Lifted rather than run whole, because the rest of `deploy.sh` builds and starts
 * containers, and this function is the only part of it that asks git anything.
 */
describe('the client stamp read by a real git, wherever the stack sits', () => {
  it('names the trees from the stack folder when the stack sits inside a larger repository', () => {
    const { repo, stack } = commitStackFixture(STACK_SUBFOLDER);
    assert.throws(
      () => gitIn(stack, 'rev-parse', 'HEAD:packages/client'),
      Error,
      'the fixture has to be one where a bare path after HEAD: names nothing from the stack folder',
    );

    const stamp = stampFrom(stack);

    assert.equal(stamp.CLIENT_BUILD_CLIENT_TREE, gitIn(repo, 'rev-parse', `HEAD:${STACK_SUBFOLDER}/packages/client`));
    assert.equal(stamp.CLIENT_BUILD_SHARED_TREE, gitIn(repo, 'rev-parse', `HEAD:${STACK_SUBFOLDER}/packages/shared`));
  });

  it('gives a checkout of the stack on its own the same trees the root-relative form gives', () => {
    const { repo, stack } = commitStackFixture('');

    const stamp = stampFrom(stack);

    assert.equal(stamp.CLIENT_BUILD_CLIENT_TREE, gitIn(repo, 'rev-parse', 'HEAD:packages/client'));
    assert.equal(stamp.CLIENT_BUILD_SHARED_TREE, gitIn(repo, 'rev-parse', 'HEAD:packages/shared'));
  });

  /**
   * `GIT_CEILING_DIRECTORIES` stops git looking above the export, so a temporary folder that happens
   * to sit inside some other checkout cannot answer for it.
   */
  it('still leaves both trees empty for a stack with no history', () => {
    const exported = tempDir('client-stamp-export-');
    writeStampedPackages(exported);

    const stamp = stampFrom(exported, { GIT_CEILING_DIRECTORIES: dirname(exported) });

    assert.equal(stamp.CLIENT_BUILD_CLIENT_TREE, '');
    assert.equal(stamp.CLIENT_BUILD_SHARED_TREE, '');
  });
});

/**
 * ⛔⛔ The other side of the same comparison. `bench-on-host.sh` computes the trees every sitting
 * carries into the container as the expectation the gate measures the stamp against, and it asks
 * git the same question the stamp does, so it has the same answer to get right. Its own filter
 * passes on nothing that is not an object name, so from a subfolder git's echoed argument became an
 * empty expectation, and the gate refused every sitting as unable to say what it expects.
 */
describe('the trees bench-on-host.sh expects, read by a real git, wherever the stack sits', () => {
  it('names the trees from the stack folder when the stack sits inside a larger repository', () => {
    const { repo, stack } = commitStackFixture(STACK_SUBFOLDER);
    assert.throws(
      () => gitIn(stack, 'rev-parse', 'HEAD:packages/client'),
      Error,
      'the fixture has to be one where a bare path after HEAD: names nothing from the stack folder',
    );

    for (const pkg of STAMPED_PACKAGES) {
      assert.equal(expectedTreeFrom(stack, pkg), gitIn(repo, 'rev-parse', `HEAD:${STACK_SUBFOLDER}/${pkg}`), pkg);
    }
  });

  it('gives a checkout of the stack on its own the same trees the root-relative form gives', () => {
    const { repo, stack } = commitStackFixture('');

    for (const pkg of STAMPED_PACKAGES) {
      assert.equal(expectedTreeFrom(stack, pkg), gitIn(repo, 'rev-parse', `HEAD:${pkg}`), pkg);
    }
  });

  it('still expects nothing of a stack with no history', () => {
    const exported = tempDir('client-stamp-export-');
    writeStampedPackages(exported);

    for (const pkg of STAMPED_PACKAGES) {
      assert.equal(expectedTreeFrom(exported, pkg, { GIT_CEILING_DIRECTORIES: dirname(exported) }), '', pkg);
    }
  });
});
