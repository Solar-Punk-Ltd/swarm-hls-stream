import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

after(removeSandboxes);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = join(ROOT, 'deploy/scripts');

/**
 * That every script launched on the deployment host runs the preflight gates before it starts,
 * whether it chains them itself or has them prepended here.
 *
 * ⛔⛔ The e2e suite's own scripts chain `suites/preflight/*.test.ts` with `&&` before anything that
 * spends. The browser drivers had no such chain at all, and it cost twice: the served client sat
 * fifteen days stale between 2026-08-13 and 08-28 and every browser sitting in between measured the
 * old build, and on 2026-09-01 a paid sitting was lost to a harness expecting a log line the
 * deployed uploader did not write. Both gates exist now, `client-shape` and `uploader-log-shape`,
 * and until 2026-09-04 neither ran on the path a viewer arm takes.
 *
 * ⛔⛔⛔ The benches chained nothing either, and the fix of 2026-09-04 named only `browser:*`. A
 * `bench:*` script is `tsx bench/<name>.ts` in `e2e/package.json`, it publishes into the deployed
 * stage and spends its postage, and it is this launcher's own default. So the launcher now reads the
 * two manifests and gates anything whose own definition does not run the gates first, which is what
 * closes the same gap for a script written tomorrow.
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

/** The image name the script builds and runs, which is what a bare command sits directly after. */
const IMAGE = 'swarm-hls-bench';

/**
 * The real manifests, copied into the sandbox because the launcher reads them to decide which
 * scripts already carry the gates. Inventing a pair here would make every case below a statement
 * about a fixture rather than about the scripts an operator can actually launch.
 */
function seedManifests(sandbox) {
  mkdirSync(join(sandbox.root, 'e2e'), { recursive: true });
  copyFileSync(join(ROOT, 'package.json'), join(sandbox.root, 'package.json'));
  copyFileSync(join(ROOT, 'e2e/package.json'), join(sandbox.root, 'e2e/package.json'));
}

function benchSandbox() {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.remoteHome, REMOTE_BENCH_DIR), { recursive: true });
  writeFileSync(join(sandbox.root, SPEND_LEDGER), OWNER_LEDGER);
  seedManifests(sandbox);
  return sandbox;
}

/**
 * Runs the real script with `--no-setup`, which is the repeat-run path and the only one that needs
 * no rsync, and hands back the single command string the far side's login shell would receive.
 */
async function benchOnHost(args) {
  const sandbox = benchSandbox();

  const run = await runScript(sandbox, 'bench-on-host.sh', ['--no-setup', ...args]);
  assert.equal(run.exitCode, 0, `bench-on-host.sh failed: ${run.stdout}${run.stderr}`);

  // Two reads even with `--no-setup`: the busy-target guard's `docker ps`, then the run itself. The
  // guard is `benchOnHostOrphanGuard.test.js`'s question, and the run is the last one either way.
  const commands = sandbox.sshCommands();
  assert.equal(commands.length, 2, `expected the guard read and the run with --no-setup, got ${commands.length}`);
  return { run, command: commands[commands.length - 1] };
}

