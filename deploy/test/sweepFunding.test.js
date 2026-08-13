import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Async on purpose. The stub chequebook is served by this same process, so a synchronous spawn would
// block the event loop that has to answer it, and every lookup would sit out its full curl timeout.
const run = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'deploy/scripts/sweep-interleaved.sh');

/**
 * That a sweep refuses to start unless it can pay for every run it intends to make.
 *
 * On 2026-08-05 a sweep spent seven of its twelve runs before anyone noticed the uploader's
 * chequebook had reached exactly zero. Losing the last five runs was the smaller half of the damage.
 * A bee node that cannot pay is refused service by its peers, so the rows on either side of the
 * exhaustion were measuring starvation rather than configuration, and the whole purpose of an
 * interleaved sweep is that rows from one sitting can be read against each other.
 *
 * Both nodes are checked because both are paid: the uploader pays peers to take chunks and the
 * gateway pays to pull them back. Funding one and not the other is a real state, and it was the
 * state that morning.
 *
 * These drive the real script against a stub chequebook rather than testing the arithmetic in a
 * copy, because the defect was that nothing asked the question at all.
 */

const cleanups = [];

after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

const PLUR_PER_BZZ = 10n ** 16n;

function bzzToPlur(bzz) {
  return (BigInt(Math.round(bzz * 1000)) * PLUR_PER_BZZ) / 1000n;
}

const BATCH = '7849851f404265dd2bea17e4229b45be23e245210ea17ac0af3a2a2b13faa2fd';

/**
 * A batch with room and time, so these cases are decided by funding alone.
 *
 * Depth 25 gives 512 buckets, which is what the measurement batch became when it was diluted, and
 * 254 of them is the 50% the host actually reads. The capacity gate has its own cases in
 * `sweepGates.test.js`; what it must not do is decide the ones here.
 */
const HEALTHY_BATCH = {
  batchID: BATCH,
  utilization: 254,
  usable: true,
  label: 'stub',
  depth: 25,
  amount: '36043833600',
  bucketDepth: 16,
  immutableFlag: true,
  exists: true,
  batchTTL: 941760,
};

/**
 * A stand-in for a bee node, answering the two endpoints a sweep asks before it publishes.
 *
 * `availableBzz` of null answers 405 the way a node with swap disabled does, which is a deployment
 * shape rather than a shortfall and has to be distinguishable from zero.
 */
async function startChequebook(availableBzz) {
  const server = createServer((req, reply) => {
    if (req.url.startsWith('/stamps')) {
      reply
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ stamps: [HEALTHY_BATCH] }));
      return;
    }
    if (!req.url.startsWith('/chequebook/balance')) {
      reply.writeHead(404).end();
      return;
    }
    if (availableBzz === null) {
      reply.writeHead(405).end(JSON.stringify({ message: 'chequebook disabled' }));
      return;
    }
    const plur = bzzToPlur(availableBzz).toString();
    reply
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ totalBalance: plur, availableBalance: plur }));
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(() => server.close());
  return server.address().port;
}

/**
 * Runs the real preflight and returns its exit code and log.
 *
 * The burn rates and margin are pinned here so the expected figures follow from the test's own
 * inputs rather than from whatever the measured constants happen to be this month.
 */
async function runPreflight({ uploaderPort, gatewayPort, rounds = 1, minutes = 3, configs }) {
  const out = mkdtempSync(join(tmpdir(), 'sweep-funds-'));
  cleanups.push(() => rmSync(out, { recursive: true, force: true }));

  const env = {
    ...process.env,
    OUT_DIR: out,
    PREFLIGHT_ONLY: '1',
    ROUNDS: String(rounds),
    MINUTES: String(minutes),
    ...(configs === undefined ? {} : { SWEEP_CONFIGS: configs }),
    UPLOADER_BEE_PORT: String(uploaderPort),
    GATEWAY_BEE_PORT: String(gatewayPort),
    // Named directly rather than read off a container, so these cases need no docker at all.
    STAMP: BATCH,
    UPLOADER_BURN_PLUR_PER_MIN: String(PLUR_PER_BZZ / 100n), // 0.01 BZZ per minute
    GATEWAY_BURN_PLUR_PER_MIN: String(PLUR_PER_BZZ / 100n),
    FUNDS_MARGIN_PERCENT: '100',
  };

  let code = 0;
  try {
    await run('bash', [SCRIPT], { env, encoding: 'utf8' });
  } catch (failure) {
    code = failure.code;
  }
  return { code, log: readFileSync(join(out, 'sweep.log'), 'utf8') };
}

