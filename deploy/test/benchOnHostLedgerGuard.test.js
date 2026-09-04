import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

after(removeSandboxes);

/**
 * That `bench-on-host.sh` refuses to run from a checkout that holds no spend ledger, before it copies
 * anything to the host.
 *
 * ⛔ `.spend-ledger.env` is the owner's authorisation to spend, written by `spend-ledger.sh` at the root
 * of the checkout and kept out of git. The `spend-ceiling` preflight reads the copy the script syncs
 * to the host, so a checkout without the file could never pass that gate. The gap was the order: the
 * rsync ran first, with `--delete`, so a launch from such a checkout would have replaced the host's
 * harness copy, ledger included, with a tree nobody had authorised, and only then been refused. An
 * agent worktree is exactly such a checkout, since it holds only what git tracks. Ruled by the owner
 * on 2026-09-04, when the browser-path gate made the gap visible.
 *
 * Only presence is checked here. What the ledger says is `spendCeiling.test.js`'s question.
 */
const REMOTE_BENCH_DIR = 'swarm-hls-bench';
const SPEND_LEDGER = '.spend-ledger.env';
const OWNER_LEDGER = 'authorised_at=2026-09-03T09:32:45Z\n';

/** `--no-setup` opens with `cd ~/swarm-hls-bench` on the far side, and the ssh stub really runs it. */
function sandboxWithRemoteDir() {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.remoteHome, REMOTE_BENCH_DIR), { recursive: true });
  return sandbox;
}

describe('bench-on-host refuses a checkout that holds no spend ledger', () => {
  it('stops before anything reaches the host', async () => {
    const sandbox = makeSandbox();

    const run = await runScript(sandbox, 'bench-on-host.sh', ['--script', 'browser:watch']);

    assert.notEqual(run.exitCode, 0, 'a checkout without a ledger was allowed to sync');
    assert.match(run.stderr, /\.spend-ledger\.env does not exist/);
    assert.match(run.stderr, /nothing is copied to the host/);
    assert.equal(sandbox.sshCommands().length, 0, `ssh was reached: ${sandbox.sshCommands().join('\n')}`);
    assert.equal(existsSync(join(sandbox.remoteHome, REMOTE_BENCH_DIR)), false, 'the rsync ran before the refusal');
  });

  it('refuses --no-setup too, since the checkout is still the one launching a sitting', async () => {
    const sandbox = sandboxWithRemoteDir();

    const run = await runScript(sandbox, 'bench-on-host.sh', ['--no-setup', '--script', 'browser:watch']);

    assert.notEqual(run.exitCode, 0, 'a checkout without a ledger launched with --no-setup');
    assert.match(run.stderr, /\.spend-ledger\.env does not exist/);
    assert.equal(sandbox.sshCommands().length, 0);
  });

  it('runs from a checkout that carries the ledger', async () => {
    const sandbox = sandboxWithRemoteDir();
    writeFileSync(join(sandbox.root, SPEND_LEDGER), OWNER_LEDGER);

    const run = await runScript(sandbox, 'bench-on-host.sh', ['--no-setup', '--script', 'browser:watch']);

    assert.equal(run.exitCode, 0, `bench-on-host.sh failed: ${run.stdout}${run.stderr}`);
    assert.equal(sandbox.sshCommands().length, 1);
    assert.doesNotMatch(run.stderr, /spend-ledger/);
  });
});
