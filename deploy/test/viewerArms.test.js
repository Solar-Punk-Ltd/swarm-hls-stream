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
const SCRIPT = join(ROOT, 'deploy/scripts/viewer-arms.sh');
const PLUR_PER_BZZ = 10n ** 16n;

/**
 * That a viewer sitting runs the arms it says it will, in an order that cannot fake a result.
 *
 * Both guarantees are invisible in the output. A sitting whose rounds never reverse still produces a
 * full table of plausible numbers, and any drift across the hour lines up with the swept axis and
 * reads as the configuration. Two sittings have already been thrown away here for that shape, which
 * is why `sweep-interleaved.sh` reverses and why this does too.
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
 * Stubs everything an arm touches so the ordering can be read without publishing anything.
 *
 * The health endpoint is **stateful**, and that is what makes the test both fast and faithful: it
 * reports a live stream until the watch has run, then reports none. A stub that always answered "one
 * active stream" would send every arm through the whole `wait_for_quiet` budget, which is exactly the
 * state the script exists to notice, so the test would sit out a real timeout per arm and prove
 * nothing about the ordering it is measuring.
 */
function stubBin(binDir, recordPath, watchedFlag, restartLog, removalLog, chequebookPort) {
  mkdirSync(binDir, { recursive: true });

  // Records `restart`, so a cold arm is distinguishable from a warm one, and succeeds at everything
  // else, since arm teardown shells out to docker too.
  writeFileSync(
    join(binDir, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'restart') {
  fs.appendFileSync(${JSON.stringify(restartLog)}, process.argv[3] + '\\n');
}
if (process.argv[2] === 'rm') {
  fs.appendFileSync(${JSON.stringify(removalLog)}, process.argv.slice(3).join(' ') + '\\n');
}
// Lists one publisher already on the box, so a run that tears down everything matching the
// pattern shows up as a removal here.
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
} else if (url.includes('/health')) {
  // Live until this arm's watch has run, then quiet, which is what a real publisher teardown looks
  // like and what lets wait_for_quiet return instead of expiring.
  const watched = fs.existsSync(${JSON.stringify(watchedFlag)});
  if (watched) {
    fs.rmSync(${JSON.stringify(watchedFlag)});
  }
  process.stdout.write(JSON.stringify({ activeStreams: watched ? 0 : 1 }));
}
`,
  );
  writeFileSync(
    join(binDir, 'pnpm'),
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'browser:watch') {
  fs.appendFileSync(${JSON.stringify(recordPath)}, process.env.BROWSER_GOP_SECONDS + '\\n');
  fs.writeFileSync(${JSON.stringify(watchedFlag)}, '');
}
process.exit(0);
`,
  );
  for (const name of ['docker', 'curl', 'pnpm']) {
    chmodSync(join(binDir, name), 0o755);
  }
}

async function runArms({ arms, rounds, bzz = 500, preflightOnly = false, margin = '10', cold = '', warmupRounds }) {
  const port = await startChequebook(bzz);
  const out = mkdtempSync(join(tmpdir(), 'viewer-arms-'));
  cleanups.push(() => rmSync(out, { recursive: true, force: true }));
  const bin = join(out, 'bin');
  const record = join(out, 'gops.txt');
  writeFileSync(record, '');
  const restarts = join(out, 'restarts.txt');
  const removals = join(out, 'removals.txt');
  writeFileSync(restarts, '');
  writeFileSync(removals, '');
  stubBin(bin, record, join(out, 'watched.flag'), restarts, removals, port);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    OUT_DIR: out,
    // A tree with no publish-clock.sh, so `start_publisher` fails harmlessly in its subshell and the
    // stubbed health check is what carries the arm forward. The ordering is what this measures.
    BENCH_REPO: out,
    ARMS: arms,
    COLD_ARMS: cold,
    ...(warmupRounds === undefined ? {} : { WARMUP_ROUNDS: warmupRounds }),
    GATEWAY_READY_TIMEOUT_S: '5',
    ROUNDS: String(rounds),
    MINUTES: '1',
    // The stubbed health endpoint always reports a live stream, so wait_for_quiet would sit out its
    // whole budget on every arm. What this measures is the order the arms ran in, not the timeouts.
    STREAM_TIMEOUT_S: '5',
    QUIET_TIMEOUT_S: '5',
    // A one-minute arm cannot carry the real 90s publisher margin, and the margin is not what these
    // measure. The refusal that margin exists to produce has its own case below.
    PUBLISHER_MARGIN_S: margin,
    UPLOADER_BEE_PORT: String(port),
    GATEWAY_BEE_PORT: String(port),
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
    state: existsSync(join(out, 'viewer-arms-state.tsv'))
      ? readFileSync(join(out, 'viewer-arms-state.tsv'), 'utf8').split('\n').filter(Boolean)
      : [],
    gops: readFileSync(record, 'utf8').split('\n').filter(Boolean),
    restarts: readFileSync(restarts, 'utf8').split('\n').filter(Boolean),
    removals: readFileSync(removals, 'utf8').split('\n').filter(Boolean),
    log: readFileSync(join(out, 'viewer-arms.log'), 'utf8'),
  };
}

