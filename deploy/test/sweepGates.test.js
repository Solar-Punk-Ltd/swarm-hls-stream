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

/**
 * That the screening sweep refuses what it cannot finish, on postage as well as on funds.
 *
 * ⛔⛔ It checked the chequebook before every run and asked nothing at all about the batch it was
 * writing to. Those are not interchangeable. A node that runs out of BZZ is refused service by its
 * peers, which is loud; an **immutable** batch that fills refuses the upload, and a mutable one
 * silently overwrites while every health signal stays green. The sweep would have published into
 * either without a word.
 *
 * `viewer-arms.sh` has had this gate since 2026-08-12, when three sittings ran past the written 75%
 * stop line because the only thing between the threshold and the spend was somebody remembering to
 * look. The sweep is the other driver that spends, and it was left out.
 */

const cleanups = [];

after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

const PLUR_PER_BZZ = 10n ** 16n;

/**
 * Stubs the node and docker so a whole sweep can be driven without publishing anything.
 *
 * The stamps answer is read from a file on every call rather than baked in, so a test can fill the
 * batch partway through and prove the gate is asked again per run rather than only at the preflight.
 */
function stubBin({ dir, availableBzz = 500, utilization = 254, ttlSeconds = 941760, uploaderEnv = `STAMP=${BATCH}\n` }) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const utilizationFile = join(dir, 'utilization');
  writeFileSync(utilizationFile, String(utilization));
  const runs = join(dir, 'docker-runs.txt');
  writeFileSync(runs, '');

  const plur = ((BigInt(Math.round(availableBzz * 1000)) * PLUR_PER_BZZ) / 1000n).toString();

  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const url = process.argv.slice(2).find((a) => a.startsWith('http')) || '';
if (url.includes('/chequebook/balance')) {
  process.stdout.write(JSON.stringify({ totalBalance: '${plur}', availableBalance: '${plur}' }));
} else if (url.includes('/stamps')) {
  process.stdout.write(JSON.stringify({ stamps: [{
    batchID: ${JSON.stringify(BATCH)},
    utilization: Number(fs.readFileSync(${JSON.stringify(utilizationFile)}, 'utf8').trim()),
    usable: true, label: 'stub', depth: 25, amount: '36043833600', bucketDepth: 16,
    immutableFlag: true, exists: true, batchTTL: ${ttlSeconds},
  }] }));
} else if (url.includes('/metrics')) {
  process.stdout.write('bee_pusher_total_synced 12\\n');
}
`,
  );

  // Records every `docker run`, which is the only way this sweep publishes, and reports the batch the
  // uploader is configured with when asked to inspect it.
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'inspect') process.stdout.write(${JSON.stringify(uploaderEnv)});
if (process.argv[2] === 'run') fs.appendFileSync(${JSON.stringify(runs)}, process.argv.slice(3).join(' ') + '\\n');
`,
  );
  writeFileSync(join(bin, 'getent'), '#!/usr/bin/env node\nprocess.stdout.write("docker:x:999:\\n");\n');
  for (const name of ['curl', 'docker', 'getent']) {
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, utilizationFile, runs };
}

async function runSweep({
  rounds = 1,
  minutes = 3,
  configs = 'ref-720-0.5:1280x720:2500:0.5',
  preflightOnly = false,
  ...node
}) {
  const out = mkdtempSync(join(tmpdir(), 'sweep-gates-'));
  cleanups.push(() => rmSync(out, { recursive: true, force: true }));
  const stubs = stubBin({ dir: out, ...node });

  const env = {
    ...process.env,
    PATH: `${stubs.bin}:${process.env.PATH}`,
    OUT_DIR: out,
    REPO_DIR: out,
    ROUNDS: String(rounds),
    MINUTES: String(minutes),
    SWEEP_CONFIGS: configs,
    UPLOADER_BEE_PORT: '10075',
    GATEWAY_BEE_PORT: '10077',
    UPLOADER_BURN_PLUR_PER_MIN: String(PLUR_PER_BZZ / 100n),
    GATEWAY_BURN_PLUR_PER_MIN: String(PLUR_PER_BZZ / 100n),
    FUNDS_MARGIN_PERCENT: '100',
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
    log: readFileSync(join(out, 'sweep.log'), 'utf8'),
    state: existsSync(join(out, 'sweep-state.tsv'))
      ? readFileSync(join(out, 'sweep-state.tsv'), 'utf8').split('\n').filter(Boolean)
      : [],
    published: readFileSync(stubs.runs, 'utf8').split('\n').filter(Boolean),
    fillBatch: (to) => writeFileSync(stubs.utilizationFile, String(to)),
  };
}

