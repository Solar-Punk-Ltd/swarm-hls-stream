import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'deploy/scripts/sweep-interleaved.sh');
const BATCH = '7849851f404265dd2bea17e4229b45be23e245210ea17ac0af3a2a2b13faa2fd';
const PLUR_PER_BZZ = 10n ** 16n;

/**
 * That the sweep files what the nodes say they did, and stops when one of them crosses a floor.
 *
 * ⛔⛔⛔ It measured everything from outside. Every row it has ever produced was scored on what the
 * bench observed across the network, while both bee nodes kept a complete account of the same events
 * that nothing read. The node publishes 272 metric families: `bee_pusher_sync_time` IS the publish
 * race the bench times with a stopwatch, and `bee_retrieval_*` IS the fetch hop. A sweep comparing
 * two GOPs without them is guessing at a cause its own instrument was already recording.
 *
 * ⛔⛔ And the counters are lifetime totals, so one reading says nothing. Every case here is about
 * PAIRS, which is why an unpaired reading is asserted as a defect rather than tolerated as partial.
 */

const cleanups = [];

after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

function setup({ utilization = 254, stopFileFirst = false, stopAfterFirstRun = false }) {
  const out = mkdtempSync(join(tmpdir(), 'sweep-metrics-'));
  cleanups.push(() => rmSync(out, { recursive: true, force: true }));
  const bin = join(out, 'bin');
  mkdirSync(bin, { recursive: true });

  const runs = join(out, 'docker-runs.txt');
  const metricsCalls = join(out, 'metrics-calls.txt');
  writeFileSync(runs, '');
  writeFileSync(metricsCalls, '');

  const plur = (500n * PLUR_PER_BZZ).toString();
  const stamps = {
    stamps: [
      {
        batchID: BATCH,
        utilization,
        usable: true,
        label: 'stub',
        depth: 25,
        amount: '36043833600',
        bucketDepth: 16,
        immutableFlag: true,
        exists: true,
        batchTTL: 941760,
      },
    ],
  };

  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env node
const url = process.argv.slice(2).find((a) => a.startsWith('http')) || '';
if (url.includes('/chequebook/balance')) {
  process.stdout.write(JSON.stringify({ totalBalance: '${plur}', availableBalance: '${plur}' }));
} else if (url.includes('/stamps')) {
  process.stdout.write(${JSON.stringify(JSON.stringify(stamps))});
}
`,
  );

  // A run that crosses a floor is how a real sampler behaves: it writes the stop file and the driver
  // is expected to notice before it starts the next broadcast.
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'run') {
  fs.appendFileSync(${JSON.stringify(runs)}, 'run\\n');
  ${
    stopAfterFirstRun
      ? `fs.writeFileSync(${JSON.stringify(join(out, 'STOP'))}, 'the gateway crossed its reserve\\n');`
      : ''
  }
}
`,
  );
  writeFileSync(join(bin, 'getent'), '#!/usr/bin/env node\nprocess.stdout.write("docker:x:999:\\n");\n');
  for (const name of ['curl', 'docker', 'getent']) {
    chmodSync(join(bin, name), 0o755);
  }

  // A recorder rather than the real collector: each real snapshot is seven curls and two python
  // starts. What matters here is THAT every run is bracketed, which is exactly what this records.
  const metricsStub = join(out, 'node-metrics-stub.sh');
  writeFileSync(
    metricsStub,
    `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(metricsCalls)}
[ "$1" = snapshot ] && printf '{"label":"%s","atMs":0}' "\${3:-}" > "$2"
exit 0
`,
  );
  chmodSync(metricsStub, 0o755);

  if (stopFileFirst) {
    writeFileSync(join(out, 'STOP'), 'a previous sitting crossed a floor\n');
  }

  return { out, bin, runs, metricsCalls, metricsStub };
}

