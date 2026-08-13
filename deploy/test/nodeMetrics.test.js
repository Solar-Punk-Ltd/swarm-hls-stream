import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const METRICS = join(ROOT, 'deploy/scripts/node_metrics.py');
const PLUR_PER_BZZ = 10n ** 16n;

/**
 * That the nodes' own account of a run is differenced rather than read once, and that reading it
 * mid-run can stop the run.
 *
 * ⛔ Every metric worth having here is a monotonic lifetime total. The uploader's lifetime mean
 * push-sync is 13.4ms over 2.25 million chunks, and quoting that as a thirty-minute sitting's figure
 * is the mistake these tests exist to prevent. One reading says nothing; two differenced say exactly
 * what happened between them.
 */

const cleanups = [];

after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'node-metrics-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function bzz(amount) {
  return ((BigInt(Math.round(amount * 10000)) * PLUR_PER_BZZ) / 10000n).toString();
}

const IN_USE = 'a'.repeat(64);
/** The dead depth-22 batch this deployment really carries: mutable, 50 of 64 buckets, abandoned. */
const ABANDONED = 'b'.repeat(64);

function snapshot({
  atMs = 0,
  uploader = {},
  gateway = {},
  uploaderBzz = 9.7,
  gatewayBzz = 8.0,
  utilization = 199,
  depth = 25,
  ttlSeconds = 981972,
  health = {},
  extraBatches = [],
} = {}) {
  return {
    label: 'stub',
    atMs,
    hostLoad: '1.00 1.00 1.00',
    uploader,
    gateway,
    stamps: {
      stamps: [
        {
          batchID: IN_USE,
          utilization,
          usable: true,
          depth,
          bucketDepth: 16,
          immutableFlag: true,
          batchTTL: ttlSeconds,
        },
        ...extraBatches,
      ],
    },
    uploaderHealth: health,
    chequebook: {
      uploader: { availableBalance: bzz(uploaderBzz) },
      gateway: { availableBalance: bzz(gatewayBzz) },
    },
  };
}

async function floors(snap, { reservePlur = '5000000000000000', maxPct = '75', batch = IN_USE } = {}) {
  const dir = workspace();
  const path = join(dir, 'snapshot.json');
  writeFileSync(path, JSON.stringify(snap));
  try {
    const { stdout } = await run('python3', [METRICS, 'floors', path, reservePlur, maxPct, batch], {
      encoding: 'utf8',
    });
    return { crossed: false, reasons: stdout.split('\n').filter(Boolean) };
  } catch (failure) {
    return { crossed: true, reasons: failure.stdout.split('\n').filter(Boolean) };
  }
}

async function diff(before, after) {
  const dir = workspace();
  const beforePath = join(dir, 'before.json');
  const afterPath = join(dir, 'after.json');
  writeFileSync(beforePath, JSON.stringify(before));
  writeFileSync(afterPath, JSON.stringify(after));
  const { stdout } = await run('python3', [METRICS, 'diff', beforePath, afterPath], { encoding: 'utf8' });
  return stdout;
}

