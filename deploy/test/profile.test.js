import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes, runScript, runScriptOk, sourceLib } from './helpers/sandbox.js';

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
  it('deploy.sh refuses a profile with no env file, naming the file', async () => {
    const sandbox = makeSandbox({ envFiles: WITH_PROFILE });

    const run = await runScript(sandbox, 'deploy.sh', ['--profile=streamr1']);

    assert.notEqual(run.exitCode, 0, 'a profile with no env file was deployed');
    // `require_env`'s own second line, which no other code path emits. Matching only the filename
    // would also match the warning below, and for deploy.sh it would match a non-zero exit that came
    // from somewhere else entirely.
    assert.match(
      `${run.stdout}${run.stderr}`,
      /Profile 'streamr1' requires .*\.env\.streamr1/,
      'the run failed, but not on the profile guard',
    );
    assert.deepEqual(sandbox.calls(), [], `docker was called despite the refusal: ${sandbox.calls().join(' | ')}`);
  });

  // Deploying without the profile's settings is the harm OPS-4 named. Stopping, cleaning and
  // health-checking are not: those containers are identified by the compose project name, and an
  // earlier version of this fix refused there too, which stranded a running stack whose env file had
  // been deleted with no way to tear it down.
  for (const { script, args } of PROFILE_SCRIPTS.filter(({ script }) => script !== 'deploy.sh')) {
    it(`${script} warns about a profile with no env file and still runs`, async () => {
      const sandbox = makeSandbox({ envFiles: WITH_PROFILE, project: 'streamr1' });

      const run = await runScript(sandbox, script, ['--profile=streamr1', ...args]);

      assert.equal(run.exitCode, 0, `${script} could not act on a profile whose env file is missing`);
      assert.match(run.stdout, /has no .*\.env\.streamr1/, 'the missing env file was not mentioned at all');
      assert.ok(sandbox.calls().length > 0, `${script} reached docker for nothing`);
    });

    it(`${script} passes no --env-file when the profile has none`, async () => {
      const sandbox = makeSandbox({ envFiles: WITH_PROFILE, project: 'streamr1' });

      await runScript(sandbox, script, ['--profile=streamr1', ...args]);

      for (const call of sandbox.calls()) {
        // Compose refuses to start at all when pointed at a file that is not there, so passing the
        // flag anyway would turn the warning above into a hard failure by another route.
        assert.doesNotMatch(call, /--env-file/, `compose was pointed at an env file that does not exist: ${call}`);
      }
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
});

/**
 * Bash arithmetic reads a leading zero as octal, so `--portSlot=08` used to die deep inside
 * `apply_port_slot` with "value too great for base" and `--portSlot=010` was silently slot 8. A slot
 * is a decimal id and nothing else. The June 2026 fix for this sat on an unmerged branch until
 * 2026-09-03, which is when it was ported here.
 */
describe('--portSlot is read as a decimal whole number', () => {
  it('reads a leading zero as decimal, so slot 08 is slot 8', async () => {
    const sandbox = makeSandbox({ envFiles: WITH_PROFILE });

    const run = await sourceLib(
      sandbox,
      'parse_profile_args --profile=streamer1 --portSlot=08\necho "slot=$PORT_SLOT"',
    );

    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /^slot=8$/m);
  });

  it('reads 010 as ten, not as octal eight', async () => {
    const sandbox = makeSandbox({ envFiles: WITH_PROFILE });

    const run = await sourceLib(
      sandbox,
      'parse_profile_args --profile=streamer1 --portSlot=010\necho "slot=$PORT_SLOT"',
    );

    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /^slot=10$/m);
  });

  it('refuses a slot that is not a whole number, naming the value', async () => {
    const sandbox = makeSandbox({ envFiles: WITH_PROFILE });

    const run = await sourceLib(
      sandbox,
      'parse_profile_args --profile=streamer1 --portSlot=7x\necho "slot=$PORT_SLOT"',
    );

    assert.notEqual(run.exitCode, 0, 'a slot that is not a number was accepted');
    assert.match(run.stderr, /--portSlot must be a whole number/);
    assert.match(run.stderr, /7x/);
  });
});
