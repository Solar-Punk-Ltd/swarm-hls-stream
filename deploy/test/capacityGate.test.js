import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** Every driver that prices a sitting, discovered rather than listed, so a new one cannot opt out. */
function scriptsThatPriceASitting() {
  return readdirSync(SCRIPTS)
    .filter((name) => name.endsWith('.sh'))
    .filter((name) => readFileSync(join(SCRIPTS, name), 'utf8').includes('burn-rates.sh'))
    .filter((name) => name !== 'burn-rates.sh');
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
  const BATCH = '7849851f404265dd2bea17e4229b45be23e245210ea17ac0af3a2a2b13faa2fd';

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
});