describe('the floors that stop a sitting mid-flight', () => {
  it('lets a healthy pair of nodes carry on', async () => {
    const { crossed } = await floors(snapshot());

    assert.equal(crossed, false);
  });

  /**
   * ⛔ The reason this is read during a run and not only at its ends. A single continuous arm is
   * checked for funding once, at minute zero, so a four-hour broadcast that empties its chequebook at
   * hour three spends its last hour measuring what peers do to a node that cannot pay, and files it
   * as a result about the network.
   */
  it('stops when the uploader drops under its reserve', async () => {
    const { crossed, reasons } = await floors(snapshot({ uploaderBzz: 0.4 }));

    assert.equal(crossed, true);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /uploader available 0\.4000 BZZ is under the 0\.50 reserve/);
  });

  /** The gateway pays for retrieval and is the node nobody watches. It has bound first before. */
  it('stops when the gateway drops under its reserve', async () => {
    const { crossed, reasons } = await floors(snapshot({ gatewayBzz: 0.1 }));

    assert.equal(crossed, true);
    assert.match(reasons[0], /gateway available/);
  });

  it('stops when a node stops answering, because unknown is not the same as fine', async () => {
    const blind = snapshot();
    blind.chequebook.gateway = {};

    const { crossed, reasons } = await floors(blind);

    assert.equal(crossed, true);
    assert.match(reasons[0], /gateway chequebook stopped answering/);
  });

  /**
   * `utilization` is the FULLEST bucket, not the average, so a batch is effectively full long before
   * its nominal chunk count. A depth-25 batch has 512 buckets and 384 of them is the written line.
   */
  it('stops at the postage line, counted in buckets and not in chunks', async () => {
    const { crossed, reasons } = await floors(snapshot({ utilization: 384 }));

    assert.equal(crossed, true);
    assert.match(reasons[0], /75% full, at the 75% stop line/);
  });

  it('does not stop just below the line', async () => {
    const { crossed } = await floors(snapshot({ utilization: 383 }));

    assert.equal(crossed, false);
  });

  /**
   * ⛔⛔ This stopped a night seventeen seconds after it launched, on 2026-08-12.
   *
   * `/stamps` lists every batch the node has ever bought, and this deployment carries four of which
   * three are dead. `46ad3454` is a mutable depth-22 batch abandoned on 2026-08-04 at 50 of 64
   * buckets, which is 78% and will never come down. The batch actually in use was at 39%.
   *
   * A floor that reads every row is not stricter, it is wrong: it stops on a number that describes
   * something the sitting does not write to and can never fix.
   */
  it('judges only the batch the sitting writes to, not every batch the node ever bought', async () => {
    const withDeadBatch = snapshot({
      utilization: 199,
      extraBatches: [
        {
          batchID: ABANDONED,
          utilization: 50,
          usable: true,
          depth: 22,
          bucketDepth: 16,
          immutableFlag: false,
          batchTTL: 479569,
        },
      ],
    });

    const { crossed } = await floors(withDeadBatch);

    assert.equal(crossed, false, 'a dead batch at 78% stopped a sitting writing to one at 39%');
  });

  it('still stops when the batch in use is the full one', async () => {
    const { crossed, reasons } = await floors(snapshot({ utilization: 400 }));

    assert.equal(crossed, true);
    assert.match(reasons[0], /^batch aaaaaaaa is 78% full/);
  });

  /** Unknown capacity is not permission to spend against it, the same rule the door gate applies. */
  it('stops when nobody said which batch the sitting writes to', async () => {
    const { crossed, reasons } = await floors(snapshot(), { batch: '' });

    assert.equal(crossed, true);
    assert.match(reasons[0], /was not named/);
  });

  it('stops when the named batch is not on the node at all', async () => {
    const { crossed, reasons } = await floors(snapshot(), { batch: 'c'.repeat(64) });

    assert.equal(crossed, true);
    assert.match(reasons[0], /cccccccc is not on the node, which lists aaaaaaaa/);
  });

  it('names every reason at once, so a fix for one does not reveal the next on the next run', async () => {
    const { reasons } = await floors(snapshot({ uploaderBzz: 0.1, gatewayBzz: 0.1, utilization: 400 }));

    assert.equal(reasons.length, 3);
  });
});

describe('what the nodes say they did, over one window and not over their lives', () => {
  /**
   * ⛔ The defect this shape prevents. `bee_pusher_sync_time_sum/count` is a lifetime pair, and the
   * uploader's lifetime mean is 13.4ms over 2.25 million chunks. A sitting that pushed 100 chunks
   * slowly would still report ~13.4ms if either reading were taken alone.
   */
  it('reports the mean over the window, not the mean over the node lifetime', async () => {
    const before = snapshot({
      atMs: 0,
      uploader: { bee_pusher_sync_time_sum: 30150, bee_pusher_sync_time_count: 2250000 },
    });
    const after = snapshot({
      atMs: 600000,
      uploader: { bee_pusher_sync_time_sum: 30250, bee_pusher_sync_time_count: 2250100 },
    });

    const out = await diff(before, after);

    // 100 chunks took 100 seconds between the readings, so 1000ms each, against a 13.4ms lifetime.
    assert.match(out, /mean push-sync time\s+1000\.0 ms/);
    assert.doesNotMatch(out, /13\.4 ms/);
  });

  it('reports a dash rather than a zero when nothing happened in the window', async () => {
    const out = await diff(snapshot({ atMs: 0 }), snapshot({ atMs: 600000 }));

    assert.match(out, /mean push-sync time\s+—/);
  });

  it('prices the window in BZZ per broadcast hour, which is what a sitting is planned in', async () => {
    const out = await diff(snapshot({ atMs: 0, uploaderBzz: 10 }), snapshot({ atMs: 1800000, uploaderBzz: 9.5 }));

    assert.match(out, /uploader spent\s+0\.5000 BZZ\s+1\.00 BZZ per broadcast hour/);
  });

  it('shows the batch moving, since a sitting is paid for in buckets as well as in BZZ', async () => {
    const out = await diff(snapshot({ utilization: 199 }), snapshot({ utilization: 245 }));

    assert.match(out, /199 -> 245 of 512 \(48%\)/);
  });

  it('carries the uploader own count of what it dropped', async () => {
    const out = await diff(
      snapshot({ health: { segmentsSkipped: 0, segmentsNeverNamed: 0 } }),
      snapshot({ health: { segmentsSkipped: 4, segmentsNeverNamed: 1 } }),
    );

    assert.match(out, /uploader segmentsSkipped\s+0 -> 4/);
    assert.match(out, /uploader segmentsNeverNamed\s+0 -> 1/);
  });
});
