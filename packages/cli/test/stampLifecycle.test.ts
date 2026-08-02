import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { stampSetup } from '../src/commands/stamp-setup.js';
import { buyStamp } from '../src/lib/stamp.js';
import { waitForNode, waitForStamp } from '../src/lib/wait.js';

import { createFakeBee, TEST_BATCH } from './helpers/fakeBee.js';

// Fast enough to run in milliseconds, structured exactly like the real 3s poll over a 5 minute
// window. Only the clock is compressed.
const POLL_MS = 2;
const TIMEOUT_MS = 500;

const workspaces: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-lifecycle-'));
  workspaces.push(dir);
  return dir;
}

after(() => {
  for (const dir of workspaces) {
    try {
      chmodSync(dir, 0o700);
      for (const entry of readdirSync(dir)) {
        chmodSync(join(dir, entry), 0o600);
      }
    } catch {
      // Already writable, or already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function silence<T>(body: () => Promise<T>): Promise<T> {
  const sinks = ['log', 'info', 'warn', 'error'] as const;
  const originals = sinks.map((name) => [name, console[name]] as const);
  for (const name of sinks) {
    console[name] = () => {};
  }
  return body().finally(() => {
    for (const [name, fn] of originals) {
      console[name] = fn;
    }
  });
}

describe('the real wait loop against a node that behaves like a real one', () => {
  it('survives the window where the node has not indexed the batch yet', async () => {
    // A real node throws on getPostageBatch for a while after the transaction lands, because it has
    // not indexed the batch. The loop swallows that on purpose. A fake that returns a usable batch
    // immediately never exercises the branch, which is why this models the stages explicitly.
    const fake = createFakeBee({ notFoundPolls: 3, unusablePolls: 2 });

    const batch = await silence(() => waitForStamp(fake.bee, 'ignored', TIMEOUT_MS, POLL_MS));

    assert.equal(batch.usable, true);
    assert.ok(fake.pollCount() > 5, `must have polled through both stages, polled ${fake.pollCount()}`);
  });

  it('retries while the node is still starting up', async () => {
    // waitForNode's retry loop was never driven: the fake's health check always answered on the
    // first call, so its tolerance and its poll interval were unpinned.
    const fake = createFakeBee({ unhealthyPolls: 3 });

    await silence(() => waitForNode(fake.bee, TIMEOUT_MS, POLL_MS));

    assert.ok(fake.healthPolls() > 3, `must have retried past the unhealthy window, polled ${fake.healthPolls()}`);
  });

  it('throws when the batch never becomes usable, which is the common slow-chain failure', async () => {
    const fake = createFakeBee({ neverUsable: true });

    await assert.rejects(
      () => silence(() => waitForStamp(fake.bee, 'ignored', 50, POLL_MS)),
      /did not become usable/,
      'a batch that never propagates has to fail loudly, the money is already spent',
    );
  });
});

describe('stamp:setup end to end, real purchase and wait helpers, faked network only', () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = workspace();
    envPath = join(dir, '.env');
  });

  // The Bee client is a stand-in, `exit` throws instead of ending the process, and `envPath` points
  // at a temp directory. Everything else is real: buyStamp, waitForNode, waitForStamp,
  // recordBatchId, assertEnvKeyWritable and writeEnvKey, so this exercises the ordering the whole
  // change is about against the sequence a real node actually produces. Note the compressed clock
  // is more permissive than production, 250 iterations against 100, not equivalent to it.
  function realSeams(fake: ReturnType<typeof createFakeBee>) {
    return {
      createBee: () => fake.bee,
      confirm: async () => true,
      buyStamp,
      waitForNode: (bee: Parameters<typeof waitForNode>[0]) => waitForNode(bee, TIMEOUT_MS, POLL_MS),
      waitForStamp: (bee: Parameters<typeof waitForStamp>[0], id: string) => waitForStamp(bee, id, TIMEOUT_MS, POLL_MS),
      envPath,
      exit: (code: number): never => {
        throw new Error(`exit(${code})`);
      },
    };
  }

  it('buys once and records the id, through the full not-found then unusable then usable sequence', async () => {
    const fake = createFakeBee({ notFoundPolls: 3, unusablePolls: 3 });

    await silence(() => stampSetup({ ...TEST_BATCH }, realSeams(fake)));

    assert.equal(fake.purchaseCount(), 1, 'exactly one batch may be bought');
    assert.match(readFileSync(envPath, 'utf-8'), new RegExp(`^STAMP=${fake.purchased()}$`, 'm'));

    // The premise the whole lifecycle model rests on, and nothing pinned it. With waitForUsable
    // left at its default, bee-js blocks inside createPostageBatch for up to four minutes and then
    // throws, so buyStamp never returns, the id is never recorded, and OPS-1 is back with the
    // money spent.
    assert.equal(
      fake.purchaseOptions()?.waitForUsable,
      false,
      'buyStamp must return as soon as the id is known, and let waitForStamp own the waiting',
    );
  });

  it('keeps the id when the batch never becomes usable', async () => {
    // The failure this change exists to survive, now driven through the real wait loop rather than
    // a stub that throws immediately. The money is spent, the batch is real, it is just not ready.
    const fake = createFakeBee({ neverUsable: true });

    await assert.rejects(
      () =>
        silence(() =>
          stampSetup(
            { ...TEST_BATCH },
            {
              ...realSeams(fake),
              waitForStamp: (bee, id: string) => waitForStamp(bee, id, 50, POLL_MS),
            },
          ),
        ),
      /exit\(1\)/,
    );

    assert.equal(fake.purchaseCount(), 1);
    assert.match(
      readFileSync(envPath, 'utf-8'),
      new RegExp(`^STAMP=${fake.purchased()}$`, 'm'),
      'a batch that never became usable is still a batch that was paid for',
    );
  });

  it('does not write a STAMP when the transaction itself fails', async () => {
    // Rejected before submission, so nothing was spent and there is no id. Writing an empty STAMP
    // here would poison the operator's config.
    const fake = createFakeBee({ purchaseError: 'insufficient funds for gas * price + value' });

    await assert.rejects(() => silence(() => stampSetup({ ...TEST_BATCH }, realSeams(fake))), /exit\(1\)/);

    assert.equal(fake.purchaseCount(), 1, 'the failure must be the purchase itself, not an earlier refusal');
    assert.equal(existsSync(envPath), false, 'a failed transaction must leave no STAMP behind');
  });

  it('reuses a batch the node already holds instead of buying a second one', async () => {
    const existing = 'ee'.repeat(32);
    const fake = createFakeBee({ existingBatches: [{ batchID: existing, usable: true }] });

    await silence(() => stampSetup({ ...TEST_BATCH }, realSeams(fake)));

    assert.equal(fake.purchaseCount(), 0, 'a usable batch already exists, buying another wastes money');
    assert.match(readFileSync(envPath, 'utf-8'), new RegExp(`^STAMP=${existing}$`, 'm'));
  });
});
