import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PostageGate, StampedPublisher } from '../src/libs/PostageGate.js';

const MIN_TTL_S = 24 * 3_600;
const MAX_UTILIZATION = 0.9;

/** A batch as bee answers for one, with the fields the gate narrows. */
function batch(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    batchID: 'a'.repeat(64),
    exists: true,
    usable: true,
    batchTTL: 7 * 24 * 3_600,
    utilizationRatio: 0.1,
    depth: 24,
    ...over,
  };
}

interface Reads {
  /** One entry per call, so a batch checked twice is visible rather than merely suspected. */
  readonly asked: string[];
}

function publisher(rung: string, url: string, stamp: string, answer: unknown | (() => never), reads: Reads) {
  return {
    rung,
    url,
    stamp,
    bee: {
      getPostageBatch: async (batchId: string): Promise<unknown> => {
        reads.asked.push(`${url} ${batchId}`);
        if (typeof answer === 'function') {
          (answer as () => never)();
        }
        return answer;
      },
    },
  } satisfies StampedPublisher;
}

const silent = { info: () => {} };

async function refusalFrom(publishers: readonly StampedPublisher[]): Promise<string> {
  try {
    await new PostageGate(publishers, MIN_TTL_S, MAX_UTILIZATION, silent).assertUsable();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail('the gate passed where it should have refused');
}

/**
 * ⛔⛔⛔ **A batch id being well formed says nothing about the batch.** `BeePublisherPool` already
 * refuses an id that is malformed, missing, or does not cover the ladder. Nothing asked whether the
 * batch it names can still carry anything, and a batch has two ways to stop being able to while its
 * id stays perfectly valid: it fills, or it expires. Both arrive as a failed upload mid-broadcast
 * rather than as anything an operator saw coming.
 *
 * Found 2026-08-31 when the owner asked what the new per-rung nodes would need. The shipped latbench
 * batch was measured that same hour at **90.6% used**, immutable, with nothing anywhere reading it.
 */
describe('PostageGate', () => {
  it('clears a batch with room and time left', async () => {
    const reads: Reads = { asked: [] };
    await new PostageGate(
      [publisher('360p', 'http://a:1633', 'a'.repeat(64), batch(), reads)],
      MIN_TTL_S,
      MAX_UTILIZATION,
      silent,
    ).assertUsable();

    assert.deepEqual(reads.asked, ['http://a:1633 ' + 'a'.repeat(64)]);
  });

  /** The reading that prompted this gate, refused by it. */
  it('refuses the batch that was actually deployed at 90.6% used', async () => {
    const reads: Reads = { asked: [] };
    const message = await refusalFrom([
      publisher('360p', 'http://a:1633', 'a'.repeat(64), batch({ utilizationRatio: 0.90625 }), reads),
    ]);

    assert.match(message, /90\.6% used/);
    assert.match(message, /ceiling is 90\.0%/);
    assert.match(message, /Dilute it/);
  });

  it('clears a batch that is full to the ceiling but no fuller', async () => {
    const reads: Reads = { asked: [] };
    await new PostageGate(
      [publisher('360p', 'http://a:1633', 'a'.repeat(64), batch({ utilizationRatio: MAX_UTILIZATION }), reads)],
      MIN_TTL_S,
      MAX_UTILIZATION,
      silent,
    ).assertUsable();
  });

  it('refuses a batch that expires before the floor', async () => {
    const reads: Reads = { asked: [] };
    const message = await refusalFrom([
      publisher('720p', 'http://b:1633', 'b'.repeat(64), batch({ batchTTL: MIN_TTL_S - 1 }), reads),
    ]);

    assert.match(message, /24\.0h left/);
    assert.match(message, /floor is 24\.0h/);
  });

  it('refuses a batch the node says it cannot spend', async () => {
    const reads: Reads = { asked: [] };
    const message = await refusalFrom([
      publisher('480p', 'http://c:1633', 'c'.repeat(64), batch({ usable: false }), reads),
    ]);

    assert.match(message, /usable=false/);
  });

  it('refuses a batch the node does not hold', async () => {
    const reads: Reads = { asked: [] };
    const message = await refusalFrom([
      publisher('480p', 'http://c:1633', 'c'.repeat(64), batch({ exists: false }), reads),
    ]);

    assert.match(message, /exists=false/);
  });

  /**
   * ⛔⛔⛔ Absence is a refusal rather than a default, and this is the case the whole file turns on.
   * A batch whose TTL is missing is not a batch with plenty of time. Reading it as one would pass
   * every unreadable answer, which is the exact failure the gate exists to stop.
   */
  it('refuses an answer it cannot read rather than treating a missing field as healthy', async () => {
    const reads: Reads = { asked: [] };
    const message = await refusalFrom([
      publisher('1080p', 'http://d:1633', 'd'.repeat(64), batch({ batchTTL: undefined }), reads),
    ]);

    assert.match(message, /absent or unreadable/);
    assert.match(message, /no readable batch fields/);
  });

  it('refuses when the node will not answer at all', async () => {
    const reads: Reads = { asked: [] };
    const message = await refusalFrom([
      publisher(
        '1080p',
        'http://d:1633',
        'd'.repeat(64),
        () => {
          throw new Error('connection refused');
        },
        reads,
      ),
    ]);

    assert.match(message, /connection refused/);
  });

  /** An empty set establishes nothing, so passing it would be the gate approving a deployment blind. */
  it('refuses an empty publisher set rather than passing it', async () => {
    const message = await refusalFrom([]);

    assert.match(message, /no postage batch at all/);
  });

  /**
   * One node can hold several batches and two rungs can share one, so the pair is the unit. This is
   * the opposite of `ChequebookGate`, which deduplicates by URL because one node has one chequebook.
   */
  it('checks each node-and-batch pair once, however many rungs route through it', async () => {
    const reads: Reads = { asked: [] };
    const shared = 'e'.repeat(64);
    const other = 'f'.repeat(64);
    await new PostageGate(
      [
        publisher('360p', 'http://a:1633', shared, batch(), reads),
        publisher('480p', 'http://a:1633', shared, batch(), reads),
        publisher('720p', 'http://a:1633', other, batch(), reads),
      ],
      MIN_TTL_S,
      MAX_UTILIZATION,
      silent,
    ).assertUsable();

    assert.deepEqual(reads.asked, [`http://a:1633 ${shared}`, `http://a:1633 ${other}`]);
  });

  /** Ladder order, so the first failure names the first rung rather than whichever lost a race. */
  it('names the first failing rung in ladder order', async () => {
    const reads: Reads = { asked: [] };
    const message = await refusalFrom([
      publisher('360p', 'http://a:1633', 'a'.repeat(64), batch(), reads),
      publisher('480p', 'http://b:1633', 'b'.repeat(64), batch({ utilizationRatio: 0.99 }), reads),
      publisher('720p', 'http://c:1633', 'c'.repeat(64), batch({ utilizationRatio: 0.99 }), reads),
    ]);

    assert.match(message, /480p/);
    assert.equal(reads.asked.length, 2, 'it should stop at the first refusal rather than reading on');
  });
});