describe('a viewer sitting runs its arms in an order that cannot fake a result', () => {
  it('reverses the arm order on even rounds', async () => {
    const { gops } = await runArms({ arms: 'obs:2.0 shipped:0.5', rounds: 3 });

    assert.deepEqual(gops, ['2.0', '0.5', '0.5', '2.0', '2.0', '0.5']);
  });

  it('reverses three arms as well, not only a pair', async () => {
    const { gops } = await runArms({ arms: 'a:2.0 b:1.0 c:0.5', rounds: 2 });

    assert.deepEqual(gops, ['2.0', '1.0', '0.5', '0.5', '1.0', '2.0']);
  });

  it('runs every arm in every round, so a sitting is the size it claims', async () => {
    const { gops, log } = await runArms({ arms: 'a:2.0 b:0.5', rounds: 3 });

    assert.equal(gops.length, 6);
    assert.match(log, /2 arms x 3 rounds x 1 min = 6 broadcasts/);
  });

  /**
   * A sitting that stops partway leaves arms measured on a node its peers have stopped serving, so
   * the rows on either side of the exhaustion are not comparable and interleaving them bought
   * nothing.
   */
  it('refuses to start when it cannot pay for every arm it intends to run', async () => {
    const { code, gops, log } = await runArms({ arms: 'a:2.0 b:0.5', rounds: 3, bzz: 0 });

    assert.equal(code, 1);
    assert.equal(gops.length, 0, 'it published despite refusing to start');
    assert.match(log, /REFUSING TO START/);
  });

  it('answers whether it can afford a sitting without publishing one', async () => {
    const { code, gops, log } = await runArms({ arms: 'a:2.0 b:0.5', rounds: 3, preflightOnly: true });

    assert.equal(code, 0);
    assert.equal(gops.length, 0);
    assert.match(log, /PREFLIGHT_ONLY/);
  });

  /**
   * `watch_seconds` is the arm minus a margin the publisher needs on both ends. Below about two
   * minutes that goes negative, and a negative watch still produces a full set of arms, a full ledger
   * and no samples, which reads as a sitting that ran.
   */
  it('refuses a sitting too short to watch anything, rather than running empty arms', async () => {
    const { code, gops, log } = await runArms({ arms: 'a:2.0 b:0.5', rounds: 2, margin: '90' });

    assert.equal(code, 1);
    assert.equal(gops.length, 0);
    assert.match(log, /REFUSING TO START: MINUTES=1 leaves -30s to watch/);
  });

  /**
   * A cold join is an empty retrieval cache and no warm peer connections, which is the state a real
   * viewer arrives in. Restarting the gateway for every arm would make it the condition rather than
   * the treatment, so only the named arms get it and the rest are the control taken beside them.
   */
  it('restarts the gateway only for the arms named cold', async () => {
    const { restarts, gops } = await runArms({ arms: 'cold:0.5 warm:0.5', rounds: 2, cold: 'cold' });

    assert.equal(gops.length, 4);
    assert.equal(restarts.length, 2, 'a cold arm per round, and no more');
    assert.deepEqual(new Set(restarts), new Set(['latbench-bee-gateway-1']));
  });

  it('restarts nothing when no arm is named cold', async () => {
    const { restarts } = await runArms({ arms: 'a:2.0 b:0.5', rounds: 2 });

    assert.deepEqual(restarts, []);
  });

  it('records the cold treatment on every row, so a table cannot lose which arms got it', async () => {
    const { log } = await runArms({ arms: 'cold:0.5 warm:0.5', rounds: 2, cold: 'cold' });

    assert.match(log, /cold-join arms \(gateway restarted before the browser opens\): cold/);
    assert.match(log, /gateway restarted for a cold join, answered after/);
  });

  /**
   * The teardown matches every publisher on the box, not only this run's, and it hangs off an EXIT
   * trap. On 2026-08-12 a PREFLIGHT_ONLY invocation, which publishes nothing at all, exited through
   * that trap and killed the broadcast a paid buffer sweep had been running against for forty
   * minutes. The sweep carried on sampling a dead stream.
   */
  it('kills nothing on a preflight, which publishes nothing', async () => {
    const { code, restarts, removals, log } = await runArms({ arms: 'a:2.0 b:0.5', rounds: 2, preflightOnly: true });

    assert.equal(code, 0);
    assert.deepEqual(removals, [], 'a preflight removed a container');
    assert.deepEqual(restarts, []);
    assert.match(log, /PREFLIGHT_ONLY/);
  });

  it('kills nothing when it refuses to start for want of funds', async () => {
    const { code, removals } = await runArms({ arms: 'a:2.0 b:0.5', rounds: 2, bzz: 0 });

    assert.equal(code, 1);
    assert.deepEqual(removals, [], 'a refused sitting removed a container');
  });

  /**
   * A soak is one arm held for hours. It has nothing to compare against and nothing to warm up for,
   * and labelling its only round as discarded would file a four-hour broadcast as a warm-up nobody
   * counted.
   */
  it('counts every arm when no warm-up round was asked for', async () => {
    const { state, log } = await runArms({ arms: 'soak:0.5', rounds: 1, warmupRounds: '0' });

    assert.equal(state.length, 1);
    assert.match(state[0], /\tcounted\t/);
    assert.match(log, /no warm-up round, so every arm counts/);
  });

  it('discards the rounds it was told to, not always exactly one', async () => {
    const { state } = await runArms({ arms: 'a:2.0', rounds: 3, warmupRounds: '2' });

    assert.equal(state.filter((row) => row.includes('\twarm-up\t')).length, 2);
    assert.equal(state.filter((row) => row.includes('\tcounted\t')).length, 1);
  });

  it('says which round is warm-up, since the arms are otherwise identical in the log', async () => {
    const { log } = await runArms({ arms: 'a:2.0 b:0.5', rounds: 2 });

    assert.match(log, /the first 1 round\(s\) are warm-up and are discarded/);
  });
});