async function runSweep({ rounds = 1, configs = 'a:1280x720:2500:0.5 b:1280x720:2500:2.0', ...options }) {
  const stubs = setup(options);

  let code = 0;
  try {
    await run('bash', [SCRIPT], {
      env: {
        ...process.env,
        PATH: `${stubs.bin}:${process.env.PATH}`,
        OUT_DIR: stubs.out,
        REPO_DIR: stubs.out,
        ROUNDS: String(rounds),
        MINUTES: '1',
        SWEEP_CONFIGS: configs,
        UPLOADER_BEE_PORT: '10075',
        GATEWAY_BEE_PORT: '10077',
        STAMP: BATCH,
        NODE_METRICS: stubs.metricsStub,
        UPLOADER_BURN_PLUR_PER_MIN: String(PLUR_PER_BZZ / 100n),
        GATEWAY_BURN_PLUR_PER_MIN: String(PLUR_PER_BZZ / 100n),
        FUNDS_MARGIN_PERCENT: '100',
      },
      encoding: 'utf8',
    });
  } catch (failure) {
    code = failure.code;
  }

  const calls = readFileSync(stubs.metricsCalls, 'utf8').split('\n').filter(Boolean);
  return {
    code,
    calls,
    snapshots: calls.filter((call) => call.startsWith('snapshot ')).map((call) => call.split(/\s+/).pop()),
    diffs: calls.filter((call) => call.startsWith('diff ')),
    published: readFileSync(stubs.runs, 'utf8').split('\n').filter(Boolean),
    log: readFileSync(join(stubs.out, 'sweep.log'), 'utf8'),
    state: existsSync(join(stubs.out, 'sweep-state.tsv'))
      ? readFileSync(join(stubs.out, 'sweep-state.tsv'), 'utf8').split('\n').filter(Boolean)
      : [],
  };
}

describe('a sweep files what the nodes themselves say each run did', () => {
  it('brackets every run and the whole sweep with a reading from both nodes', async () => {
    const { snapshots } = await runSweep({});

    assert.deepEqual(snapshots, [
      'sweep-before',
      'round1-a-before',
      'round1-a-after',
      'round1-b-before',
      'round1-b-after',
      'sweep-after',
    ]);
  });

  it('differences each pair, since one reading of a lifetime counter says nothing', async () => {
    const { diffs } = await runSweep({});

    assert.equal(diffs.length, 3, 'a diff per run and one over the sweep');
  });

  /**
   * ⚠️ The emptiness check is not padding. Without it this passes on a sweep that took no readings
   * at all: zero is even, and zero befores equal zero afters. That is the same vacuous shape that let
   * four extra-env cases go on passing while the driver refused to run anything.
   */
  it('leaves no reading unpaired', async () => {
    const { snapshots } = await runSweep({ rounds: 2 });

    assert.ok(snapshots.length > 0, 'the sweep took no readings at all');
    assert.equal(snapshots.length % 2, 0);
    assert.equal(
      snapshots.filter((label) => label.endsWith('-before')).length,
      snapshots.filter((label) => label.endsWith('-after')).length,
    );
  });

  /**
   * ⭐ The reading is taken around the run rather than around the whole sweep because the sweep is
   * interleaved: two configurations alternate, and a per-sweep total cannot say which of them moved
   * `bee_pusher_sync_time`. Bracketing the sweep alone would file the difference the sitting exists
   * to measure as one number.
   */
  it('names each reading for the run it brackets, so an interleaved sweep can be read apart', async () => {
    const { snapshots } = await runSweep({ rounds: 2 });

    // Round 2 reverses, so b is measured first and the labels have to follow the order actually run.
    assert.ok(snapshots.includes('round2-b-before'));
    assert.ok(snapshots.includes('round2-a-after'));
  });
});

describe('a sweep stops when a node crosses a floor', () => {
  it('publishes nothing when a previous sitting left a stop file', async () => {
    const { code, published, log } = await runSweep({ stopFileFirst: true });

    assert.equal(code, 1);
    assert.deepEqual(published, [], 'a sweep published after a floor had already been crossed');
    assert.match(log, /REFUSING TO START: a floor was already crossed/);
  });

  /**
   * ⛔ A crossed floor is not a reason to throw away the runs already measured. It is a reason not to
   * buy another, and a record of where the sitting stopped being trustworthy.
   */
  it('stops before the next run when a floor is crossed under it', async () => {
    const { published, state, log } = await runSweep({ rounds: 3, stopAfterFirstRun: true });

    assert.equal(published.length, 1, 'the sweep bought another run after a floor was crossed');
    assert.match(log, /STOPPING/);
    assert.ok(
      state.some((row) => row.includes('NOT-RUN(floor crossed)')),
      `the ledger does not say why it stopped: ${JSON.stringify(state)}`,
    );
  });
});
