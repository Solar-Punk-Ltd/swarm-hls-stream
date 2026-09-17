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
const SCRIPT = join(ROOT, 'deploy/scripts/phase06-light-vs-ultralight.sh');
/** Synthetic. A live batch id in a committed fixture is a stamp anyone can spend against. */
const BATCH = 'a'.repeat(64);

/**
 * That the light-against-ultra-light sitting refuses what it cannot finish, at the margin it says.
 *
 * ⛔ This script had no tests at all, and it is one of the three that spend a broadcast. Two defects
 * had been sitting in it: a postage reader that selected a batch shape the host does not have, and
 * the margin below.
 */

const cleanups = [];

after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

const PLUR_PER_BZZ = 10n ** 16n;

/**
 * The stack's compose file, which is a different checkout from the one this driver is synced into.
 *
 * ⛔ The arms of this sitting are two lines in the env file, so compose has to be the thing that reads
 * them. Since T27 on 2026-09-17 the gateway's mode is `BEE_GATEWAY_RPC_ENDPOINT` and
 * `BEE_GATEWAY_SWAP_ENABLE` together: an endpoint is what puts the node on a chain, an empty one is
 * the whole of what makes it ultra-light, and swap is what lets a node on a chain pay its peers. A
 * stack reading one of the two cannot produce the light arm, and the contrast would be drawn between
 * two runs of the same node.
 */
function composeFile({ readsSwap = true, readsRpc = true } = {}) {
  return [
    'services:',
    '  bee-gateway:',
    '    command:',
    `      - --blockchain-rpc-endpoint=${readsRpc ? '${BEE_GATEWAY_RPC_ENDPOINT:-}' : ''}`,
    `      - --swap-enable=${readsSwap ? '${BEE_GATEWAY_SWAP_ENABLE:-false}' : 'false'}`,
    '',
  ].join('\n');
}

/** The stack's own chain endpoint, which is the value a light arm points the gateway at. */
const STACK_RPC = 'https://rpc.example.test/v1?key=a&chain=gnosis';

function stubHost({
  availableBzz = 500,
  utilization = 254,
  ttlSeconds = 941760,
  swapEnable = true,
  rpcEndpoint = STACK_RPC,
  gatewayCommandHasRpc = true,
  stackRpcEndpoint = STACK_RPC,
  composeReadsSwap = true,
  composeReadsRpc = true,
  // ⭐ 12 BZZ rather than the 2.4 the other drivers' tests use, because this sitting is far bigger
  // than any of them: two proving arms and four full arms at the defaults is TOTAL_MINUTES=142 and a
  // projection of 3.37 BZZ. A 2.4 BZZ authorisation is genuinely too small for it, so a smaller
  // default here would refuse every case in this file for the right reason and test nothing.
  ceilingPlur = 12n * 10n ** 16n,
}) {
  const out = mkdtempSync(join(tmpdir(), 'phase06-'));
  cleanups.push(() => rmSync(out, { recursive: true, force: true }));
  const bin = join(out, 'bin');
  mkdirSync(bin, { recursive: true });

  const stack = join(out, 'stack');
  mkdirSync(join(stack, 'deploy'), { recursive: true });
  writeFileSync(
    join(stack, 'deploy', 'docker-compose.yml'),
    composeFile({ readsSwap: composeReadsSwap, readsRpc: composeReadsRpc }),
  );
  // The stack's own env file, which is where the light arm's endpoint comes from. `RPC_ENDPOINT` is
  // the key every publisher node in this deployment already reads, and there is no gateway endpoint
  // key in it, because that one is written by an arm and removed again afterwards.
  writeFileSync(
    join(stack, '.env'),
    [
      'STAMP=stamp',
      ...(stackRpcEndpoint === null ? [] : [`RPC_ENDPOINT=${stackRpcEndpoint}`]),
      'BEE_GATEWAY_SWAP_ENABLE=false',
      '',
    ].join('\n'),
  );

  const plur = ((BigInt(Math.round(availableBzz * 1000)) * PLUR_PER_BZZ) / 1000n).toString();
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
        batchTTL: ttlSeconds,
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
} else if (url.includes('/health')) {
  process.stdout.write(JSON.stringify({ activeStreams: 0 }));
}
`,
  );

  // Two different inspects: `-f` reads the uploader environment for the batch id, and the formatted
  // one reads the gateway command the arm flips. Answering both the same way is how a first version
  // of this stub made the script refuse for a reason that had nothing to do with the case.
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === 'inspect' && argv.includes('-f')) {
  process.stdout.write('STAMP=${BATCH}\\n');
} else if (argv[0] === 'inspect') {
  process.stdout.write('CMD=["start"${
    gatewayCommandHasRpc ? `,"--blockchain-rpc-endpoint=${rpcEndpoint}"` : ''
  },"--swap-enable=${swapEnable}"] MOUNTS=/d:/home/bee/.bee PORTS={} NET=host\\n');
}
`,
  );
  for (const name of ['curl', 'docker']) {
    chmodSync(join(bin, name), 0o755);
  }

  // The night's authorisation. Both nodes start where the stub chequebook answers, so a default
  // preflight has spent nothing yet and the ceiling is the only thing left that can refuse it.
  const ledger = join(out, 'spend-ledger.env');
  writeFileSync(
    ledger,
    [
      'authorised_at=2026-08-14T00:00:00Z',
      `ceiling_plur=${ceilingPlur}`,
      // One baseline per node, keyed by port, because the gate reads every node that can
      // spend and refuses one it has no baseline for. These are the ports the driver derives
      // from the default port slot.
      `node_10075_start_plur=${plur}`,
      `node_10077_start_plur=${plur}`,
      '',
    ].join('\n'),
  );

  return { out, bin, ledger, stack };
}

