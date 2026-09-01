import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = join(ROOT, 'deploy/scripts');
const SHARED = join(SCRIPTS, 'capacity-gate.sh');

/**
 * That every sitting checks the batch it is about to publish to, and that the check exists once.
 *
 * ⛔⛔⛔ On 2026-08-13 the gate lived in `viewer-arms.sh` alone. `sweep-interleaved.sh` published
 * without asking about postage at all, and `phase06-light-vs-ultralight.sh` had its own reader that
 * selected `depth == 24 and immutableFlag` from `/stamps`. The measurement batch on the host is
 * **depth 25**, so that filter matched nothing, `max(..., default="")` returned an empty string and
 * the sitting refused with "postage utilization could not be read". A gate stuck closed fails safe
 * and is still not a gate: it never read the batch it was protecting, and the day somebody buys a
 * depth-24 batch it starts gating a sitting on a row that sitting does not write to.
 *
 * ⭐ The rule these tests enforce is that **pricing a sitting and checking it can carry are the same
 * precondition**. A script that knows the minutes well enough to cost them knows them well enough to
 * ask whether the postage lasts, so sourcing `burn-rates.sh` obliges sourcing this too.
 */

const cleanups = [];

after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

/**
 * Every driver that prices a sitting, discovered rather than listed, so a new one cannot opt out.
 *
 * A shebang is what separates a driver from a sourced library: the shared files here carry
 * `# shellcheck shell=bash` instead, precisely because running one on its own does nothing useful.
 * Without that split this picks up `capacity-gate.sh` itself, which names `burn-rates.sh` only to
 * explain the rule it enforces.
 */
function scriptsThatPriceASitting() {
  return readdirSync(SCRIPTS)
    .filter((name) => name.endsWith('.sh'))
    .filter((name) => {
      const body = readFileSync(join(SCRIPTS, name), 'utf8');
      return body.startsWith('#!') && body.includes('burn-rates.sh');
    });
}

