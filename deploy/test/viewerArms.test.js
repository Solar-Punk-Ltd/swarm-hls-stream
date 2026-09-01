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
/** Synthetic. A live batch id in a committed fixture is a stamp anyone can spend against. */
const BATCH_ID = 'a'.repeat(64);

function stubBin(
  binDir,
  recordPath,
  watchedFlag,
  restartLog,
  removalLog,
  chequebookPort,
  batch,
  missingImage,
  selfcheckFails,
) {
  mkdirSync(binDir, { recursive: true });
  const stamps = {
    stamps: [
      {
        batchID: batch.id,
        utilization: batch.utilization,
        usable: batch.usable,
        label: 'stub',
        depth: 25,
        amount: '36043833600',
        bucketDepth: 16,
        immutableFlag: true,
        exists: true,
        batchTTL: batch.ttlSeconds,
      },
    ],
  };

  // Records `restart`, so a cold arm is distinguishable from a warm one, and succeeds at everything
  // else, since arm teardown shells out to docker too. `inspect` carries the batch the uploader is
  // configured with, which is where the capacity gate reads it from rather than from a file.
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
if (process.argv[2] === 'inspect') {
  process.stdout.write(${JSON.stringify(batch.env)});
}
if (process.argv[2] === 'image' && process.argv[3] === 'inspect') {
  process.exit(${missingImage ? 1 : 0});
}
if (process.argv[2] === 'run') {
  const args = process.argv.slice(3);
  const script = args[args.length - 1];
  const envOf = (name) => {
    const hit = args.find((a, i) => args[i - 1] === '-e' && a.startsWith(name + '='));
    return hit ? hit.slice(name.length + 1) : '';
  };
  if (script === 'browser:selfcheck') {
    process.exit(${selfcheckFails ? 1 : 0});
  }
  if (script === 'browser:watch') {
    fs.appendFileSync(${JSON.stringify(recordPath)}, envOf('BROWSER_GOP_SECONDS') + '\\n');
    fs.writeFileSync(${JSON.stringify(watchedFlag)}, '');
  }
}
// Lists one publisher already on the box, so a run that tears down everything matching the
// pattern shows up as a removal here.
if (process.argv[2] === 'ps') {
  const filter = process.argv.find((a) => a.startsWith('name='));
  if (filter && filter.includes('viewer-arms-browser')) {
    process.stdout.write('viewer-arms-browser\\n');
  } else {
    process.stdout.write('someone-elses-publisher\\n');
  }
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
  process.stdout.write('bee_pusher_total_synced 12\\nbee_retrieval_request_count 34\\n');
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
  for (const name of ['docker', 'curl']) {
    chmodSync(join(binDir, name), 0o755);
  }
}

const HEALTHY_BATCH = {
  id: BATCH_ID,
  utilization: 199,
  usable: true,
  ttlSeconds: 981972,
  env: `STAMP=${BATCH_ID}\nLOG_LEVEL=debug\n`,
};

async function runArms({
  arms,
  rounds,
  bzz = 500,
  preflightOnly = false,
  margin = '10',
  cold = '',
  warmupRounds,
  batch = HEALTHY_BATCH,
  stopFileFirst = false,
  withoutImage = false,
  selfcheck = false,
  ceilingPlur = 24n * 10n ** 15n,
}) {
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
  stubBin(bin, record, join(out, 'watched.flag'), restarts, removals, port, batch, withoutImage, selfcheck === 'fails');
  if (stopFileFirst) {
    writeFileSync(join(out, 'STOP'), 'a previous sitting crossed a floor\n');
  }
  // A recorder rather than the real collector. Each real snapshot is seven curls and two python
  // starts, and an ordering test that takes two of them per arm spends its whole budget proving
  // something `nodeMetrics.test.js` proves directly. What matters here is THAT every arm is
  // bracketed, which is exactly what this records.
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

  // The night's authorisation. Both nodes start where the chequebook answers, so a default sitting
  // has spent nothing yet and the ceiling is the only thing left that can refuse it.
  const ledger = join(out, 'spend-ledger.env');
  const startPlur = (BigInt(Math.round(bzz * 1000)) * 10n ** 13n).toString();
  writeFileSync(
    ledger,
    [
      'authorised_at=2026-08-14T00:00:00Z',
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
    NODE_METRICS: metricsStub,
    STOP_POLL_S: '0.05',
    // The selfcheck launches a real browser. Its own refusal has a case below that turns it back on.
    RUN_SELFCHECK: selfcheck ? '1' : '0',

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
    metricsCalls: readFileSync(metricsCalls, 'utf8').split('\n').filter(Boolean),
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

/**
 * That a sitting refuses rather than warns, and leaves the nodes' own account of what it did.
 *
 * ⛔ Both halves are answers to the same failure on 2026-08-12. The postage stop line was written in
 * bold in two places and read automatically by a checker that warns at the END of a run, and three
 * paid sittings went past it. And seventeen arms of a funded buffer sweep were scored entirely on
 * what the harness saw from outside, while both bee nodes kept a complete account of the same events
 * that nothing ever read.
 *
 * A threshold that is written down is not a control. Only a gate that refuses is one.
 */
describe('a sitting refuses what it cannot finish, and records what the nodes did', () => {
  it('refuses to start when the batch is past its stop line', async () => {
    const full = { ...HEALTHY_BATCH, utilization: 400 };
    const { code, log, removals, gops } = await runArms({ arms: 'a:2.0', rounds: 2, batch: full });

    assert.equal(code, 1);
    assert.deepEqual(gops, [], 'a sitting published against a batch past the stop line');
    assert.deepEqual(removals, [], 'a refused sitting removed a container');
    assert.match(log, /postage batch cannot carry this sitting/);
  });

  it('refuses to start when the batch has almost no time left', async () => {
    const expiring = { ...HEALTHY_BATCH, ttlSeconds: 3600 };
    const { code, gops } = await runArms({ arms: 'a:2.0', rounds: 2, batch: expiring });

    assert.equal(code, 1);
    assert.deepEqual(gops, [], 'a sitting published against a batch about to lapse');
  });

  /**
   * Unknown capacity is not permission to spend against it. The batch is read off the container that
   * is actually publishing, because `/stamps` lists four batches of which three are dead and "the
   * stamp" has meant a different row on three separate days here.
   */
  it('refuses when the uploader will not say which batch it is using', async () => {
    const silent = { ...HEALTHY_BATCH, env: 'LOG_LEVEL=debug\n' };
    const { code, log, gops } = await runArms({ arms: 'a:2.0', rounds: 2, batch: silent });

    assert.equal(code, 1);
    assert.deepEqual(gops, []);
    assert.match(log, /could not read STAMP/);
  });

  it('publishes nothing when a previous sitting left a stop file', async () => {
    const { code, gops, removals } = await runArms({ arms: 'a:2.0', rounds: 2, stopFileFirst: true });

    assert.equal(code, 1);
    assert.deepEqual(gops, [], 'a sitting published after a floor had already been crossed');
    assert.deepEqual(removals, [], 'a refused sitting removed a container');
  });

  it('brackets every arm and the whole sitting with a reading from both nodes', async () => {
    const { metricsCalls } = await runArms({ arms: 'a:2.0 b:0.5', rounds: 1, warmupRounds: '0' });

    const labels = metricsCalls.filter((call) => call.startsWith('snapshot ')).map((call) => call.split(/\s+/).pop());
    assert.deepEqual(labels, [
      'sitting-before',
      'round1-a-before',
      'round1-a-after',
      'round1-b-before',
      'round1-b-after',
      'sitting-after',
    ]);
    assert.equal(
      metricsCalls.filter((call) => call.startsWith('diff ')).length,
      3,
      'a diff per arm and one over the sitting',
    );
  });

  /**
   * ⛔⛔ This published real arms, paid for them, and recorded nothing, on 2026-08-12.
   *
   * The deployment host has no Chrome. It lives in `e2e/Dockerfile.browser`, with the Xvfb display
   * that makes the page genuinely foregrounded, and this driver runs ON the host. A first version
   * called `pnpm browser:watch` directly: every arm started a broadcast, waited for the stream, and
   * died on `Failed to launch chromium because executable doesn't exist`, then wrote a row like any
   * other arm.
   *
   * ⭐ The shape worth remembering: a missing instrument is discovered AFTER the money is spent
   * unless something checks for it before the publisher starts. The broadcast is the whole cost of
   * an arm and the watch is the only reason to pay it.
   */
  it('refuses before publishing when the browser image is not on the host', async () => {
    const { code, gops, removals, log } = await runArms({ arms: 'a:2.0', rounds: 2, withoutImage: true });

    assert.equal(code, 1);
    assert.deepEqual(gops, [], 'an arm published a broadcast it could not watch');
    assert.deepEqual(removals, [], 'a refused sitting removed a container');
    assert.match(log, /is not on this host, so no arm could open a browser/);
  });

  /**
   * ⛔⛔ The second fault on 2026-08-12 that a paid arm found and a free check could have.
   *
   * The watch reads both chequebooks through the harness, whose default transport is
   * `ssh ${E2E_SSH_TARGET}`. The deployment host has no private key with which to ssh to itself, and
   * an interactive session hides that behind agent forwarding while a detached one does not. Four
   * arms published, paid, and died on `Permission denied (publickey)`.
   *
   * ⭐ So the sitting now runs the free selfcheck first. It costs no broadcast, no postage and no
   * BZZ, and a failure there names the harness instead of looking like the deployment.
   */
  it('refuses when the free selfcheck fails, before any arm is published', async () => {
    const { code, gops, removals, log } = await runArms({ arms: 'a:2.0', rounds: 2, selfcheck: 'fails' });

    assert.equal(code, 1);
    assert.deepEqual(gops, [], 'an arm published after the selfcheck failed');
    // It reclaims its OWN browser container by then, which is cleanup and not a teardown. What it
    // must never touch is a publisher, because one of those may be serving somebody else's sitting.
    assert.deepEqual(
      removals.filter((line) => line.includes('publish')),
      [],
      'a refused sitting removed a publisher',
    );
    assert.match(log, /the browser selfcheck failed/);
  });

  /**
   * ⛔ A killed chain leaves its browser container behind: the driver dies, its `docker run` does
   * not. The image serves one Xvfb display, so the next sitting fails with `Cannot establish any
   * listening sockets`, which reads as a broken browser rather than as a stale one. That is exactly
   * how the revised soak refused on 2026-08-12, two hours after the container that blocked it had
   * stopped being useful.
   */
  it('reclaims its own leftover browser container before opening one', async () => {
    const { removals } = await runArms({ arms: 'a:2.0', rounds: 1, warmupRounds: '0' });

    assert.ok(
      removals.some((line) => line.includes('viewer-arms-browser')),
      'a sitting started without reclaiming a browser container that would hold the display',
    );
  });

  /**
   * ⛔⛔⛔ THIS TEST ASSERTED THE OPPOSITE UNTIL 2026-08-13, and the premise under it was wrong.
   *
   * The claim was that a broadcast costs ~0.15 BZZ to start, fitted from one sitting reading
   * 2.06 BZZ per broadcast hour against a soak's 0.78. That 2.06 is not reproducible from the
   * node's own chequebook: the snapshots bracket 48.1 of the sitting's 48.5 minutes and record
   * 0.5650 BZZ, which is 0.70 BZZ/hr with EIGHT broadcast starts inside it, cheaper than the soak
   * with one.
   *
   * Each of the six counted arms holds exactly one broadcast start, so subtracting the marginal
   * rate leaves the setup term exposed. It came out between -0.0089 and +0.0030 BZZ, five of six
   * negative. The constant in the gate was 0.15, fifty times the largest residue.
   *
   * ⭐ So the gate prices minutes only, and a sweep of short arms is not expensive. The wrong
   * constant was charging an eight-arm sitting 1.68 BZZ of margin-inflated cost that does not
   * exist, on a balance of 3.44, which is the same shape of mistake as the refit that cut a
   * planned 7.9-hour night to 2 hours.
   */
  it('does not refuse a sweep of short arms for the number of broadcasts it starts', async () => {
    // Covers the minutes with the margin on top, and nothing whatever for eight setups.
    const minutesOnly = 8 * 1 * 0.013 * 1.4 + 0.2;

    const { code, gops } = await runArms({ arms: 'a:2.0 b:0.5', rounds: 4, bzz: minutesOnly });

    assert.equal(code, 0);
    assert.equal(gops.length, 8, 'a sweep was refused for a per-broadcast cost that measured zero');
  });

  it('leaves no reading unpaired, so every arm can be differenced', async () => {
    const { metricsCalls } = await runArms({ arms: 'a:2.0', rounds: 2, warmupRounds: '0' });

    const snapshots = metricsCalls.filter((call) => call.startsWith('snapshot '));
    assert.equal(snapshots.length % 2, 0);
    assert.equal(
      snapshots.filter((call) => call.endsWith('-before')).length,
      snapshots.filter((call) => call.endsWith('-after')).length,
    );
  });
});

/**
 * ⛔⛔⛔ PR #179 PUT THE CAPACITY GATE IN ALL THREE DRIVERS AND THE SPEND CEILING IN ONE OF THEM.
 *
 * `can_afford` asks whether the nodes hold enough to pay, which stays true right down to an empty
 * chequebook, so a driver carrying only that authorises the entire balance. It also cannot see what
 * an earlier sitting the same night already spent, so two runs that each pass it land past the
 * owner's total together. This driver publishes and had nothing of the sort in front of it.
 */
describe('the spend ceiling, which this driver did not have', () => {
  const ARMS = 'obs-default:2.0 shipped:0.5';

  it('refuses a sitting that would spend past the authorisation, and publishes nothing', async () => {
    const result = await runArms({ arms: ARMS, rounds: 1, ceilingPlur: 10n ** 14n });

    assert.match(result.log, /REFUSING TO START/);
    assert.match(result.log, /authorisation/);
    assert.equal(result.gops.length, 0, 'it printed a refusal and broadcast anyway');
  });

  it('runs when the authorisation covers it, so the refusal above is the ceiling and not the harness', async () => {
    const result = await runArms({ arms: ARMS, rounds: 1 });

    assert.ok(result.gops.length > 0, 'nothing published here either, so the refusal proves nothing');
  });
});