/**
 * ⛔ Both streams are returned, and standard error is the one that matters here. This harness used to
 * keep `failure.code` and the log alone, and the whole of the compose-reads guard's failure was one
 * `require_compose_reads: command not found` line on standard error: a call to a function this script
 * never sources, under `set -u` and no `set -e`, which returns 127 and lets the sitting carry on. The
 * driver passed every case in this file throughout.
 */
async function preflight(options = {}) {
  const host = stubHost(options);

  let code = 0;
  let stdout = '';
  let stderr = '';
  try {
    const ok = await run('bash', [SCRIPT], {
      env: {
        ...process.env,
        PATH: `${host.bin}:${process.env.PATH}`,
        OUT_DIR: host.out,
        STACK_DIR: host.stack,
        SPEND_LEDGER: host.ledger,
        PREFLIGHT_ONLY: '1',
        ...(options.margin === undefined ? {} : { FUNDS_MARGIN_PERCENT: options.margin }),
      },
      encoding: 'utf8',
    });
    ({ stdout, stderr } = ok);
  } catch (failure) {
    code = failure.code;
    ({ stdout, stderr } = failure);
  }
  return { code, stdout, stderr, log: readFileSync(join(host.out, 'phase06.log'), 'utf8') };
}

/** What the preflight said the uploader needs, in BZZ. */
function needed(log) {
  return Number(log.match(/preflight: uploader has [\d.]+ BZZ, needs ([\d.]+)/)[1]);
}

describe('the light-against-ultra-light preflight', () => {
  /**
   * ⛔⛔⛔ THIS REGRESSED ON 2026-08-13, in the commit that moved the burn rate into one file.
   *
   * The margin is doubled here for a reason specific to this sitting: one arm runs on a node with no
   * chequebook at all, so a mid-sitting stop does not cost a run, it costs the contrast the sitting
   * exists to draw. That is written in the header, and the line setting it reads
   * `FUNDS_MARGIN_PERCENT="${FUNDS_MARGIN_PERCENT:-200}"`.
   *
   * ⭐ It sits AFTER `. burn-rates.sh`, which sets the same variable to 140 with its own `:-`. By the
   * time the 200 is reached the variable is already set, so `:-` declines and the sitting quietly ran
   * at the shared default. The comment claiming the doubled margin survived the correction was the
   * only thing that still said 200.
   *
   * The shape generalises past this file: a `:-` default placed after a source that sets the same
   * name is not a default, it is dead code that reads like a decision.
   */
  it('runs at the doubled margin it documents, not the shared default', async () => {
    const { code, log } = await preflight();

    assert.equal(code, 0);
    assert.match(log, /at a 200% margin/);
  });

  it('lets an operator ask for a different margin, since the 200 is a default and not a law', async () => {
    const doubled = await preflight();
    const shared = await preflight({ margin: '100' });

    assert.match(shared.log, /at a 100% margin/);
    // 200 against 100 is exactly twice the requirement, which is what a margin means.
    assert.ok(
      Math.abs(needed(doubled.log) - 2 * needed(shared.log)) < 0.001,
      `the margin does not scale the estimate: ${needed(doubled.log)} against ${needed(shared.log)}`,
    );
  });

  it('refuses when the sitting cannot pay for itself, and changes nothing', async () => {
    const { code, log } = await preflight({ availableBzz: 0 });

    assert.equal(code, 1);
    assert.match(log, /REFUSING TO START: this sitting cannot pay for itself/);
    assert.match(log, /the gateway was never changed/);
  });

  it('refuses when the batch is past its stop line', async () => {
    const { code, log } = await preflight({ utilization: 400 });

    assert.equal(code, 1);
    assert.match(log, /the postage batch cannot carry this sitting/);
  });

  it('reads the batch the uploader is configured with, at the depth that batch really has', async () => {
    const { log } = await preflight();

    // 254 of 512, not of the 256 a depth-24 assumption would have used and called 99% full.
    assert.match(log, /254\/512 buckets \(50%\)/);
  });
});