describe('the postage capacity gate', () => {
  it('is defined in exactly one file, and no driver carries its own', () => {
    const offenders = [];
    for (const name of readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh') && f !== 'capacity-gate.sh')) {
      const body = readFileSync(join(SCRIPTS, name), 'utf8');
      for (const line of body.split('\n')) {
        if (/^\s*(has_capacity|resolve_stamp|postage_has_room|postage_utilization)\s*\(\)/.test(line)) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `these define their own capacity check instead of sourcing capacity-gate.sh:\n  ${offenders.join('\n  ')}`,
    );
  });

  /**
   * ⛔ The batch is read off the container that is actually publishing, never off a file and never
   * off a shape like "the depth-24 immutable one". `.env.latbench` is gitignored and lives on the
   * host, `/stamps` lists batches of which some are dead, and a batch that gets diluted changes depth
   * under any gate that hardcoded one. The uploader's own environment cannot go stale.
   */
  it('never selects a batch by shape, which is how phase06 came to read no batch at all', () => {
    for (const name of readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh'))) {
      const body = readFileSync(join(SCRIPTS, name), 'utf8');
      const selectsByDepth = body
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .filter((line) => /\["depth"\]\s*==|\.depth\s*==/.test(line));
      assert.deepEqual(selectsByDepth, [], `${name} picks a postage batch by depth rather than by id`);
    }
  });

  it('is sourced by every script that prices a sitting', () => {
    const priced = scriptsThatPriceASitting();
    assert.ok(priced.length >= 3, 'the discovery found fewer drivers than this repo has');

    for (const name of priced) {
      const body = readFileSync(join(SCRIPTS, name), 'utf8');
      assert.match(body, /capacity-gate\.sh/, `${name} prices a sitting it never checks the postage for`);
    }
  });

  it('names the missing file rather than dying on an unbound variable later', () => {
    for (const name of scriptsThatPriceASitting()) {
      const lines = readFileSync(join(SCRIPTS, name), 'utf8').split('\n');
      const at = lines.findIndex((l) => /^GATES=.*capacity-gate\.sh"$/.test(l.trim()));
      assert.ok(at >= 0, `${name} does not resolve a path to capacity-gate.sh`);

      const guard = lines.slice(at, at + 8).join('\n');
      assert.match(guard, /^\. "\$\{GATES\}" \|\|/m, `${name} sources the gate without handling it being absent`);
      assert.match(guard, /exit 1/, `${name} continues after failing to read the gate it publishes behind`);
    }
  });
});

/**
 * The contract the shared file has with its callers, enforced at the moment of sourcing.
 *
 * ⛔ These scripts run `set -u` without `set -e`. A gate that quietly did nothing because its caller
 * had not set `LOG` yet would let the sitting publish, which is the failure this whole file exists to
 * prevent. So an incomplete caller is refused where the mistake is, not four hundred lines later.
 */
describe('the shared gate refuses a caller that cannot use it', () => {
  async function sourceWith(preamble) {
    let code = 0;
    let stderr = '';
    try {
      await run('bash', ['-c', `set -u\n${preamble}\n. "${SHARED}"\necho SOURCED`], { encoding: 'utf8' });
    } catch (failure) {
      code = failure.code;
      stderr = failure.stderr;
    }
    return { code, stderr };
  }

  const COMPLETE = 'say() { :; }\nLOG=/dev/null\nUPLOADER_BEE_PORT=10075';

  it('sources cleanly when the caller has everything it needs', async () => {
    const { code } = await sourceWith(COMPLETE);
    assert.equal(code, 0);
  });

  it('refuses a caller with no say(), so a refusal cannot land somewhere nobody reads', async () => {
    const { code, stderr } = await sourceWith('LOG=/dev/null\nUPLOADER_BEE_PORT=10075');

    assert.notEqual(code, 0);
    assert.match(stderr, /say\(\)/);
  });

  it('refuses a caller with no log to refuse into', async () => {
    const { code, stderr } = await sourceWith('say() { :; }\nUPLOADER_BEE_PORT=10075');

    assert.notEqual(code, 0);
    assert.match(stderr, /LOG/);
  });

  it('refuses a caller that has not said which node to read /stamps from', async () => {
    const { code, stderr } = await sourceWith('say() { :; }\nLOG=/dev/null');

    assert.notEqual(code, 0);
    assert.match(stderr, /UPLOADER_BEE_PORT/);
  });
});

/**
 * What the gate does once a caller has it, driven through the real file against a stub node.
 *
 * `viewerArms.test.js` proves the refusals reach a sitting. These prove the unit itself, so the next
 * driver to source it inherits tested behaviour rather than a hope that its own wiring is right.
 */
describe('the shared gate reads the batch the uploader is publishing with', () => {
  /** Synthetic. A live batch id in a committed fixture is a stamp anyone can spend against. */
  const BATCH = 'a'.repeat(64);

  /** Depth 25 on purpose: 512 buckets, which is what the measurement batch became when it was diluted. */
  function stubNode({ utilization = 254, ttlSeconds = 941760, usable = true, uploaderEnv = `STAMP=${BATCH}\n` }) {
    const dir = mkdtempSync(join(tmpdir(), 'capacity-gate-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });

    const stamps = {
      stamps: [
        {
          batchID: BATCH,
          utilization,
          usable,
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
if (url.includes('/stamps')) process.stdout.write(${JSON.stringify(JSON.stringify(stamps))});
`,
    );
    writeFileSync(
      join(bin, 'docker'),
      `#!/usr/bin/env node
if (process.argv[2] === 'inspect') process.stdout.write(${JSON.stringify(uploaderEnv)});
`,
    );
    for (const name of ['curl', 'docker']) {
      chmodSync(join(bin, name), 0o755);
    }
    return { dir, bin };
  }

  async function checkCapacity(node, minutes = 60) {
    const log = join(node.dir, 'gate.log');
    writeFileSync(log, '');
    const preamble = [
      `say() { printf '%s\\n' "$*" >> "${log}"; }`,
      `LOG="${log}"`,
      'UPLOADER_BEE_PORT=10075',
      `. "${SHARED}"`,
      `has_capacity ${minutes}`,
    ].join('\n');

    let code = 0;
    try {
      await run('bash', ['-c', `set -u\n${preamble}`], {
        env: { ...process.env, PATH: `${node.bin}:${process.env.PATH}` },
        encoding: 'utf8',
      });
    } catch (failure) {
      code = failure.code;
    }
    return { code, log: readFileSync(log, 'utf8') };
  }

  it('passes a healthy batch with room for the sitting', async () => {
    const { code } = await checkCapacity(stubNode({}));

    assert.equal(code, 0);
  });

  it('refuses a batch past its stop line', async () => {
    // 400 of 512 buckets is 78%, past the written 75%.
    const { code, log } = await checkCapacity(stubNode({ utilization: 400 }));

    assert.equal(code, 1);
    assert.match(log, /REFUSING/);
  });

  it('refuses a batch about to lapse', async () => {
    const { code } = await checkCapacity(stubNode({ ttlSeconds: 3600 }));

    assert.equal(code, 1);
  });

  /**
   * ⛔ 254 of a depth-25 batch's 512 buckets is 50% and fine. Read against the 256 that phase06
   * hardcoded for depth 24 it is 99% and refuses. The denominator has to come from the batch.
   */
  it('measures utilization against the batch depth rather than an assumed one', async () => {
    const { code, log } = await checkCapacity(stubNode({ utilization: 254 }));

    assert.equal(code, 0);
    assert.match(log, /254\/512/);
  });

  it('refuses when the uploader will not say which batch it is using', async () => {
    const { code, log } = await checkCapacity(stubNode({ uploaderEnv: 'LOG_LEVEL=debug\n' }));

    assert.equal(code, 1);
    assert.match(log, /could not read STAMP/);
  });

  /**
   * ⛔⛔ That the printed stop line is also the enforced one, for the length of sitting being asked
   * for.
   *
   * The guard used to refuse only a batch ALREADY at the line, or a sitting needing more than the
   * absolute buckets left. On 2026-08-16 the live batch sat at 369/512, the guard reported "headroom
   * to the 75% stop line: 2.3 broadcast hours", and then returned 0 for a 180-minute sitting, because
   * 19.2 buckets is comfortably inside the 143 that remained. The mid-flight sampler would have
   * stopped that sitting at about 2.3 hours, so roughly 42 minutes of booked and paid broadcast would
   * have produced an arm that never completed.
   *
   * That is not an overrun, the floor check does hold. It is a sitting that could have been refused
   * before it was paid for.
   */
  it('refuses a sitting that would END past the stop line, while buckets still remain', async () => {
    // 369 of 512 is 72%. Three hours costs 19.2 buckets, landing at 388 of 512, which is 76%.
    // 143 buckets are still free, so the absolute-capacity refusal alone would have let this run.
    const { code, log } = await checkCapacity(stubNode({ utilization: 369 }), 180);

    assert.equal(code, 1);
    assert.match(log, /REFUSING/);
    assert.match(log, /past the 75% stop line/);
  });

  it('allows the same batch a sitting that finishes inside the stop line', async () => {
    // One hour costs 6.4 buckets, landing at 375 of 512, which is 73%.
    const { code } = await checkCapacity(stubNode({ utilization: 369 }), 60);

    assert.equal(code, 0);
  });

  it('names where the sitting would end, so the length can be chosen rather than guessed', async () => {
    const { log } = await checkCapacity(stubNode({ utilization: 369 }), 60);

    assert.match(log, /ending at 73%/);
  });
});

/**
 * ⛔⛔⛔ **The same failure this file was written for, one level up.** The gate read STAMP, which after
 * the per-rung split names only the fallback node, so it checked one batch of four. Across the shipped
 * ladder 1080p burns roughly seven times the bytes of 360p, which makes the batch most likely to run
 * out mid-sitting precisely the one the gate would never have read. A gate that reads a row the
 * sitting does not write to is the defect, whether the row is chosen by shape or by being the only one
 * anybody looked at.
 */
describe('the shared gate reads every batch a split deployment publishes with', () => {
  const BATCH_360 = 'aa49851f404265dd2bea17e4229b45be23e245210ea17ac0af3a2a2b13faa2fd';
  const BATCH_1080 = 'bb49851f404265dd2bea17e4229b45be23e245210ea17ac0af3a2a2b13faa2fd';
  const HEALTHY = { utilization: 254, ttlSeconds: 941760 };

  /** One stub node per port, so a gate that reads only one of them is visibly reading only one. */
  function stubSplit({ perPort, publishers }) {
    const dir = mkdtempSync(join(tmpdir(), 'capacity-gate-split-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });

    const byPort = Object.fromEntries(
      Object.entries(perPort).map(([port, batch]) => [
        port,
        {
          stamps: [
            {
              batchID: batch.batchID,
              utilization: batch.utilization,
              usable: true,
              label: 'stub',
              depth: 25,
              amount: '36043833600',
              bucketDepth: 16,
              immutableFlag: true,
              exists: true,
              batchTTL: batch.ttlSeconds,
            },
          ],
        },
      ]),
    );

    writeFileSync(
      join(bin, 'curl'),
      `#!/usr/bin/env node
const byPort = ${JSON.stringify(JSON.stringify(byPort))};
const url = process.argv.slice(2).find((a) => a.startsWith('http')) || '';
const port = (url.match(/:(\\d+)\\//) || [])[1];
const table = JSON.parse(byPort);
if (url.includes('/stamps') && table[port]) process.stdout.write(JSON.stringify(table[port]));
`,
    );
    writeFileSync(
      join(bin, 'docker'),
      `#!/usr/bin/env node
if (process.argv[2] === 'inspect') process.stdout.write(${JSON.stringify(
        `STAMP=${BATCH_360}\nBEE_PUBLISHERS=${''}`,
      )} + ${JSON.stringify(publishers)} + '\\n');
`,
    );
    for (const name of ['curl', 'docker']) {
      chmodSync(join(bin, name), 0o755);
    }
    return { dir, bin };
  }

  async function checkSplit(node, minutes = 60) {
    const log = join(node.dir, 'gate.log');
    writeFileSync(log, '');
    const preamble = [
      `say() { printf '%s\\n' "$*" >> "${log}"; }`,
      `LOG="${log}"`,
      'UPLOADER_BEE_PORT=10075',
      `. "${SHARED}"`,
      `has_capacity ${minutes}`,
    ].join('\n');

    let code = 0;
    try {
      await run('bash', ['-c', `set -u\n${preamble}`], {
        env: { ...process.env, PATH: `${node.bin}:${process.env.PATH}`, BEE_PUBLISHERS: '' },
        encoding: 'utf8',
      });
    } catch (failure) {
      code = failure.code;
    }
    return { code, log: readFileSync(log, 'utf8') };
  }

  const twoRungs = `360p@http://127.0.0.1:10075<${BATCH_360}> ` + `1080p@http://127.0.0.1:11075<${BATCH_1080}>`;

  it('checks the batch on every node, not only the one STAMP names', async () => {
    const { code, log } = await checkSplit(
      stubSplit({
        perPort: { 10075: { batchID: BATCH_360, ...HEALTHY }, 11075: { batchID: BATCH_1080, ...HEALTHY } },
        publishers: twoRungs,
      }),
    );

    assert.equal(code, 0);
    assert.match(log, new RegExp(BATCH_360.slice(0, 8)), 'the 360p batch was never read');
    assert.match(log, new RegExp(BATCH_1080.slice(0, 8)), 'the 1080p batch was never read');
  });

  /** The case that matters: the rung in trouble is not the one the old gate looked at. */
  it('refuses when the rung that cannot carry the sitting is not the one STAMP names', async () => {
    const { code, log } = await checkSplit(
      stubSplit({
        perPort: {
          10075: { batchID: BATCH_360, ...HEALTHY },
          11075: { batchID: BATCH_1080, utilization: 500, ttlSeconds: 941760 },
        },
        publishers: twoRungs,
      }),
    );

    assert.equal(code, 1);
    assert.match(log, /REFUSING/);
    assert.match(log, /1080p/);
  });

  it('names every rung that cannot carry it rather than stopping at the first', async () => {
    const { code, log } = await checkSplit(
      stubSplit({
        perPort: {
          10075: { batchID: BATCH_360, utilization: 500, ttlSeconds: 941760 },
          11075: { batchID: BATCH_1080, utilization: 500, ttlSeconds: 941760 },
        },
        publishers: twoRungs,
      }),
    );

    assert.equal(code, 1);
    assert.match(log, /360p/);
    assert.match(log, /1080p/);
  });

  it('refuses a publisher entry whose url carries no port, rather than dialing something else', async () => {
    const { code, log } = await checkSplit(
      stubSplit({
        perPort: { 10075: { batchID: BATCH_360, ...HEALTHY } },
        publishers: `360p@http://bee-uploader<${BATCH_360}>`,
      }),
    );

    assert.equal(code, 1);
    assert.match(log, /names no port/);
  });

  it('refuses a truncated batch id rather than reading /stamps with it', async () => {
    const { code, log } = await checkSplit(
      stubSplit({
        perPort: { 10075: { batchID: BATCH_360, ...HEALTHY } },
        publishers: `360p@http://127.0.0.1:10075<${BATCH_360.slice(0, 40)}>`,
      }),
    );

    assert.equal(code, 1);
    assert.match(log, /truncated paste/);
  });

  /** The unsplit deployment is still a deployment, and the rewrite must not have cost it its gate. */
  it('falls back to the STAMP batch when BEE_PUBLISHERS is unset', async () => {
    const { code, log } = await checkSplit(
      stubSplit({ perPort: { 10075: { batchID: BATCH_360, ...HEALTHY } }, publishers: '' }),
    );

    assert.equal(code, 0);
    assert.match(log, new RegExp(BATCH_360.slice(0, 8)));
  });
});
