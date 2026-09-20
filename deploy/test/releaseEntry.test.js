import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

after(removeSandboxes);

const FAST_WATCH = {
  DEPLOY_SETTLE_SECONDS: '0',
  DEPLOY_WATCH_INTERVAL_SECONDS: '0.01',
  DEPLOY_READY_TIMEOUT_SECONDS: '0.05',
};

function installGuard(home, mode) {
  const bin = join(home, '.local', 'bin');
  const state = join(home, '.local', 'state', 'streaming-release-guard');
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  const guard = join(bin, 'streaming-release-guard');
  writeFileSync(guard, `#!/bin/bash
set -euo pipefail
case "\${1:-}" in
  begin-legacy) printf '%s\\n' ${JSON.stringify(mode)} ;;
  finish-legacy) printf '%s\\n' 'legacy release lease released' ;;
  *) exit 1 ;;
esac
`);
  chmodSync(guard, 0o700);
}

async function waitForPath(path) {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the supported stack deployment entry', () => {
  it('keeps help read-only and available without a release lease', async () => {
    const sandbox = makeSandbox();

    const result = await runScript(sandbox, 'deploy.sh', ['--help'], { HOME: sandbox.root });

    assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^Usage: deploy\.sh/m);
    assert.deepEqual(sandbox.calls(), []);
    assert.equal(existsSync(join(sandbox.root, '.local/state/streaming-release-bootstrap.lock')), false);
  });

  it('keeps the default no-argument legacy deployment path', async () => {
    const sandbox = makeSandbox();

    const result = await runScript(
      sandbox,
      'deploy.sh',
      [],
      { ...FAST_WATCH, HOME: sandbox.root },
    );

    assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
    assert.ok(sandbox.calls().some((call) => call.includes('compose')));
  });

  it('refuses lifecycle activation before an external guard is installed', async () => {
    const sandbox = makeSandbox({
      envFiles: {
        '.env': [
          'STAMP=stamp',
          'STREAM_KEY=key',
          'SRS_LIFECYCLE_VERSION=1',
          'SRS_UPLOADER_ID=srs-uploader-a',
          '',
        ].join('\n'),
      },
    });

    const result = await runScript(
      sandbox,
      'deploy.sh',
      ['srs', 'stream-uploader'],
      { ...FAST_WATCH, HOME: sandbox.root },
    );

    assert.notEqual(result.exitCode, 0);
    assert.match(`${result.stdout}${result.stderr}`, /external release guard|managed lifecycle/i);
    assert.deepEqual(sandbox.calls(), []);
    assert.equal(existsSync(join(sandbox.root, '.local/state/streaming-release-bootstrap.lock')), false);
  });

  it('refuses the raw deploy entry after the installation is managed', async () => {
    const sandbox = makeSandbox();
    installGuard(sandbox.root, 'managed');

    const result = await runScript(
      sandbox,
      'deploy.sh',
      ['srs', 'stream-uploader'],
      { ...FAST_WATCH, HOME: sandbox.root },
    );

    assert.notEqual(result.exitCode, 0);
    assert.match(`${result.stdout}${result.stderr}`, /installed streaming-release-guard uploader/i);
    assert.deepEqual(sandbox.calls(), []);
  });

  it('keeps an installed but unactivated stack on the owner-bound legacy path', async () => {
    const sandbox = makeSandbox();
    installGuard(sandbox.root, 'legacy:11111111-1111-4111-8111-111111111111');

    const result = await runScript(
      sandbox,
      'deploy.sh',
      ['srs'],
      { ...FAST_WATCH, HOME: sandbox.root },
    );

    assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
    assert.ok(sandbox.calls().some((call) => call.includes('compose')));
  });

  it('preserves the pristine-host lease when the standalone deployment fails', async () => {
    const sandbox = makeSandbox();
    writeFileSync(sandbox.scriptPath('deploy-standalone.sh'), '#!/bin/bash\nexit 42\n');
    chmodSync(sandbox.scriptPath('deploy-standalone.sh'), 0o700);

    const result = await runScript(
      sandbox,
      'deploy.sh',
      ['srs'],
      { ...FAST_WATCH, HOME: sandbox.root },
    );

    assert.equal(result.exitCode, 42);
    assert.equal(
      existsSync(join(sandbox.root, '.local/state/streaming-release-bootstrap.lock/owner')),
      true,
    );
  });

  it('does not let a delayed duplicate finish release a successor lease', async (t) => {
    const sandbox = makeSandbox();
    const home = sandbox.root;
    const first = await runScript(sandbox, 'release-mode.sh', ['begin'], { HOME: home });
    assert.equal(first.exitCode, 0, `${first.stdout}${first.stderr}`);
    const firstOwner = first.stdout.trim().slice('bootstrap:'.length);
    const wrappers = join(sandbox.root, 'release-wrappers');
    const ready = join(sandbox.root, 'release-ready');
    const resume = join(sandbox.root, 'release-resume');
    mkdirSync(wrappers);
    for (const command of ['ln', 'rm']) {
      const commandPath = join(wrappers, command);
      writeFileSync(commandPath, `#!/bin/bash
set -euo pipefail
if [ ! -e '${ready}' ]; then
  /usr/bin/touch '${ready}'
  while [ ! -e '${resume}' ]; do /bin/sleep 0.01; done
fi
exec /bin/${command} "$@"
`);
      chmodSync(commandPath, 0o700);
    }
    const delayed = spawn(
      '/bin/bash',
      [sandbox.scriptPath('release-mode.sh'), 'finish-bootstrap', firstOwner],
      { env: { HOME: home, PATH: `${wrappers}:${sandbox.path}` }, stdio: 'ignore' },
    );
    t.after(() => {
      if (delayed.exitCode === null) {
        delayed.kill('SIGKILL');
      }
    });
    await waitForPath(ready);

    const firstFinish = await runScript(
      sandbox,
      'release-mode.sh',
      ['finish-bootstrap', firstOwner],
      { HOME: home },
    );
    assert.equal(firstFinish.exitCode, 0, `${firstFinish.stdout}${firstFinish.stderr}`);
    const successor = await runScript(sandbox, 'release-mode.sh', ['begin'], { HOME: home });
    assert.equal(successor.exitCode, 0, `${successor.stdout}${successor.stderr}`);
    const successorOwner = successor.stdout.trim().slice('bootstrap:'.length);
    writeFileSync(resume, 'continue\n');
    const delayedExit = await new Promise((resolve) => delayed.once('close', resolve));

    assert.notEqual(delayedExit, 0);
    assert.equal(
      readFileSync(join(home, '.local/state/streaming-release-bootstrap.lock/owner'), 'utf8').trim(),
      successorOwner,
    );
    const successorFinish = await runScript(
      sandbox,
      'release-mode.sh',
      ['finish-bootstrap', successorOwner],
      { HOME: home },
    );
    assert.equal(successorFinish.exitCode, 0, `${successorFinish.stdout}${successorFinish.stderr}`);
  });
});