describe('a sweep proves it can pay before it publishes anything', () => {
  it('starts when both nodes can cover the whole sweep', async () => {
    const funded = await startChequebook(5);
    const result = await runPreflight({ uploaderPort: funded, gatewayPort: funded });

    assert.equal(result.code, 0);
    assert.match(result.log, /preflight: uploader .* ok/);
    assert.match(result.log, /preflight: gateway .* ok/);
  });

  it('refuses when the uploader cannot cover the sweep, and names it', async () => {
    const empty = await startChequebook(0);
    const funded = await startChequebook(5);
    const result = await runPreflight({ uploaderPort: empty, gatewayPort: funded });

    assert.equal(result.code, 1);
    assert.match(result.log, /uploader has 0\.000 BZZ.*SHORT/);
    assert.match(result.log, /REFUSING TO START/);
  });

  it('refuses when only the gateway is short, since the read side is paid separately', async () => {
    const funded = await startChequebook(5);
    const empty = await startChequebook(0);
    const result = await runPreflight({ uploaderPort: funded, gatewayPort: empty });

    assert.equal(result.code, 1);
    assert.match(result.log, /gateway has 0\.000 BZZ.*SHORT/);
  });

  it('refuses when a chequebook cannot be read at all', async () => {
    // Unknown funding is not permission to spend. A node answering 405 has no chequebook, which is
    // the shape that caused LAT-10, so treating it as "nothing to check" is how that returns.
    const noChequebook = await startChequebook(null);
    const funded = await startChequebook(5);
    const result = await runPreflight({ uploaderPort: noChequebook, gatewayPort: funded });

    assert.equal(result.code, 1);
    assert.match(result.log, /uploader chequebook on \d+ did not answer/);
  });

  it('requires three times as much for three times the rounds', async () => {
    // Relational rather than absolute, so editing the config grid does not falsify the arithmetic.
    const funded = await startChequebook(500);
    const one = await runPreflight({ uploaderPort: funded, gatewayPort: funded, rounds: 1 });
    const three = await runPreflight({ uploaderPort: funded, gatewayPort: funded, rounds: 3 });

    assert.ok(needed(one) > 0);
    assert.equal(needed(three), needed(one) * 3);
  });

  /**
   * A focused pair costs what a pair costs, so a question needing two configurations does not have to
   * buy four. The estimate has to follow the override or the funding check would guard the default
   * grid while the sweep ran a different one.
   */
  it('prices the grid it was given rather than the one in the script', async () => {
    const funded = await startChequebook(500);
    const pair = await runPreflight({
      uploaderPort: funded,
      gatewayPort: funded,
      configs: 'ref-720-0.5:1280x720:2500:0.5 720-0.25:1280x720:2500:0.25',
    });
    const fullGrid = await runPreflight({ uploaderPort: funded, gatewayPort: funded });

    assert.match(pair.log, /sweep starting: 2 configs/);
    assert.match(fullGrid.log, /sweep starting: 4 configs/);
    assert.equal(needed(pair) * 2, needed(fullGrid));
  });
});

/** The uploader's estimate for the whole sweep, in BZZ, as the preflight reported it. */
function needed({ log }) {
  return Number(log.match(/preflight: uploader has [\d.]+ BZZ, needs ([\d.]+)/)[1]);
}
