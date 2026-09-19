import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { stubCurl } from './helpers/curlStub.js';
import { makeSandbox, removeSandboxes, runScript, runScriptOk, sourceLib } from './helpers/sandbox.js';

const execFileAsync = promisify(execFile);

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
      // Only `health.sh` reaches a service, and since its exit status started meaning something it
      // reports a stack that is not up. What is being asserted here is that the missing env file did
      // not stop the script, so the services answer and a zero still says exactly that.
      stubCurl(sandbox);

      const run = await runScript(sandbox, script, ['--profile=streamr1', ...args]);

      assert.equal(run.exitCode, 0, `${script} could not act on a profile whose env file is missing`);
      assert.match(run.stdout, /has no .*\.env\.streamr1/, 'the missing env file was not mentioned at all');
      assert.ok(sandbox.calls().length > 0, `${script} reached docker for nothing`);
    });

    it(`${script} passes no --env-file when the profile has none`, async () => {
      const sandbox = makeSandbox({ envFiles: WITH_PROFILE, project: 'streamr1' });
      stubCurl(sandbox);

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

/**
 * ⛔ The slot arithmetic owns two blocks of ports, not one. Every service takes `base + slot*10` out
 * of 1000x, and the per-rung bee nodes take six more out of 1100x on the same rule, because the
 * first block has no digit left. The two meet at slot 100, where `10000 + 100*10` is 11000 and the
 * first block lands on top of the second. `_lib.sh` has carried that in a ⚠️ note since the second
 * block was added and nothing enforced it, so a deployment at slot 100 would have collided with
 * slot 0's own bee nodes and surfaced as a port already in use, or worse as a stack quietly reaching
 * another one's node. Slots 1, 2 and 7 are all that have ever been used.
 */
describe('--portSlot stops below the second port block', () => {
  it('accepts 99, the highest slot that keeps the two blocks apart', async () => {
    const sandbox = makeSandbox({ envFiles: WITH_PROFILE });

    const run = await sourceLib(
      sandbox,
      'parse_profile_args --profile=streamer1 --portSlot=99\necho "slot=$PORT_SLOT"',
    );

    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /^slot=99$/m);
  });

  it('refuses 100, and says which ports it would have landed on', async () => {
    const sandbox = makeSandbox({ envFiles: WITH_PROFILE });

    const run = await sourceLib(
      sandbox,
      'parse_profile_args --profile=streamer1 --portSlot=100\necho "slot=$PORT_SLOT"',
    );

    assert.notEqual(run.exitCode, 0, 'slot 100 was accepted, and it collides with the per-rung bee ports');
    assert.match(run.stderr, /--portSlot must be 0-99/);
    assert.match(run.stderr, /100/);
    assert.match(run.stderr, /11000/);
  });

  it('refuses 999, which the range used to end at', async () => {
    const sandbox = makeSandbox({ envFiles: WITH_PROFILE });

    const run = await sourceLib(
      sandbox,
      'parse_profile_args --profile=streamer1 --portSlot=999\necho "slot=$PORT_SLOT"',
    );

    assert.notEqual(run.exitCode, 0, 'slot 999 was accepted');
    assert.match(run.stderr, /--portSlot must be 0-99/);
  });
});

/** Obviously not a real batch id or key. A committed fixture that looked like one is one somebody tries. */
const FAKE_HEX_64 = 'ab'.repeat(32);

/** What `--feed-owner` takes: an ethereum address, twenty bytes. Fake for the same reason. */
const FAKE_HEX_40 = 'ab'.repeat(20);

/**
 * The startup watch driven fast, as `deployStarted.test.js` drives it. Nothing here is about the
 * watch, and its real window is five seconds of waiting per deploy against a stub that has already
 * made up its mind.
 */
const FAST_WATCH = {
  DEPLOY_SETTLE_SECONDS: '0',
  DEPLOY_WATCH_INTERVAL_SECONDS: '0.05',
  DEPLOY_READY_TIMEOUT_SECONDS: '0.5',
};

/** The env text compose was handed, sourced the way `deploy_target` sources the file it writes. */
async function sourcedValue(sandbox, name) {
  const file = join(sandbox.root, 'sourced.env');
  writeFileSync(file, sandbox.envFiles());
  const read = await execFileAsync('bash', ['-c', `. ${JSON.stringify(file)}\nprintf '%s' "\${${name}:-}"`]);
  return read.stdout;
}

/**
 * ⛔⛔⛔ The four per-deployment flags reach a file the deploy `source`s, on this machine and again on
 * the deployment host, so whatever is typed after `--feed-topic=` used to be shell on both.
 *
 * Three shapes, all of them the same omission. A `$(...)` in a value ran as a command. A literal
 * backslash-n was expanded by the `printf '%b'` that writes the file, so one value could set a second
 * key of its own choosing. And the remote path splices the text into a heredoc whose terminator is
 * the word `ENVEOF`, so a value carrying that word on a line of its own ended the heredoc early and
 * everything after it became commands on the host.
 *
 * The flags exist for the deployment manager, which is an admin surface, so the values are likelier
 * to come from a form than from the owner's own keyboard. Checked here as a shape refused up front,
 * and quoted in `parameter_overrides_text` as well, because neither layer is written to lean on the
 * other: quoting cannot undo a newline that ends a heredoc, and a shape check is only as good as the
 * shape somebody wrote down.
 */
describe('the per-deployment overrides are checked before they reach a source', () => {
  it('refuses a feed topic carrying a command substitution, naming the flag', async () => {
    const sandbox = makeSandbox();

    const run = await runScript(sandbox, 'deploy.sh', ['--feed-topic=a$(exit 7)b', 'stream-uploader']);
    const said = `${run.stdout}${run.stderr}`;

    assert.notEqual(run.exitCode, 0, `a topic carrying a command substitution was accepted: ${said}`);
    assert.match(said, /--feed-topic/);
    assert.deepEqual(
      sandbox.calls().filter((call) => call.startsWith('compose')),
      [],
      'a rejected value still reached compose',
    );
  });

  it('refuses a value carrying a backslash escape, which the writer used to turn into a second line', async () => {
    const sandbox = makeSandbox();

    const run = await runScript(sandbox, 'deploy.sh', ['--feed-topic=aa\\nEXTRA_KEY=smuggled', 'stream-uploader']);
    const said = `${run.stdout}${run.stderr}`;

    assert.notEqual(run.exitCode, 0, `a topic carrying a backslash escape was accepted: ${said}`);
    assert.match(said, /--feed-topic/);
    assert.doesNotMatch(sandbox.envFiles(), /EXTRA_KEY/, 'the smuggled key reached the env file compose reads');
  });

  it('refuses a stamp id that is not 64 hex characters', async () => {
    const sandbox = makeSandbox();

    const run = await runScript(sandbox, 'deploy.sh', ['--stamp-id=not-a-batch', 'stream-uploader']);
    const said = `${run.stdout}${run.stderr}`;

    assert.notEqual(run.exitCode, 0, `a stamp id that is not hex was accepted: ${said}`);
    assert.match(said, /--stamp-id/);
    assert.match(said, /64/, 'the refusal does not say what shape it wanted');
  });

  it('writes a valid stamp id quoted, and sourcing the file gives back exactly the value', async () => {
    const sandbox = makeSandbox();

    await runScriptOk(sandbox, 'deploy.sh', [`--stamp-id=0x${FAKE_HEX_64}`, 'stream-uploader'], FAST_WATCH);

    assert.match(
      sandbox.envFiles(),
      new RegExp(`^STAMP='${FAKE_HEX_64}'$`, 'm'),
      `the stamp reached compose unquoted: ${sandbox.envFiles()}`,
    );
    assert.equal(await sourcedValue(sandbox, 'STAMP'), FAKE_HEX_64);
  });

  it('accepts a plain feed topic and an owner address, which is what a deployment normally passes', async () => {
    const sandbox = makeSandbox();

    await runScriptOk(
      sandbox,
      'deploy.sh',
      ['--feed-topic=swarm-stream', `--feed-owner=0x${FAKE_HEX_40}`, 'stream-uploader'],
      FAST_WATCH,
    );

    assert.equal(await sourcedValue(sandbox, 'STREAM_LIST_TOPIC'), 'swarm-stream');
    assert.equal(await sourcedValue(sandbox, 'VITE_APP_OWNER'), FAKE_HEX_40);
  });
});
