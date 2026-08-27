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
const SCRIPT = join(ROOT, 'deploy/scripts/crash-arms.sh');
const PLUR_PER_BZZ = 10n ** 16n;

/**
 * That a crash sitting runs the fault arms it declares, labels every one with a byte source, and
 * refuses before publishing rather than after.
 *
 * The defect class this wrapper exists for is invisible in its output twice over. Every
 * crash-recovery reading this project held before 2026-08-27 was a gateway reading because the
 * driver never read the byte-source knob, and a run that spends first and refuses second produces a
 * paid broadcast with no usable arm attached to it. Both failure shapes look exactly like a sitting
 * that ran.
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

/**
 * Deliberately not hex: nothing in the gates validates the shape, only that the id the uploader is
 * configured with matches a usable row in `/stamps`, and a hex value here reads as a credential to
 * tooling that cannot know a postage batch id is public.
 */
const BATCH_ID = 'stub-batch-for-crash-arms-tests';

/**
 * Stubs everything an arm touches, the same shapes as `viewerArms.test.js` and for the same reason:
 * the health endpoint is stateful so `wait_for_quiet` returns instead of expiring, and the docker
 * stub records what each `browser:crash` run was given, which is the whole point of these tests.
 */
function stubBin(binDir, armsRecord, runsRecord, watchedFlag, removalLog, chequebookPort, batch, crashFails) {
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
if (process.argv[2] === 'rm') {
  fs.appendFileSync(${JSON.stringify(removalLog)}, process.argv.slice(3).join(' ') + '\\n');
}
if (process.argv[2] === 'inspect') {
  process.stdout.write(${JSON.stringify(batch.env)});
}
if (process.argv[2] === 'image' && process.argv[3] === 'inspect') {
  process.exit(0);
}
if (process.argv[2] === 'run') {
  const args = process.argv.slice(3);
  const script = args[args.length - 1];
  const envOf = (name) => {
    const hit = args.find((a, i) => args[i - 1] === '-e' && a.startsWith(name + '='));
    return hit ? hit.slice(name.length + 1) : '';
  };
  if (script === 'browser:selfcheck') {
    process.exit(0);
  }
  if (script === 'browser:crash') {
    fs.appendFileSync(
      ${JSON.stringify(armsRecord)},
      envOf('BROWSER_SCENARIO') + ':' + envOf('BROWSER_FETCH_BACKEND') + '\\n',
    );
    fs.appendFileSync(${JSON.stringify(runsRecord)}, args.join(' ') + '\\n');
    fs.writeFileSync(${JSON.stringify(watchedFlag)}, '');
    process.exit(${crashFails ? 1 : 0});
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

async function runCrashArms({
  arms,
  bzz = 500,
  preflightOnly = false,
  ceilingPlur = 24n * 10n ** 15n,
  crashFails = false,
  faultAllowance = '1',
}) {
  const port = await startChequebook(bzz);
  const out = mkdtempSync(join(tmpdir(), 'crash-arms-'));
  cleanups.push(() => rmSync(out, { recursive: true, force: true }));
  const bin = join(out, 'bin');
  const armsRecord = join(out, 'arms.txt');
  const runsRecord = join(out, 'runs.txt');
  const removals = join(out, 'removals.txt');
  writeFileSync(armsRecord, '');
  writeFileSync(runsRecord, '');
  writeFileSync(removals, '');
  stubBin(bin, armsRecord, runsRecord, join(out, 'watched.flag'), removals, port, HEALTHY_BATCH, crashFails);

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
      `uploader_start_plur=${startPlur}`,
      `gateway_start_plur=${startPlur}`,
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    OUT_DIR: out,
    SPEND_LEDGER: ledger,
    // A tree with no publish-clock.sh, so `start_publisher` fails harmlessly in its subshell and the
    // stubbed health check carries the arm forward, exactly as viewerArms.test.js arranges it.
    BENCH_REPO: out,
    ...(arms === undefined ? {} : { ARMS: arms }),
    MINUTES: '1',
    STREAM_TIMEOUT_S: '5',
    QUIET_TIMEOUT_S: '5',
    PUBLISHER_MARGIN_S: '10',
    // One-minute arms cannot carry the real driver windows, and the windows are not what these
    // measure. The refusal they exist to produce has its own case below.
    BROWSER_SETTLE_SECONDS: '1',
    BROWSER_RECOVER_SECONDS: '1',
    BROWSER_BYTE_SOURCE_SETTLE_SECONDS: '1',
    FAULT_ALLOWANCE_S: faultAllowance,
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
    arms: readFileSync(armsRecord, 'utf8').split('\n').filter(Boolean),
    runs: readFileSync(runsRecord, 'utf8').split('\n').filter(Boolean),
    state: existsSync(join(out, 'crash-arms-state.tsv'))
      ? readFileSync(join(out, 'crash-arms-state.tsv'), 'utf8').split('\n').filter(Boolean)
      : [],
    log: readFileSync(join(out, 'crash-arms.log'), 'utf8'),
    metricsCalls: readFileSync(metricsCalls, 'utf8').split('\n').filter(Boolean),
  };
}

describe('a crash sitting labels every arm and refuses before it publishes', () => {
  it('runs the declared arms in order, each with its scenario and byte source', async () => {
    const { arms } = await runCrashArms({ arms: 'uploader-crash:weeb3 uploader-crash:gateway' });

    assert.deepEqual(arms, ['uploader-crash:weeb3', 'uploader-crash:gateway']);
  });

  /**
   * An unset BROWSER_FETCH_BACKEND short-circuits in the driver: no arm is recorded and no proof
   * runs. A sitting must never publish a broadcast whose reading would come back unlabelled, so a
   * malformed arm is refused before anything is paid for.
   */
  it('refuses an arm with no byte source, before publishing anything', async () => {
    const { code, arms, log } = await runCrashArms({ arms: 'uploader-crash uploader-crash:weeb3' });

    assert.equal(code, 1);
    assert.equal(arms.length, 0, 'it ran arms despite a malformed one in the list');
    assert.match(log, /REFUSING TO START/);
  });

  it('refuses a byte source that is neither weeb3 nor gateway', async () => {
    const { code, arms } = await runCrashArms({ arms: 'uploader-crash:weeb-3' });

    assert.equal(code, 1);
    assert.equal(arms.length, 0);
  });

  /**
   * A scenario name the driver does not know would be found by `scenarioByName` throwing, which is
   * after the broadcast is up. The list is checked here against the wrapper's own copy so the refusal
   * costs nothing. The copy names `e2e/src/browser/faults.ts` as its source, and a scenario added
   * there without updating the wrapper refuses loudly instead of publishing first.
   */
  it('refuses a scenario name the fault list does not carry', async () => {
    const { code, arms, log } = await runCrashArms({ arms: 'gateway-unplugged:weeb3' });

    assert.equal(code, 1);
    assert.equal(arms.length, 0);
    assert.match(log, /gateway-unplugged/);
  });

  it('refuses to start when it cannot pay for every arm it intends to run', async () => {
    const { code, arms, log } = await runCrashArms({ arms: 'uploader-crash:weeb3 engine-restart:weeb3', bzz: 0 });

    assert.equal(code, 1);
    assert.equal(arms.length, 0, 'it published despite refusing to start');
    assert.match(log, /REFUSING TO START/);
  });

  it('refuses a sitting past the authorised ceiling without running an arm', async () => {
    const { code, arms, log } = await runCrashArms({ arms: 'uploader-crash:weeb3', ceilingPlur: 1n });

    assert.equal(code, 1);
    assert.equal(arms.length, 0);
    assert.match(log, /authorisation/);
  });

  /**
   * The driver's windows are fixed by the scenario, so a broadcast shorter than them produces a full
   * set of arms whose recovery stretches sample a stream that already ended, which reads as a run.
   */
  it('refuses a broadcast too short to carry the driver windows', async () => {
    const { code, arms, log } = await runCrashArms({ arms: 'uploader-crash:weeb3', faultAllowance: '600' });

    assert.equal(code, 1);
    assert.equal(arms.length, 0);
    assert.match(log, /REFUSING TO START/);
  });

  it('answers whether it can afford the sitting without publishing it', async () => {
    const { code, arms, log } = await runCrashArms({ arms: 'uploader-crash:weeb3', preflightOnly: true });

    assert.equal(code, 0);
    assert.equal(arms.length, 0);
    assert.match(log, /PREFLIGHT_ONLY/);
  });

  /**
   * The fault is injected from inside the browser container over the docker socket, so a run without
   * the mount would watch a healthy service and report a recovery from nothing. The GOP is forwarded
   * because hls.js prices a stall by `targetduration`, so a report that does not carry it cannot be
   * compared against the corpus.
   */
  it('gives the crash browser the docker socket and the GOP it was published with', async () => {
    const { runs } = await runCrashArms({ arms: 'uploader-crash:weeb3' });

    assert.equal(runs.length, 1);
    assert.match(runs[0], /\/var\/run\/docker\.sock/);
    assert.match(runs[0], /BROWSER_GOP_SECONDS=0\.5/);
  });

  it('brackets every arm and the sitting with metric snapshots', async () => {
    const { metricsCalls } = await runCrashArms({ arms: 'uploader-crash:weeb3 engine-restart:weeb3' });

    const snapshots = metricsCalls.filter((call) => call.startsWith('snapshot'));
    const labels = snapshots.map((call) => call.split(' ').pop());
    assert.ok(labels.includes('sitting-before') && labels.includes('sitting-after'), `sitting bracket missing: ${labels}`);
    for (const arm of ['arm1-uploader-crash-weeb3', 'arm2-engine-restart-weeb3']) {
      assert.ok(labels.includes(`${arm}-before`), `${arm} has no before snapshot`);
      assert.ok(labels.includes(`${arm}-after`), `${arm} has no after snapshot`);
    }
  });

  /**
   * A browser that dies must not take the rest of the sitting with it silently, and must not leave
   * its broadcast running. The row says BROWSER-FAILED so the sitting's own record shows which arms
   * are missing, the way viewer-arms records it.
   */
  it('records a failed arm and still runs the next one', async () => {
    const { arms, state } = await runCrashArms({ arms: 'uploader-crash:weeb3 engine-restart:weeb3', crashFails: true });

    assert.equal(arms.length, 2, 'a failed arm stopped the sitting');
    assert.match(state[0], /BROWSER-FAILED/);
  });
});