describe('bench-on-host puts the preflight gates in front of every driver that chains none', () => {
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
   * ⛔⛔⛔ A bench chains nothing. `bench:latency` and `bench:longrun` are a bare `tsx bench/<name>.ts`
   * in `e2e/package.json`, they publish into the deployed stage and spend its postage, and
   * `bench:latency` is this launcher's own default script. The fix of 2026-09-04 named the browser
   * drivers as the one ungated path and left both of these running with nothing in front of them.
   */
  for (const script of ['bench:latency', 'bench:longrun']) {
    it(`runs the gates in front of ${script}, which chains none of its own`, async () => {
      const { command, run } = await benchOnHost(['--script', script]);

      assert.match(command, new RegExp(`bash -c 'pnpm e2e:preflight && exec pnpm ${script}'`));
      assert.match(run.stdout, /runs behind the ten preflight gates/);
    });
  }

  /**
   * The suite's own scripts already chain the same gates inside `e2e/package.json`, and `e2e:preflight`
   * is the gates. Both keep the command they had, because prepending a second copy would buy the
   * operator the same refusal twice.
   */
  for (const script of ['e2e:preflight', 'e2e:run']) {
    it(`leaves ${script} exactly as it was`, async () => {
      const { command, run } = await benchOnHost(['--script', script]);

      assert.ok(command.endsWith(`${IMAGE} pnpm ${script}`), `${script} no longer runs bare: ${command}`);
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

  it('runs the gates before the policer for a shaped bench too', async () => {
    const { command } = await benchOnHost(['--shape-kbps', '2800', '--script', 'bench:latency']);

    assert.match(
      command,
      /bash -c 'pnpm e2e:preflight && deploy\/scripts\/shape-container-ingress\.sh && \. \/tmp\/swarm-shape-cap\.env && exec pnpm bench:latency'/,
    );
  });
});

/**
 * ⛔ The launcher reads the two manifests instead of carrying a list of script names, so this is the
 * same reading held against the command it actually built. A list would have to be edited by whoever
 * adds the next script, and the whole cost of this defect was a list that named `browser:*` and not
 * `bench:*`.
 */
const PREFLIGHT_SUITES = 'suites/preflight/';
const DELEGATES_TO_E2E = /^pnpm --filter @swarm-hls-stream\/e2e (\S+)$/;

function manifestScripts(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), 'utf8')).scripts ?? {};
}

/** Every root script that runs something in the e2e package, which is everything `--script` can name. */
function delegatingRootScripts() {
  const e2e = manifestScripts('e2e/package.json');

  return Object.entries(manifestScripts('package.json'))
    .map(([name, definition]) => ({ name, delegated: DELEGATES_TO_E2E.exec(definition.trim())?.[1] }))
    .filter(({ delegated }) => delegated !== undefined && e2e[delegated] !== undefined)
    .map(({ name, delegated }) => ({ name, definition: e2e[delegated] }));
}

/** Whether a definition runs the gates ahead of every other suite it runs, which is what gates it. */
function runsGatesFirst(definition) {
  const steps = definition.split('&&');
  const gatesAt = steps.findIndex((step) => step.includes(PREFLIGHT_SUITES));
  const otherSuiteAt = steps.findIndex((step) => step.includes('suites/') && !step.includes(PREFLIGHT_SUITES));

  return gatesAt !== -1 && (otherSuiteAt === -1 || gatesAt < otherSuiteAt);
}

describe('bench-on-host gates every script the manifests say gates nothing itself', () => {
  it('leaves no launchable script reaching the stage with nothing in front of it', async () => {
    const scripts = delegatingRootScripts();
    assert.ok(scripts.length >= 20, `only found ${scripts.length} root scripts delegating to e2e`);

    const sandbox = benchSandbox();
    await Promise.all(
      scripts.map(({ name }) => runScript(sandbox, 'bench-on-host.sh', ['--no-setup', '--script', name])),
    );
    const commands = sandbox.sshCommands();

    const launched = scripts.map(({ name, definition }) => ({
      name,
      selfGating: runsGatesFirst(definition),
      gatedHere: commands.some((command) => command.endsWith(`bash -c 'pnpm e2e:preflight && exec pnpm ${name}'`)),
      bare: commands.some((command) => command.endsWith(`${IMAGE} pnpm ${name}`)),
    }));

    const missing = launched.filter(({ gatedHere, bare }) => !gatedHere && !bare).map(({ name }) => name);
    assert.deepEqual(missing, [], `no launch was recorded for ${missing.join(', ')}`);

    const ungated = launched.filter(({ selfGating, gatedHere }) => !selfGating && !gatedHere).map(({ name }) => name);
    assert.deepEqual(
      ungated,
      [],
      `${ungated.join(', ')} runs on the deployed stage with no gate ahead of it, and its own definition ` +
        'in e2e/package.json does not run the preflight suites first either',
    );

    // The other direction, so an implementation that simply prepends the gates to everything cannot
    // pass this: a script that already runs them keeps the command it had.
    const doubled = launched.filter(({ selfGating, bare }) => selfGating && !bare).map(({ name }) => name);
    assert.deepEqual(doubled, [], `${doubled.join(', ')} already runs the gates and was given a second copy`);
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
