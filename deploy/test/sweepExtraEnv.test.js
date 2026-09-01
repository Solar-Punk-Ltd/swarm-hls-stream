import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Async for the same reason `sweepFunding.test.js` is: the stub chequebook is served by this process,
// so a synchronous spawn would block the loop that has to answer it.
const run = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'deploy/scripts/sweep-interleaved.sh');
const PLUR_PER_BZZ = 10n ** 16n;

/**
 * That the bench knobs a sitting asks for actually reach the runs it pays for.
 *
 * The driver used to hand every arm a fixed set of `BENCH_` variables, so a question answerable from
 * minutes already being broadcast needed a whole second sitting to ask. `SWEEP_EXTRA_ENV` closes
 * that, and both ways it can fail are silent: an unset value that expands to a stray argument breaks
 * the very first arm of a paid sitting, and a set value that never reaches the container produces a
 * full set of rows measured without the knob the sitting was bought to use.
 *
 * These drive the real script against a stubbed `docker` and assert on the argv it was handed,
 * because the whole risk lives in an argument list nobody reads until a broadcast has been spent.
 */

const cleanups = [];

after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

/** Synthetic. A live batch id in a committed fixture is a stamp anyone can spend against. */
const BATCH = 'a'.repeat(64);

/** Room and time, so nothing here is decided by the capacity gate, which has its own cases. */
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

async function startChequebook(availableBzz) {
  const plur = (BigInt(Math.round(availableBzz * 1000)) * PLUR_PER_BZZ) / 1000n;
  const server = createServer((req, reply) => {
    if (req.url.startsWith('/stamps')) {
      reply.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ stamps: [HEALTHY_BATCH] }));
      return;
    }
    if (!req.url.startsWith('/chequebook/balance')) {
      reply.writeHead(404).end();
      return;
    }
    reply
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ totalBalance: plur.toString(), availableBalance: plur.toString() }));
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(() => server.close());
  return server.address().port;
}

/**
 * A `docker` that records the argv of every `run` and does nothing else.
 *
 * One line of JSON per invocation, so an assertion can speak about a single arm as well as about all
 * of them. Anything that is not `run` exits 0 silently, since the driver also shells out for
 * unrelated bookkeeping and this test has no opinion about that.
 */
function stubDockerRecording(binDir, recordPath) {
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, 'docker');
  writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === 'run') {
  fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(argv) + '\\n');
}
process.exit(0);
`,
  );
  chmodSync(stub, 0o755);
}

/** Runs the real sweep for one round against a stub docker, and returns every recorded argv. */
async function runSweep(extraEnv) {
  const port = await startChequebook(500);
  const out = mkdtempSync(join(tmpdir(), 'sweep-extra-'));
  const repo = mkdtempSync(join(tmpdir(), 'sweep-repo-'));
  cleanups.push(() => rmSync(out, { recursive: true, force: true }));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));

  const bin = join(out, 'bin');
  const record = join(out, 'docker-argv.jsonl');
  writeFileSync(record, '');
  stubDockerRecording(bin, record);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    OUT_DIR: out,
    // Kept off the real bench tree, which is where `run_one` looks for the report an arm wrote.
    REPO_DIR: repo,
    ROUNDS: '1',
    MINUTES: '1',
    SWEEP_CONFIGS: 'ref:1280x720:2500:2.0 small:1280x720:2500:0.5',
    UPLOADER_BEE_PORT: String(port),
    GATEWAY_BEE_PORT: String(port),
    // Named directly rather than read off the stub docker, which records argv and answers nothing.
    STAMP: BATCH,
    ...(extraEnv === undefined ? {} : { SWEEP_EXTRA_ENV: extraEnv }),
  };

  // The driver exits non-zero on nothing to collect, which is expected here and not what is asserted.
  await run('bash', [SCRIPT], { env, encoding: 'utf8' }).catch(() => undefined);

  const runs = readFileSync(record, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  return { runs, log: readFileSync(join(out, 'sweep.log'), 'utf8') };
}

/** The values of every `-e NAME=VALUE` pair in one docker argv. */
function envPairs(argv) {
  return argv.filter((arg, index) => argv[index - 1] === '-e');
}

describe('the bench knobs a sitting asks for reach the runs it pays for', () => {
  it('hands every arm the extra environment, not only the first', async () => {
    const { runs } = await runSweep('BENCH_UNSERVED_WATCH_MS=60000');

    assert.equal(runs.length, 2);
    for (const argv of runs) {
      assert.ok(
        envPairs(argv).includes('BENCH_UNSERVED_WATCH_MS=60000'),
        `arm was not given the knob: ${envPairs(argv).join(' ')}`,
      );
    }
  });

  it('carries more than one pair, since a sitting rarely turns on exactly one thing', async () => {
    const { runs } = await runSweep('BENCH_UNSERVED_WATCH_MS=60000 BENCH_FEED_READER=walk');

    for (const argv of runs) {
      const pairs = envPairs(argv);
      assert.ok(pairs.includes('BENCH_UNSERVED_WATCH_MS=60000'));
      assert.ok(pairs.includes('BENCH_FEED_READER=walk'));
    }
  });

  /**
   * An empty bash array expanded without the `${arr[@]+...}` guard is an unbound variable under
   * `set -u`, and an unguarded `"${arr[@]}"` on older bash expands to one empty string. Either one
   * makes `docker run` reject its own arguments on the very first arm of a paid sitting, which is
   * the most expensive minute in which to discover a quoting bug.
   *
   * Asserted against the `-e` values rather than against every argument in the list, because the
   * driver already passes an empty `--group-add` on any host without `getent` and that is a separate
   * thing from whether this feature leaks an argument when it is switched off.
   */
  it('adds nothing at all when no extra environment was asked for', async () => {
    const withExtra = await runSweep('BENCH_UNSERVED_WATCH_MS=60000');
    const without = await runSweep(undefined);

    assert.equal(without.runs.length, 2);
    for (const argv of without.runs) {
      assert.ok(
        envPairs(argv).every((pair) => pair.length > 0 && pair.includes('=')),
        `an empty or malformed -e reached docker run: ${JSON.stringify(envPairs(argv))}`,
      );
    }
    // Exactly the one pair asked for, so the feature adds what it says and nothing beside it.
    assert.equal(envPairs(withExtra.runs[0]).length, envPairs(without.runs[0]).length + 1);
  });

  it('still passes the knobs the driver owns, so the extras are additional rather than a replacement', async () => {
    const { runs } = await runSweep('BENCH_UNSERVED_WATCH_MS=60000');

    for (const argv of runs) {
      const pairs = envPairs(argv);
      assert.ok(pairs.some((pair) => pair.startsWith('BENCH_GOP_SECONDS=')));
      assert.ok(pairs.some((pair) => pair.startsWith('BENCH_RUN_MINUTES=')));
    }
  });

  /**
   * A knob that changes what the instrument counts is part of the configuration a report has to
   * name, and this one leaves no trace in the row it produces.
   */
  it('names the extra environment in the log, because the rows do not', async () => {
    const { log } = await runSweep('BENCH_UNSERVED_WATCH_MS=60000');

    assert.match(log, /extra bench env on every arm: BENCH_UNSERVED_WATCH_MS=60000/);
  });

  it('says nothing about extra environment when there was none', async () => {
    const { log } = await runSweep(undefined);

    assert.doesNotMatch(log, /extra bench env/);
  });
});
