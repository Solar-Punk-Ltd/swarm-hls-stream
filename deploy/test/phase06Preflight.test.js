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
const BATCH = '7849851f404265dd2bea17e4229b45be23e245210ea17ac0af3a2a2b13faa2fd';

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

function stubHost({
  availableBzz = 500,
  utilization = 254,
  ttlSeconds = 941760,
  swapEnable = true,
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
  process.stdout.write('CMD=["start","--swap-enable=${swapEnable}"] MOUNTS=/d:/home/bee/.bee PORTS={} NET=host\\n');
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

  return { out, bin, ledger };
}

async function preflight(options = {}) {
  const host = stubHost(options);

  let code = 0;
  try {
    await run('bash', [SCRIPT], {
      env: {
        ...process.env,
        PATH: `${host.bin}:${process.env.PATH}`,
        OUT_DIR: host.out,
        SPEND_LEDGER: host.ledger,
        PREFLIGHT_ONLY: '1',
        ...(options.margin === undefined ? {} : { FUNDS_MARGIN_PERCENT: options.margin }),
      },
      encoding: 'utf8',
    });
  } catch (failure) {
    code = failure.code;
  }
  return { code, log: readFileSync(join(host.out, 'phase06.log'), 'utf8') };
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