describe('a sweep proves the batch can carry it before it publishes anything', () => {
  it('starts when the batch has room and time', async () => {
    const { code, log } = await runSweep({ preflightOnly: true });

    assert.equal(code, 0);
    assert.match(log, /stamp-guard: 7849851f/);
  });

  /** 400 of a depth-25 batch's 512 buckets is 78%, past the written 75% stop line. */
  it('refuses a batch past its stop line, and publishes nothing', async () => {
    const { code, log, published } = await runSweep({ utilization: 400 });

    assert.equal(code, 1);
    assert.deepEqual(published, [], 'a sweep published against a batch past the stop line');
    assert.match(log, /REFUSING TO START: the postage batch cannot carry this sweep/);
  });

  it('refuses a batch about to lapse, which topping up cannot fix in time', async () => {
    const { code, published } = await runSweep({ ttlSeconds: 3600 });

    assert.equal(code, 1);
    assert.deepEqual(published, [], 'a sweep published against a batch about to lapse');
  });

  /**
   * Unknown capacity is not permission to spend against it. The batch is read off the container that
   * is actually publishing, since `/stamps` lists batches of which some are dead and one of them on
   * this host is mutable, which overwrites in silence.
   */
  it('refuses when the uploader will not say which batch it is using', async () => {
    const { code, log, published } = await runSweep({ uploaderEnv: 'LOG_LEVEL=debug\n' });

    assert.equal(code, 1);
    assert.deepEqual(published, []);
    assert.match(log, /could not read STAMP/);
  });

  /**
   * ⭐ The preflight prices the whole sweep against a batch that is emptier than it will be by the
   * last run. Postage is spent by the same broadcasts the sweep is measuring, so a sitting long
   * enough to matter can start inside the line and finish outside it. Asking once is asking about a
   * batch that no longer exists by run four.
   */
  it('asks again before every run, not only at the preflight', async () => {
    const sweep = await runSweep({ rounds: 4, configs: 'a:1280x720:2500:0.5 b:1280x720:2500:2.0' });

    assert.ok(sweep.published.length > 0, 'nothing published, so the per-run gate was never reached');
    assert.ok(
      sweep.log.split('stamp-guard: 7849851f').length - 1 > 1,
      'the batch was read once for the whole sweep',
    );
  });

  it('stops partway with a named reason when the batch fills under it', async () => {
    // Filled between runs, which is what a long sitting does to itself.
    const out = mkdtempSync(join(tmpdir(), 'sweep-fills-'));
    cleanups.push(() => rmSync(out, { recursive: true, force: true }));
    const stubs = stubBin({ dir: out });

    // The uploader's own publishing is what fills the batch, so the stub fills it on the first run.
    writeFileSync(
      join(stubs.bin, 'docker'),
      `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'inspect') process.stdout.write(${JSON.stringify(`STAMP=${BATCH}\n`)});
if (process.argv[2] === 'run') {
  fs.appendFileSync(${JSON.stringify(stubs.runs)}, 'run\\n');
  fs.writeFileSync(${JSON.stringify(stubs.utilizationFile)}, '400');
}
`,
    );
    chmodSync(join(stubs.bin, 'docker'), 0o755);

    let code = 0;
    try {
      await run('bash', [SCRIPT], {
        env: {
          ...process.env,
          PATH: `${stubs.bin}:${process.env.PATH}`,
          OUT_DIR: out,
          REPO_DIR: out,
          ROUNDS: '3',
          MINUTES: '3',
          SWEEP_CONFIGS: 'a:1280x720:2500:0.5 b:1280x720:2500:2.0',
          UPLOADER_BEE_PORT: '10075',
          GATEWAY_BEE_PORT: '10077',
          UPLOADER_BURN_PLUR_PER_MIN: String(PLUR_PER_BZZ / 100n),
          GATEWAY_BURN_PLUR_PER_MIN: String(PLUR_PER_BZZ / 100n),
          FUNDS_MARGIN_PERCENT: '100',
        },
        encoding: 'utf8',
      });
    } catch (failure) {
      code = failure.code;
    }

    const published = readFileSync(stubs.runs, 'utf8').split('\n').filter(Boolean);
    const state = readFileSync(join(out, 'sweep-state.tsv'), 'utf8');

    assert.equal(code, 0, 'a sitting that measured rows before stopping is not a failed sitting');
    assert.equal(published.length, 1, 'the sweep carried on publishing past a full batch');
    assert.match(state, /NOT-RUN\(postage exhausted\)/);
  });
});
