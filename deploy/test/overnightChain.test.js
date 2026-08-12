import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'deploy/scripts/overnight-chain.sh');

/**
 * That a night of paid sittings stops itself.
 *
 * Every unattended night before this one ran only work that could not spend: the arms were unfunded,
 * so the node itself was the proof. This chain publishes, so the properties that used to come free
 * have to be built and driven.
 *
 * ⛔ The one that matters most is the shared stop file. A floor crossed in sitting two is still
 * crossed in sitting three, because the nodes do not refill in between, and a chain that treated
 * each sitting's funding as a fresh question would spend the rest of the night measuring what peers
 * do to a node that cannot pay.
 */

const cleanups = [];

after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

/**
 * A driver that records the environment it was handed and does what the plan told it to.
 *
 * `sleep` makes it outlive a deadline, `stop` makes it write the shared stop file the way the real
 * sampler does, and `fail` makes it refuse the way a funding or capacity gate does.
 */
function stubDriver(path) {
  writeFileSync(
    path,
    `#!/usr/bin/env bash
echo "\${SITTING_NAME:-unnamed} OUT_DIR=\${OUT_DIR} STOP_FILE=\${STOP_FILE} ARMS=[\${ARMS:-}]" >> "\${CHAIN_RECORD}"
case "\${BEHAVIOUR:-ok}" in
  sleep) sleep 600 ;;
  stop) echo "the uploader dropped under its reserve" > "\${STOP_FILE}" ;;
  fail) exit 3 ;;
esac
exit 0
`,
  );
  chmodSync(path, 0o755);
}

