import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes, runScript, runScriptOk } from './helpers/sandbox.js';

after(removeSandboxes);

/**
 * Every script that takes `--profile`, so a guard cannot be fixed on one entry point and missed on
 * the rest, with whatever else each needs to reach the point of acting. `clean.sh` prompts, and a
 * refusal that only happened because the prompt was never answered would prove nothing.
 */
const PROFILE_SCRIPTS = [
  { script: 'deploy.sh', args: [] },
  { script: 'stop.sh', args: [] },
  { script: 'clean.sh', args: ['--yes'] },
  { script: 'health.sh', args: [] },
];

const WITH_PROFILE = {
  '.env': 'STAMP=stamp\nSTREAM_KEY=key\n',
  '.env.streamer1': 'STAMP=stamp1\nSTREAM_KEY=key1\nAPI_PORT=10010\n',
};

describe('unknown --profile (OPS-4)', () => {
  // A profile whose env file does not exist used to leave ENV_FILE pointing at the default `.env`,
  // so `--profile=streamr1` deployed a second copy of the stack reading the first one's ports and
  // secrets. `require_env` has carried the right message for this the whole time and could never
  // reach it, because the file it tests always existed.
  for (const { script, args } of PROFILE_SCRIPTS) {
    it(`${script} refuses a profile with no env file, naming the file`, async () => {
      const sandbox = makeSandbox({ envFiles: WITH_PROFILE });

      const run = await runScript(sandbox, script, ['--profile=streamr1', ...args]);

      assert.notEqual(run.exitCode, 0, 'a profile with no env file was accepted');
      assert.match(`${run.stdout}${run.stderr}`, /\.env\.streamr1/, 'the refusal did not name the missing file');
      assert.deepEqual(sandbox.calls(), [], `docker was called despite the refusal: ${sandbox.calls().join(' | ')}`);
    });
  }

  // The refusal has to be the missing file rather than the profile being non-default, or every
  // multi-instance deployment stops working.
  it('accepts a profile whose env file exists', async () => {
    const sandbox = makeSandbox({ envFiles: WITH_PROFILE, project: 'streamer1' });

    const run = await runScriptOk(sandbox, 'stop.sh', ['--profile=streamer1']);

    assert.match(run.stdout, /\.env\.streamer1/, 'the run did not report the profile env file it used');
    assert.ok(sandbox.calls().length > 0, 'a valid profile produced no docker call at all');
  });

  // The value that made this worth fixing. Falling back to the default `.env` did not just lose the
  // profile's settings, it silently adopted another deployment's, which is how two stacks end up
  // fighting over one port range.
  it('never reads the default env file for a named profile', async () => {
    const sandbox = makeSandbox({ envFiles: WITH_PROFILE, project: 'streamer1' });

    await runScriptOk(sandbox, 'stop.sh', ['--profile=streamer1']);

    for (const call of sandbox.calls()) {
      assert.doesNotMatch(
        call,
        /--env-file \S+\/\.env(\s|$)/,
        `a profiled run passed the default env file to compose: ${call}`,
      );
    }
  });

  // The default profile has no `.env.default` and must not start asking for one.
  it('still runs with no --profile at all', async () => {
    const sandbox = makeSandbox();

    await runScriptOk(sandbox, 'stop.sh', []);

    assert.ok(sandbox.calls().length > 0, 'the default profile produced no docker call at all');
  });

  // The refusal must not be a side effect of something the script already did. `clean.sh` removes
  // containers and `deploy.sh` writes an override env file, so both have to refuse before that.
  it('writes no deploy override file when the profile is rejected', async () => {
    const sandbox = makeSandbox({ envFiles: WITH_PROFILE });

    await runScript(sandbox, 'deploy.sh', ['--profile=streamr1']);

    assert.ok(
      !existsSync(join(sandbox.root, 'deploy', '.env.deploy.streamr1')),
      'the rejected profile still got an override env file written for it',
    );
  });
});
