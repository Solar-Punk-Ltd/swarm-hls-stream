import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'deploy/scripts/unfunded-gateway.sh');

/**
 * That the second gateway of #93 can be stood up beside the funded one without touching it.
 *
 * ⛔ Every viewer figure this project holds came through a chequebook-funded gateway. Measuring the
 * shipping case needs a second node that is deliberately unfunded, and it has to be warm at the same
 * time as the funded one so the arms can alternate under a single broadcast rather than being two
 * soaks with a night between them.
 *
 * ⛔⛔ It runs standalone rather than as a compose service, and that is the safety property. This host
 * carries the running latbench stack plus forty other bee nodes and eight unrelated stacks. A compose
 * change can recreate services that were not meant to move, and the funded gateway losing its warm
 * peer set mid-sitting would silently become the cold-join penalty instead of the funded arm.
 *
 * ⛔⛔⛔ Teardown is BY EXACT NAME, never by pattern. A teardown keyed on a name pattern killed a live
 * paid broadcast on 2026-08-12.
 */

const cleanups = [];

after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

const CONTAINER = 'swarm-hls-unfunded-gateway';

/**
 * A docker that records its argv and reports an inventory the test controls.
 *
 * `existing` is what `docker ps -aq --filter name=...` answers, so a case can put a container in the
 * way and assert what the script does about it.
 */
function stubBin({ dir, existing = '', portInUse = false, peers = 120, healthy = true, chequebookCode = 405 }) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const argvLog = join(dir, 'docker-argv.jsonl');
  writeFileSync(argvLog, '');

  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + '\\n');
if (argv[0] === 'ps') process.stdout.write(${JSON.stringify(existing)});
process.exit(0);
`,
  );

  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env node
const url = process.argv.slice(2).find((a) => a.startsWith('http')) || '';
if (url.includes('/health')) {
  ${healthy ? "process.stdout.write(JSON.stringify({ status: 'ok' }));" : 'process.exit(7);'}
} else if (url.includes('/peers')) {
  process.stdout.write(JSON.stringify({ peers: Array.from({ length: ${peers} }, (_, i) => ({ address: String(i) })) }));
} else if (url.includes('/chequebook/balance')) {
  // ⛔ Answers a STATUS CODE, because that is what the script must read. \`curl -s\` exits 0 for any
  // response it received, so a stub that merely exited non-zero would let a broken check pass.
  const wantsCode = process.argv.includes('-w');
  if (wantsCode) process.stdout.write('${chequebookCode}');
  else if (${chequebookCode} === 200) process.stdout.write(JSON.stringify({ availableBalance: '1' }));
}
`,
  );

  // `ss` decides whether the port is already taken by something else on this shared host.
  writeFileSync(
    join(bin, 'ss'),
    `#!/usr/bin/env node
process.stdout.write(${
      portInUse ? JSON.stringify('LISTEN 0 4096 *:10087 *:*\n') : JSON.stringify('LISTEN 0 4096 *:22 *:*\n')
    });
`,
  );

  for (const name of ['docker', 'curl', 'ss']) {
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, argvLog };
}