/**
 * The control this sitting cannot run without.
 *
 * Both arms are written into the stack's env file, so compose has to be the thing that reads them.
 * On a stack that does not, the two arms are the same run, the contrast comes out at zero, and zero
 * reads as the finding "funding makes no difference to a viewer" rather than as a control that is
 * connected to nothing.
 *
 * ⛔ One key is not enough and never was. An empty `--blockchain-rpc-endpoint` is the whole of what
 * makes a node ultra-light and `--swap-enable` takes no part in that decision, so a stack that reads
 * swap alone cannot produce the light arm, and bee refuses to start at all with swap asked for and
 * no chain. The sitting would then spend its wait on a container that never came up.
 */
describe('the arms this driver flips', () => {
  for (const [missing, stack] of [
    ['either key', { composeReadsSwap: false, composeReadsRpc: false }],
    ['the endpoint', { composeReadsRpc: false }],
    ['swap', { composeReadsSwap: false }],
  ]) {
    it(`refuses a stack whose compose does not read ${missing}`, async () => {
      const { code, log } = await preflight(stack);

      assert.equal(code, 1);
      assert.match(log, /REFUSING TO START: .*does not read/);
      assert.match(log, /cannot produce the light arm/);
    });
  }

  it('names the key the stack is missing rather than the pair', async () => {
    const { log } = await preflight({ composeReadsRpc: false });

    assert.match(log, /does not read BEE_GATEWAY_RPC_ENDPOINT[,.]/, log);
  });

  /**
   * The other half of the same question. The endpoint a light gateway is pointed at is the stack's
   * own `RPC_ENDPOINT`, the one its publisher nodes already use, and a stack that names none cannot
   * produce a light arm however well compose reads the keys.
   */
  it('refuses a stack that names no chain endpoint for the light arm to use', async () => {
    const { code, log } = await preflight({ stackRpcEndpoint: null });

    assert.equal(code, 1);
    assert.match(log, /names no RPC_ENDPOINT/);
  });

  /**
   * The gateway it found is the thing it has to put back, and the endpoint is now half of what it
   * puts back. A command with no endpoint flag in it is not the stack this driver was written
   * against, and guessing one would restore the deployment to a mode it was never in.
   */
  it('refuses a gateway whose command carries no endpoint flag to restore', async () => {
    const { code, log } = await preflight({ gatewayCommandHasRpc: false });

    assert.equal(code, 1);
    assert.match(log, /--blockchain-rpc-endpoint/);
    assert.match(log, /not the one this script was written against/);
  });

  it('refuses through its own guard rather than through one it cannot reach', async () => {
    const refused = await preflight({ composeReadsSwap: false });
    const allowed = await preflight();

    for (const run of [refused, allowed]) {
      assert.doesNotMatch(run.stderr, /command not found/, run.stderr);
    }
  });
});

/**
 * ⛔⛔⛔ PR #179 PUT THE CAPACITY GATE IN ALL THREE DRIVERS AND THE SPEND CEILING IN ONE OF THEM.
 *
 * `funds_cover_minutes` asks whether the nodes hold enough to pay, which stays true right down to an
 * empty chequebook, so a driver carrying only that authorises the entire balance. It also cannot see
 * what an earlier sitting the same night already spent. This driver runs six broadcasts and had
 * nothing of the sort in front of it.
 */
describe('the spend ceiling, which this driver did not have', () => {
  it('refuses a sitting that would spend past the authorisation', async () => {
    const { code, log } = await preflight({ ceilingPlur: 10n ** 14n });

    assert.notEqual(code, 0);
    assert.match(log, /REFUSING TO START/);
    assert.match(log, /authorisation/);
  });

  it('passes preflight when the authorisation covers it, so the refusal above is the ceiling', async () => {
    const { code, log } = await preflight();

    assert.equal(code, 0, log);
  });
});