async function runChain(planLines, { loadavg = '1.00 1.00 1.00 1/1 1', extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'overnight-chain-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  // Beside the real script, since the chain resolves a driver relative to its own directory.
  const driver = join(ROOT, 'deploy/scripts', `stub-driver-${dir.split('-').pop()}.sh`);
  stubDriver(driver);
  cleanups.push(() => rmSync(driver, { force: true }));

  const record = join(dir, 'record.txt');
  writeFileSync(record, '');
  const loadavgFile = join(dir, 'loadavg');
  writeFileSync(loadavgFile, `${loadavg}\n`);
  const plan = join(dir, 'plan.tsv');
  writeFileSync(plan, planLines.map((line) => line.replace(/\{driver\}/g, driver.split('/').pop())).join('\n') + '\n');

  const env = {
    ...process.env,
    CHAIN_DIR: join(dir, 'chain'),
    CHAIN_RECORD: record,
    LOADAVG_FILE: loadavgFile,
    POLL_S: '1',
    GRACE_S: '2',
    LOAD_WAIT_S: '1',
    LOAD_WAIT_MAX_S: '2',
    ...extraEnv,
  };

  let code = 0;
  try {
    await run('bash', [SCRIPT, plan], { env, encoding: 'utf8' });
  } catch (failure) {
    code = failure.code;
  }
  const stateFile = join(dir, 'chain', 'chain-state.tsv');
  return {
    code,
    record: readFileSync(record, 'utf8').split('\n').filter(Boolean),
    state: existsSync(stateFile) ? readFileSync(stateFile, 'utf8').split('\n').filter(Boolean) : [],
    log: existsSync(join(dir, 'chain', 'chain.log')) ? readFileSync(join(dir, 'chain', 'chain.log'), 'utf8') : '',
  };
}

describe('a night of paid sittings runs in order and stops itself', () => {
  it('runs every sitting in the order the plan lists them', async () => {
    const { record, state } = await runChain([
      'first\t5\t{driver}\tSITTING_NAME=first',
      'second\t5\t{driver}\tSITTING_NAME=second',
      'third\t5\t{driver}\tSITTING_NAME=third',
    ]);

    assert.deepEqual(
      record.map((line) => line.split(' ')[0]),
      ['first', 'second', 'third'],
    );
    assert.equal(state.length, 3);
    assert.ok(state.every((row) => row.includes('\tok\t')));
  });

  it('gives each sitting its own directory and one stop file for the night', async () => {
    const { record } = await runChain([
      'first\t5\t{driver}\tSITTING_NAME=first',
      'second\t5\t{driver}\tSITTING_NAME=second',
    ]);

    const outDirs = record.map((line) => line.match(/OUT_DIR=(\S+)/)[1]);
    const stopFiles = record.map((line) => line.match(/STOP_FILE=(\S+)/)[1]);
    assert.equal(new Set(outDirs).size, 2, 'two sittings shared an output directory');
    assert.equal(new Set(stopFiles).size, 1, 'each sitting got its own stop file');
  });

  /**
   * ⛔ The property the whole design turns on. The nodes do not refill between sittings, so a floor
   * crossed once is crossed for the rest of the night.
   */
  it('skips everything after a sitting crosses a floor', async () => {
    const { record, state, log } = await runChain([
      'first\t5\t{driver}\tSITTING_NAME=first|BEHAVIOUR=stop',
      'second\t5\t{driver}\tSITTING_NAME=second',
      'third\t5\t{driver}\tSITTING_NAME=third',
    ]);

    assert.deepEqual(
      record.map((line) => line.split(' ')[0]),
      ['first'],
      'a sitting ran after a floor had been crossed',
    );
    assert.ok(state.some((row) => row.includes('SKIPPED-FLOOR')));
    assert.match(log, /the uploader dropped under its reserve/);
  });

  /**
   * The longest thing this project has run is ten minutes, and a four-hour arm is a regime nothing
   * has been watched in. The failure to protect against is not cost, it is a sitting that hangs at
   * minute twenty and takes the rest of the night with it.
   */
  it('stops a sitting that runs past its deadline and carries on to the next', async () => {
    const { record, state, log } = await runChain([
      'slow\t1\t{driver}\tSITTING_NAME=slow|BEHAVIOUR=sleep',
      'after\t5\t{driver}\tSITTING_NAME=after',
    ]);

    assert.ok(state.some((row) => row.includes('DEADLINE')));
    assert.ok(
      record.map((line) => line.split(' ')[0]).includes('after'),
      'a deadline stop took the rest of the night with it',
    );
    assert.match(log, /passed its 1 min deadline/);
  }).timeout = 120000;

  /** A sitting that refuses for want of funds or capacity is a clean stop, not a reason to stop the night. */
  it('carries on after a sitting refuses to start', async () => {
    const { record, state } = await runChain([
      'refused\t5\t{driver}\tSITTING_NAME=refused|BEHAVIOUR=fail',
      'after\t5\t{driver}\tSITTING_NAME=after',
    ]);

    assert.ok(state[0].includes('REFUSED-OR-FAILED(3)'));
    assert.ok(record.map((line) => line.split(' ')[0]).includes('after'));
  });

  /**
   * The box carries roughly forty other bee nodes and eight unrelated stacks. "Existing resources
   * must not be touched" covers starving them as much as stopping them.
   */
  it('skips a sitting rather than starting it on a box the neighbours are already using', async () => {
    const { record, state, log } = await runChain(['heavy\t5\t{driver}\tSITTING_NAME=heavy'], {
      loadavg: '96.00 90.00 88.00 1/1 1',
      extraEnv: { LOAD_CEILING: '32' },
    });

    assert.deepEqual(record, [], 'a sitting started on an already-loaded box');
    assert.ok(state.some((row) => row.includes('SKIPPED-LOAD')));
    assert.match(log, /host load 96 is over the ceiling/);
  });

  it('starts once the neighbours quieten down inside the waiting budget', async () => {
    const { record } = await runChain(['ok\t5\t{driver}\tSITTING_NAME=ok'], {
      loadavg: '8.00 8.00 8.00 1/1 1',
      extraEnv: { LOAD_CEILING: '32' },
    });

    assert.equal(record.length, 1);
  });

  it('refuses a plan it cannot read rather than running an empty night', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'overnight-chain-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    let code = 0;
    try {
      await run('bash', [SCRIPT, join(dir, 'nope.tsv')], {
        env: { ...process.env, CHAIN_DIR: join(dir, 'chain') },
        encoding: 'utf8',
      });
    } catch (failure) {
      code = failure.code;
    }

    assert.equal(code, 2);
    assert.match(readFileSync(join(dir, 'chain', 'chain.log'), 'utf8'), /cannot read the plan/);
  });

  /**
   * ⛔ The most important setting any sitting passes is its arm list, which is one value holding two
   * arms separated by a space. Split the settings column on whitespace and `env` reads the second
   * arm as the name of a command to run: the sitting dies at startup having published nothing, and
   * what it was supposed to compare never gets compared.
   */
  it('carries a setting whose value contains spaces, which every multi-arm sitting has', async () => {
    const { record } = await runChain([
      'pair\t5\t{driver}\tARMS=obs-default:2.0 shipped:0.5|SITTING_NAME=pair|ROUNDS=4',
    ]);

    assert.equal(record.length, 1);
    assert.match(record[0], /ARMS=\[obs-default:2\.0 shipped:0\.5\]/);
  });

  it('ignores blank lines and comments, so a plan can say why a sitting is there', async () => {
    const { record } = await runChain([
      '# the OBS default, since that is the GOP most likely to arrive uninvited',
      'first\t5\t{driver}\tSITTING_NAME=first',
      '',
      'second\t5\t{driver}\tSITTING_NAME=second',
    ]);

    assert.equal(record.length, 2);
  });
});
