import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

after(removeSandboxes);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = join(ROOT, 'deploy/scripts');

/**
 * That a browser driver launched on the deployment host runs the preflight gates before it starts.
 *
 * ⛔⛔ The e2e suite's own scripts chain `suites/preflight/*.test.ts` with `&&` before anything that
 * spends, and the browser drivers had no such chain at all. It cost twice: the served client sat
 * fifteen days stale between 2026-08-13 and 08-28 and every browser sitting in between measured the
 * old build, and on 2026-09-01 a paid sitting was lost to a harness expecting a log line the
 * deployed uploader did not write. Both gates exist now, `client-shape` and `uploader-log-shape`,
 * and until 2026-09-04 neither ran on the path a viewer arm takes.
 *
 * ⚠️ The one test-only accommodation is the directory seeded on the stand-in remote host below, and
 * nothing in the script is relaxed for it. The remote command opens with `cd ~/swarm-hls-bench`, the
 * `ssh` stub runs what it is handed with HOME inside the sandbox, and without that directory the run
 * exits non-zero for a reason that has nothing to do with what is asserted here. `bench-on-host.sh`
 * had never been driven in the sandbox before this file, since `clientBuildStamp.test.js` only reads
 * its text.
 */
const REMOTE_BENCH_DIR = 'swarm-hls-bench';

/**
 * The other seed. The script refuses a checkout without the owner's ledger before it syncs anything,
 * which `benchOnHostLedgerGuard.test.js` holds it to, so every run here launches from one that has it.
 */
const SPEND_LEDGER = '.spend-ledger.env';
const OWNER_LEDGER = 'authorised_at=2026-09-03T09:32:45Z\n';

/**
 * Runs the real script with `--no-setup`, which is the repeat-run path and the only one that needs
 * no rsync, and hands back the single command string the far side's login shell would receive.
 */
async function benchOnHost(args) {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.remoteHome, REMOTE_BENCH_DIR), { recursive: true });
  writeFileSync(join(sandbox.root, SPEND_LEDGER), OWNER_LEDGER);

  const run = await runScript(sandbox, 'bench-on-host.sh', ['--no-setup', ...args]);
  assert.equal(run.exitCode, 0, `bench-on-host.sh failed: ${run.stdout}${run.stderr}`);

  const commands = sandbox.sshCommands();
  assert.equal(commands.length, 1, `expected one ssh command with --no-setup, got ${commands.length}`);
  return { run, command: commands[0] };
}

describe('bench-on-host puts the preflight gates in front of every browser driver', () => {
  it('runs the gates first and execs the driver only if they pass', async () => {
    const { command } = await benchOnHost(['--script', 'browser:watch']);

    assert.match(command, /bash -c 'pnpm e2e:preflight && exec pnpm browser:watch'/);
  });

  /**
   * ⛔ No exemption for the cheap one. `browser:selfcheck` publishes nothing and spends nothing, so
   * the gates cost it a few seconds, and when the stage is down they name the stage fault that the
   * selfcheck would otherwise be blamed for.
   */
  it('gates the selfcheck too, since a stage fault is what it would be blamed for', async () => {
    const { command } = await benchOnHost(['--script', 'browser:selfcheck']);

    assert.match(command, /bash -c 'pnpm e2e:preflight && exec pnpm browser:selfcheck'/);
  });

  /**
   * The suite's own scripts already chain the same gates inside `e2e/package.json`, and a bench
   * publishes through the uploader rather than reading a client. Both keep the command they had.
   */
  for (const script of ['e2e:preflight', 'e2e:run', 'bench:latency']) {
    it(`leaves ${script} exactly as it was`, async () => {
      const { command, run } = await benchOnHost(['--script', script]);

      assert.ok(command.endsWith(`swarm-hls-bench pnpm ${script}`), `${script} no longer runs bare: ${command}`);
      assert.doesNotMatch(command, /e2e:preflight &&/);
      assert.doesNotMatch(run.stdout, /preflight gates/);
    });
  }

  /**
   * ⛔ The gates judge the stage and the policer shapes the link, so a refusal has to come before
   * anything is installed on the interface. The order is also what keeps the shaper's proved rate
   * in the driver's environment: it is sourced after the shaper and before the exec.
   */
  it('runs the gates before the policer for a shaped arm', async () => {
    const { command } = await benchOnHost(['--shape-kbps', '2800', '--script', 'browser:in-tab-throttle-probe']);

    assert.match(
      command,
      /bash -c 'pnpm e2e:preflight && deploy\/scripts\/shape-container-ingress\.sh && \. \/tmp\/swarm-shape-cap\.env && exec pnpm browser:in-tab-throttle-probe'/,
    );
  });

  it('leaves a shaped bench command byte for byte as it was', async () => {
    const { command } = await benchOnHost(['--shape-kbps', '2800', '--script', 'bench:latency']);

    assert.match(
      command,
      /bash -c 'deploy\/scripts\/shape-container-ingress\.sh && \. \/tmp\/swarm-shape-cap\.env && exec pnpm bench:latency'/,
    );
  });
});

/**
 * ⛔ The run profile decides which byte source a driver measures and which segment length it expects,
 * and it is passed in as one of the `--` pairs where nothing announces it. Printed so an operator
 * reading the log knows which sitting they started, because this repo has already paid for a report
 * naming a setting the container never read.
 */
describe('bench-on-host says which run profile the gated driver will use', () => {
  it('names the profile the passthrough declared', async () => {
    const { run } = await benchOnHost(['--script', 'browser:watch', '--', 'E2E_RUN_PROFILE=light-client']);

    assert.match(
      run.stdout,
      /browser:watch runs behind the ten preflight gates \(pnpm e2e:preflight\), run profile light-client/,
    );
  });

  it('names the harness default when no pair declared one', async () => {
    const { run } = await benchOnHost(['--script', 'browser:watch']);

    assert.match(run.stdout, /run profile in-browser, the harness default/);
  });

  /**
   * ⛔ Two files name that default and only one of them can decide it. A shell script cannot read
   * `e2e/src/profiles.ts`, so this holds the printed line to what the harness would actually resolve,
   * the way `clientBuildStamp.test.js` holds the two sides of the client stamp together.
   */
  it('prints the default that e2e/src/profiles.ts actually holds', () => {
    const profiles = readFileSync(join(ROOT, 'e2e/src/profiles.ts'), 'utf8');
    const declared = /DEFAULT_RUN_PROFILE = '([^']+)'/.exec(profiles);

    assert.ok(declared, 'profiles.ts no longer declares DEFAULT_RUN_PROFILE in a form this check can read');
    assert.match(
      readFileSync(join(SCRIPTS, 'bench-on-host.sh'), 'utf8'),
      new RegExp(`${declared[1]}, the harness default`),
    );
  });
});
