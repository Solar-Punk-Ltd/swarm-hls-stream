import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

const markerDirs = [];

after(() => {
  removeSandboxes();
  for (const dir of markerDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A path outside the sandbox that nothing in a deploy has any reason to write to, so its existence
 * afterwards means one thing only: the value in `.env` was executed rather than used as a path.
 */
function payloadMarker() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-marker-'));
  markerDirs.push(dir);
  return join(dir, 'EXECUTED');
}

function envWith(line) {
  return { '.env': `STAMP=stamp\nSTREAM_KEY=key\n${line}\n` };
}

/** Deploys one bee node to a remote target, which is the only path that reaches an `ssh` command. */
function deployBeeNode(envFiles, service = 'bee-uploader') {
  const sandbox = makeSandbox({ config: ALL_REMOTE, envFiles });
  return { sandbox, run: runScript(sandbox, 'deploy.sh', [service]) };
}

describe('bee data dir from .env (SEC-21)', () => {
  // `ssh host "...$data_dir..."` hands one string to the far side's login shell, which word-splits
  // and evaluates it. The value arrives from the root `.env`, and `.env.sample` is tracked while
  // `setup.sh` appends new sample keys into an existing `.env` — so a single line in a commit that
  // touches no shell script used to run a command on every operator's deployment host. Measured on
  // the unfixed tree: the payload below executed twice, and `deploy.sh` reported success for the
  // step. `load_env` is genuinely inert and OPS-6 proves that, which is a different claim.
  it('refuses a value carrying a command instead of running it on the deployment host', async () => {
    const marker = payloadMarker();

    const { sandbox, run } = deployBeeNode(envWith(`BEE_UPLOADER_DATA_DIR=./data/bee; touch ${marker}; echo`));
    const finished = await run;

    assert.equal(existsSync(marker), false, 'the .env value executed on the deployment host');
    assert.notEqual(finished.exitCode, 0, 'a data dir that is a command was accepted');
    assert.match(
      `${finished.stdout}${finished.stderr}`,
      /BEE_UPLOADER_DATA_DIR is not a usable data directory/,
      'the run failed, but not on the data dir guard',
    );
    assert.deepEqual(
      sandbox.sshCommands().filter((command) => command.includes(marker)),
      [],
      'the payload still reached an ssh command line',
    );
  });

  // Quoting the value would have stopped the injection above and left this one working, which is
  // why the guard checks the path and not only the characters. On the unfixed tree this wrote the
  // bee node's password file straight into the deployment account's home directory and ran
  // `chmod -R 777` over all of it: `<base>/deploy/../..` is that home.
  it('refuses a value that walks out of the deployment directory', async () => {
    const { sandbox, run } = deployBeeNode(envWith('BEE_UPLOADER_DATA_DIR=../..'));
    const finished = await run;

    assert.equal(sandbox.remoteHas('password'), false, 'a bee password file was written to the remote home directory');
    assert.notEqual(finished.exitCode, 0, 'a data dir above the deployment directory was accepted');
    assert.match(
      `${finished.stdout}${finished.stderr}`,
      /BEE_UPLOADER_DATA_DIR walks out of the deployment directory/,
      'the run failed, but not on the data dir guard',
    );
  });

  // The character check refuses `../..` and accepts `/home/deploy/.ssh`, which is the same directory
  // by a different spelling with a larger blast radius: `chmod -R 777` on it makes the private key
  // and `authorized_keys` world readable, and sshd then refuses to authenticate against them. No
  // charset can separate a path this deployment owns from one it does not, because `.`, `/etc` and a
  // home directory all look like ordinary paths. The host holding the directory can, and does.
  it('refuses a directory that already belongs to something else', async () => {
    const occupied = mkdtempSync(join(tmpdir(), 'deploy-occupied-'));
    markerDirs.push(occupied);
    const theirs = join(occupied, 'authorized_keys');
    writeFileSync(theirs, 'ssh-ed25519 AAAA\n', { mode: 0o600 });

    const { run } = deployBeeNode(envWith(`BEE_UPLOADER_DATA_DIR=${occupied}`));
    const finished = await run;

    assert.notEqual(finished.exitCode, 0, 'a populated directory was accepted as a bee data dir');
    assert.equal(existsSync(join(occupied, 'password')), false, 'a bee password file was dropped into it');
    assert.equal(
      statSync(theirs).mode & 0o777,
      0o600,
      'the permissions of a file that was already there were widened, which is what chmod -R 777 does',
    );
  });

  // The gateway had its own copy of the same seven lines, so a fix applied to the uploader alone
  // would have left half the defect in place and every test above still green.
  it('guards the gateway variable as well as the uploader one', async () => {
    const marker = payloadMarker();

    const { run } = deployBeeNode(envWith(`BEE_GATEWAY_DATA_DIR=./data/bee; touch ${marker}; echo`), 'bee-gateway');
    const finished = await run;

    assert.equal(existsSync(marker), false, 'the .env value executed on the deployment host');
    assert.match(
      `${finished.stdout}${finished.stderr}`,
      /BEE_GATEWAY_DATA_DIR is not a usable data directory/,
      'the gateway variable reached ssh unguarded',
    );
  });
});

describe('bee data dir initialisation (SEC-21)', () => {
  // The half a guard can quietly break. A refusal that also refused every ordinary value would pass
  // both tests above while making the script useless.
  it('still initialises an ordinary relative dir under deploy/ on the remote host', async () => {
    const { sandbox, run } = deployBeeNode(envWith('BEE_UPLOADER_DATA_DIR=./data/bee-uploader'));
    const finished = await run;

    assert.equal(finished.exitCode, 0, `deploy failed: ${finished.stdout}${finished.stderr}`);
    assert.ok(
      sandbox.remoteHas('swarm-hls-stream/deploy/data/bee-uploader/password'),
      'no password file was created on the remote host, so the node has no key to start with',
    );
  });

  // An absolute value used to be pasted after `<base>/deploy/`, so the password landed in a nested
  // path while `docker-compose.yml` bind-mounted the absolute one — a node started against an empty
  // directory. Running the same `init-node.sh` on whichever host owns the directory is what makes
  // the two agree.
  it('honours an absolute dir instead of nesting it under deploy/', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-absdata-'));
    markerDirs.push(dir);

    const { sandbox, run } = deployBeeNode(envWith(`BEE_UPLOADER_DATA_DIR=${dir}/bee`));
    const finished = await run;

    assert.equal(finished.exitCode, 0, `deploy failed: ${finished.stdout}${finished.stderr}`);
    assert.ok(existsSync(join(dir, 'bee', 'password')), 'the absolute data dir was not the one initialised');
    assert.equal(
      sandbox.remoteHas(`swarm-hls-stream/deploy${dir}`),
      false,
      'the absolute path was pasted under deploy/ as well',
    );
  });
});