async function runScript(command, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'unfunded-gw-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const stubs = stubBin({ dir, ...options });

  let code = 0;
  let stdout = '';
  try {
    const result = await run('bash', [SCRIPT, ...command], {
      env: {
        ...process.env,
        PATH: `${stubs.bin}:${process.env.PATH}`,
        UNFUNDED_DATA_DIR: join(dir, 'data'),
        WARM_TIMEOUT_S: '3',
        WARM_POLL_S: '0.05',
      },
      encoding: 'utf8',
    });
    stdout = result.stdout;
  } catch (failure) {
    code = failure.code;
    stdout = `${failure.stdout || ''}${failure.stderr || ''}`;
  }

  const argv = readFileSync(stubs.argvLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { code, stdout, argv };
}

/** The `docker run` this script issued, if it issued one. */
function dockerRun(argv) {
  return argv.find((a) => a[0] === 'run');
}

describe('the unfunded gateway stands up beside the funded one', () => {
  it('runs an ultra-light node, which is the whole point of the arm', async () => {
    const { code, argv } = await runScript(['start']);
    const started = dockerRun(argv);

    assert.equal(code, 0);
    assert.ok(started, 'nothing was started');
    // Both flags together are bee's ultra-light mode: no chequebook, so no way to pay a peer for
    // bandwidth, so it lives on the free allowance alone. That IS the shipping viewer.
    assert.ok(started.includes('--swap-enable=false'), `not ultra-light: ${started.join(' ')}`);
    assert.ok(started.includes('--full-node=false'), `not ultra-light: ${started.join(' ')}`);
  });

  /**
   * ⛔⛔⛔ THE ARMS MUST DIFFER IN FUNDING AND IN NOTHING ELSE, and every flag here was found by
   * running the script for real rather than by reading the compose file.
   *
   * The first real start died instantly on `configure signer: inappropriate ioctl for device`,
   * because bee prompts for a password on first boot and a detached container has no terminal. No
   * stub asks bee for a password, so no stubbed test could have found it.
   *
   * Reading `docker inspect latbench-bee-gateway-1` then showed three more differences the compose
   * file does not: the funded gateway runs a LOCAL rpc at 127.0.0.1:9000 rather than the public
   * gnosischain endpoint this script first defaulted to, and it carries `--cors-allowed-origins`,
   * `--cache-capacity` and `--cache-retrieval`.
   *
   * ⭐ CORS is the one that would have been silently fatal. The viewer fetches from a browser, so
   * without it every retrieval in the unfunded arm fails at the preflight, and the arm reads as a
   * node that cannot serve rather than as one that is unfunded. That is a wrong answer, not a
   * missing one.
   */
  it('carries every flag the funded gateway carries, so funding is the only difference', async () => {
    const { argv } = await runScript(['start']);
    const started = dockerRun(argv);

    for (const flag of [
      '--cache-capacity=0',
      '--cache-retrieval=true',
      '--cors-allowed-origins=*',
      '--verbosity=4',
      '--password-file=/home/bee/.bee/password',
    ]) {
      assert.ok(started.includes(flag), `the unfunded arm is missing ${flag}: ${started.join(' ')}`);
    }
    assert.ok(
      started.some((arg) => arg === '--blockchain-rpc-endpoint=http://127.0.0.1:9000'),
      `it points at an rpc the funded gateway does not use: ${started.join(' ')}`,
    );
  });

  it('names the container exactly, so a teardown can never match anything else', async () => {
    const { argv } = await runScript(['start']);
    const started = dockerRun(argv);

    assert.ok(started.includes('--name'));
    assert.equal(started[started.indexOf('--name') + 1], CONTAINER);
  });

  /**
   * ⛔ The funded gateway is on 10077 and forty other bee nodes share this box. Starting on a port
   * something else holds would either fail obscurely or, worse, look like it worked while the arm
   * measured a node that is not ours.
   */
  it('refuses to start when its port is already held by something else', async () => {
    const { code, stdout, argv } = await runScript(['start'], { portInUse: true });

    assert.equal(code, 1);
    assert.equal(dockerRun(argv), undefined, 'it started a node on a port it does not own');
    assert.match(stdout, /10087/);
  });

  it('refuses to start when one is already running, rather than racing it', async () => {
    const { code, stdout, argv } = await runScript(['start'], { existing: `${CONTAINER}\n` });

    assert.equal(code, 1);
    assert.equal(dockerRun(argv), undefined);
    assert.match(stdout, /already/i);
  });

  /**
   * ⛔⛔⛔ By exact name and nothing else. On 2026-08-12 a teardown keyed on a name PATTERN removed
   * every container matching it, including the publisher serving a live paid broadcast, and the
   * sitting went on sampling a dead stream for forty minutes.
   */
  it('removes only its own container by exact name', async () => {
    const { argv } = await runScript(['stop'], { existing: `${CONTAINER}\n` });

    const removals = argv.filter((a) => a[0] === 'rm');
    assert.equal(removals.length, 1);
    assert.ok(removals[0].includes(CONTAINER));
    for (const call of argv) {
      assert.ok(
        !call.some((arg) => /name=\^?swarm-hls-(publish|browser)/.test(arg)),
        `it looked at containers that are not its own: ${call.join(' ')}`,
      );
    }
  });

  it('stops cleanly when there is nothing to stop', async () => {
    const { code, argv } = await runScript(['stop']);

    assert.equal(code, 0);
    assert.deepEqual(
      argv.filter((a) => a[0] === 'rm'),
      [],
    );
  });
});

/**
 * ⛔ A cold node answers /health long before it is useful. It was measured at 2-3x read cost for about
 * two minutes, and no readiness signal goes green late enough to catch it. So the arm waits on PEERS,
 * not on the node answering, and a sitting that starts before the wait returns is measuring the cold
 * penalty and filing it as the unfunded arm.
 */
describe('the unfunded gateway is warmed before it is measured', () => {
  it('waits for a peer count rather than for the node to answer at all', async () => {
    const { code, stdout } = await runScript(['wait', '40'], { peers: 120 });

    assert.equal(code, 0);
    assert.match(stdout, /120 peers/);
  });

  it('refuses when the node never reaches the floor, instead of returning a cold node', async () => {
    const { code, stdout } = await runScript(['wait', '40'], { peers: 3 });

    assert.equal(code, 1);
    assert.match(stdout, /3 peers/);
    assert.match(stdout, /40/);
  });

  /**
   * ⛔⛔⛔ A sitting gates its unfunded arms on this exit code, so a missing node answering zero is a
   * gate stuck OPEN. It would clear a condition that is not there, and the arms would then run
   * against a port nothing is listening on while the ledger recorded them as the unfunded arm.
   */
  it('refuses the arm when there is no node at all, rather than reporting nothing is wrong', async () => {
    const { code, stdout } = await runScript(['status']);

    assert.equal(code, 1);
    assert.match(stdout, /not running/);
  });

  it('reports it has no chequebook, which is the arm rather than a fault', async () => {
    const { code, stdout } = await runScript(['status'], { existing: `${CONTAINER}\n`, chequebookCode: 405 });

    assert.equal(code, 0);
    assert.match(stdout, /no chequebook/i);
  });

  /**
   * ⛔⛔ Against the real node the first version of this check called a correctly ultra-light node
   * "not the arm", because `curl -s` exits 0 for any HTTP response it received, including a 405. The
   * check has to read the status code, and these two cases are what hold it to that.
   */
  it('refuses the arm when the node does have a chequebook', async () => {
    const { code, stdout } = await runScript(['status'], { existing: `${CONTAINER}\n`, chequebookCode: 200 });

    assert.equal(code, 1);
    assert.match(stdout, /NOT the unfunded arm/);
  });

  /**
   * ⛔ A booting node answers 503 "Node is syncing", which says nothing about whether it has a
   * chequebook. That is a third answer, and collapsing it into either verdict would clear a node
   * nobody checked or reject one that is merely young. Measured on the real node while it booted.
   */
  it('will not call a still-syncing node either arm', async () => {
    const { code, stdout } = await runScript(['status'], { existing: `${CONTAINER}\n`, chequebookCode: 503 });

    assert.equal(code, 1);
    assert.match(stdout, /syncing/i);
    assert.doesNotMatch(stdout, /no chequebook/i);
  });
});
