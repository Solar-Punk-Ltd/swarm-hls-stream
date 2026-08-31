import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'deploy/scripts/buffer-sweep-sitting.sh');
const PLUR_PER_BZZ = 10n ** 16n;

/**
 * That a buffer sweep publishes one broadcast sized to the driver's own arm plan, labels its byte
 * source, and refuses before publishing.
 *
 * The sweep runs its arms INSIDE one browser session (`browser:buffer-sweep` moves the player's
 * buffer target between stretches), so the wrapper's one job besides the gates is arithmetic: the
 * broadcast has to outlive settle plus every arm, and a broadcast that ends early leaves the last
 * arms sampling a dead stream, which reads exactly like the small-buffer failure the sweep exists
 * to find.
 */

const cleanups = [];

after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

async function startChequebook(availableBzz) {
  const plur = ((BigInt(Math.round(availableBzz * 1000)) * PLUR_PER_BZZ) / 1000n).toString();
  const server = createServer((req, reply) => {
    if (!req.url.startsWith('/chequebook/balance')) {
      reply.writeHead(404).end();
      return;
    }
    reply
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ totalBalance: plur, availableBalance: plur }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(() => server.close());
  return server.address().port;
}

/** Deliberately not hex, for the same reason as crashArms.test.js. */
const BATCH_ID = 'stub-batch-for-buffer-sweep-tests';

function stubBin(binDir, runsRecord, watchedFlag, chequebookPort, batch, sweepFails) {
  mkdirSync(binDir, { recursive: true });
  const stamps = {
    stamps: [
      {
        batchID: batch.id,
        utilization: batch.utilization,
        usable: batch.usable,
        label: 'stub',
        depth: 24,
        amount: '9501166080',
        bucketDepth: 16,
        immutableFlag: true,
        exists: true,
        batchTTL: batch.ttlSeconds,
      },
    ],
  };

  writeFileSync(
    join(binDir, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'inspect') {
  process.stdout.write(${JSON.stringify(batch.env)});
}
if (process.argv[2] === 'image' && process.argv[3] === 'inspect') {
  process.exit(0);
}
if (process.argv[2] === 'run') {
  const args = process.argv.slice(3);
  const script = args[args.length - 1];
  if (script === 'browser:selfcheck') {
    process.exit(0);
  }
  if (script === 'browser:buffer-sweep') {
    fs.appendFileSync(${JSON.stringify(runsRecord)}, args.join(' ') + '\\n');
    fs.writeFileSync(${JSON.stringify(watchedFlag)}, '');
    process.exit(${sweepFails ? 1 : 0});
  }
}
if (process.argv[2] === 'ps') {
  process.stdout.write('someone-elses-publisher\\n');
}
process.exit(0);
`,
  );
  writeFileSync(
    join(binDir, 'curl'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const url = process.argv.slice(2).find((a) => a.startsWith('http')) || '';
if (url.includes('/chequebook/balance')) {
  process.stdout.write(require('node:child_process').execFileSync('/usr/bin/curl',
    ['-s', 'http://127.0.0.1:${chequebookPort}/chequebook/balance'], { encoding: 'utf8' }));
} else if (url.includes('/stamps')) {
  process.stdout.write(${JSON.stringify(JSON.stringify(stamps))});
} else if (url.includes('/metrics')) {
  process.stdout.write('bee_pusher_total_synced 12\\n');
} else if (url.includes('/health')) {
  const watched = fs.existsSync(${JSON.stringify(watchedFlag)});
  if (watched) {
    fs.rmSync(${JSON.stringify(watchedFlag)});
  }
  process.stdout.write(JSON.stringify({ activeStreams: watched ? 0 : 1 }));
}
`,
  );
  for (const name of ['docker', 'curl']) {
    chmodSync(join(binDir, name), 0o755);
  }
}

const HEALTHY_BATCH = {
  id: BATCH_ID,
  utilization: 35,
  usable: true,
  ttlSeconds: 567936,
  env: `STAMP=${BATCH_ID}\nLOG_LEVEL=debug\n`,
};

async function runSweep({
  byteSource,
  bzz = 500,
  preflightOnly = false,
  ceilingPlur = 24n * 10n ** 15n,
  sweepFails = false,
  armSeconds = '2',
  targets = '6,3',
  warmups = '6',
}) {
  const port = await startChequebook(bzz);
  const out = mkdtempSync(join(tmpdir(), 'buffer-sweep-'));
  cleanups.push(() => rmSync(out, { recursive: true, force: true }));
  const bin = join(out, 'bin');
  const runsRecord = join(out, 'runs.txt');
  writeFileSync(runsRecord, '');
  stubBin(bin, runsRecord, join(out, 'watched.flag'), port, HEALTHY_BATCH, sweepFails);

  const metricsCalls = join(out, 'metrics-calls.txt');
  writeFileSync(metricsCalls, '');
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

  const ledger = join(out, 'spend-ledger.env');
  const startPlur = (BigInt(Math.round(bzz * 1000)) * 10n ** 13n).toString();
  writeFileSync(
    ledger,
    [
      'authorised_at=2026-08-27T00:00:00Z',
      `ceiling_plur=${ceilingPlur}`,
      // One baseline per node, keyed by port, because the gate reads every node that can
      // spend and refuses one it has no baseline for. Both ports are the same here, so the
      // gate dedupes them into a single node and a second line would be a baseline nothing
      // reads, which it also refuses.
      `node_${port}_start_plur=${startPlur}`,
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    OUT_DIR: out,
    SPEND_LEDGER: ledger,
    BENCH_REPO: out,
    ...(byteSource === undefined ? {} : { BYTE_SOURCE: byteSource }),
    BROWSER_ARM_SECONDS: armSeconds,
    BROWSER_SWEEP_TARGETS_S: targets,
    BROWSER_SWEEP_WARMUP_S: warmups,
    BROWSER_BYTE_SOURCE_SETTLE_SECONDS: '1',
    SWEEP_SLACK_S: '1',
    STREAM_TIMEOUT_S: '5',
    QUIET_TIMEOUT_S: '5',
    PUBLISHER_MARGIN_S: '10',
    UPLOADER_BEE_PORT: String(port),
    GATEWAY_BEE_PORT: String(port),
    NODE_METRICS: metricsStub,
    RUN_SELFCHECK: '0',
    ...(preflightOnly ? { PREFLIGHT_ONLY: '1' } : {}),
  };

  let code = 0;
  try {
    await run('bash', [SCRIPT], { env, encoding: 'utf8' });
  } catch (failure) {
    code = failure.code;
  }
  return {
    code,
    runs: readFileSync(runsRecord, 'utf8').split('\n').filter(Boolean),
    state: existsSync(join(out, 'buffer-sweep-state.tsv'))
      ? readFileSync(join(out, 'buffer-sweep-state.tsv'), 'utf8').split('\n').filter(Boolean)
      : [],
    log: readFileSync(join(out, 'buffer-sweep.log'), 'utf8'),
    metricsCalls: readFileSync(metricsCalls, 'utf8').split('\n').filter(Boolean),
  };
}

describe('a buffer sweep sizes its one broadcast and labels its byte source', () => {
  it('runs the sweep with the byte source and arm plan forwarded, docker socket mounted', async () => {
    const { code, runs } = await runSweep({ byteSource: 'weeb3' });

    assert.equal(code, 0, 'a healthy sweep failed');
    assert.equal(runs.length, 1);
    assert.match(runs[0], /BROWSER_FETCH_BACKEND=weeb3/);
    assert.match(runs[0], /BROWSER_ARM_SECONDS=2/);
    assert.match(runs[0], /BROWSER_SWEEP_TARGETS_S=6,3/);
    assert.match(runs[0], /\/var\/run\/docker\.sock/);
  });

  /**
   * Three arms of 2s plus 1s settle plus 1s slack is 9s of browser, plus the 10s publisher margin,
   * so the broadcast must be one minute. The arithmetic lives in the wrapper because the driver
   * cannot size a broadcast it does not start, and a broadcast that ends early turns the last arms
   * into the exact failure the sweep looks for.
   */
  it('sizes the broadcast from the arm plan and says so', async () => {
    const { log } = await runSweep({ byteSource: 'weeb3' });

    assert.match(log, /3 arms of 2s/, `the plan is not in the log: ${log}`);
    assert.match(log, /1 broadcast of 1 min/, `the sizing is not in the log: ${log}`);
  });

  it('refuses to run without a byte source, before publishing anything', async () => {
    const { code, runs, log } = await runSweep({});

    assert.equal(code, 1);
    assert.equal(runs.length, 0, 'it ran a sweep with no byte source named');
    assert.match(log, /REFUSING TO START/);
  });

  it('refuses a byte source the driver does not honour', async () => {
    const { code, runs } = await runSweep({ byteSource: 'weeb-3' });

    assert.equal(code, 1);
    assert.equal(runs.length, 0);
  });

  it('refuses a sitting past the authorised ceiling without publishing', async () => {
    const { code, runs, log } = await runSweep({ byteSource: 'weeb3', ceilingPlur: 1n });

    assert.equal(code, 1);
    assert.equal(runs.length, 0);
    assert.match(log, /authorisation/);
  });

  it('answers whether it can afford the sitting without publishing it', async () => {
    const { code, runs, log } = await runSweep({ byteSource: 'weeb3', preflightOnly: true });

    assert.equal(code, 0);
    assert.equal(runs.length, 0);
    assert.match(log, /PREFLIGHT_ONLY/);
  });

  it('brackets the sitting with metric snapshots either side', async () => {
    const { metricsCalls } = await runSweep({ byteSource: 'weeb3' });

    const labels = metricsCalls.filter((call) => call.startsWith('snapshot')).map((call) => call.split(' ').pop());
    assert.ok(labels.includes('sitting-before'), `no before snapshot: ${labels}`);
    assert.ok(labels.includes('sitting-after'), `no after snapshot: ${labels}`);
  });

  it('records a failed sweep as BROWSER-FAILED rather than swallowing it', async () => {
    const { state } = await runSweep({ byteSource: 'weeb3', sweepFails: true });

    assert.equal(state.length, 1);
    assert.match(state[0], /BROWSER-FAILED/);
  });
});
