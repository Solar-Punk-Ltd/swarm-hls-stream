import { BatchId, Duration, PostageBatch, Size } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PostageGate, StampedPublisher } from '../src/libs/PostageGate.js';

const MIN_TTL_S = 24 * 3_600;
const MAX_UTILIZATION = 0.9;
const HEALTHY_TTL_S = 7 * 24 * 3_600;
const BUCKET_DEPTH = 16;
const DEPTH = 24;

/**
 * A batch as **bee-js** hands one over, which is not the shape bee's own HTTP API answers with.
 *
 * ⛔⛔⛔ That distinction is the defect this file was rewritten for, found 2026-08-31 when the
 * four-node stage refused to start. bee answers `/stamps/<id>` with `batchTTL` in seconds and
 * `utilizationRatio`, and bee-js 9 replaces both before any caller sees them: `duration` is a
 * `Duration` instance and `usage` is that same ratio under another name. The fake here was built from
 * bee's JSON, so every test passed while the gate could not read one live batch on any of four nodes.
 *
 * Typed as `PostageBatch` deliberately. The next rename in the library is then a compile error in
 * this file, rather than a service that will not start for a reason nothing here can reproduce.
 */
function batch(over: Partial<PostageBatch> = {}): PostageBatch {
  const usage = over.usage ?? 0.1;
  return {
    batchID: new BatchId('a'.repeat(64)),
    // Derived from `usage` rather than set beside it: the count in the fullest bucket and the ratio
    // are the same reading, and bee-js computes one from the other.
    utilization: Math.round(usage * 2 ** (DEPTH - BUCKET_DEPTH)),
    usable: true,
    label: 'test',
    depth: DEPTH,
    amount: '58878000' as PostageBatch['amount'],
    bucketDepth: BUCKET_DEPTH,
    blockNumber: 1,
    immutableFlag: true,
    duration: Duration.fromSeconds(HEALTHY_TTL_S),
    usage,
    usageText: `${Math.round(usage * 100)}%`,
    size: Size.fromBytes(1),
    remainingSize: Size.fromBytes(1),
    theoreticalSize: Size.fromBytes(1),
    ...over,
  };
}

interface Reads {
  /** One entry per call, so a batch checked twice is visible rather than merely suspected. */
  readonly asked: string[];
}

function node(rung: string, url: string, stamp: string, reads: Reads, read: () => Promise<PostageBatch>) {
  return {
    rung,
    url,
    stamp,
    bee: {
      getPostageBatch: async (batchId: string): Promise<PostageBatch> => {
        reads.asked.push(`${url} ${batchId}`);
        return read();
      },
    },
  } satisfies StampedPublisher;
}

/** A node that answers with this batch. */
function publisher(rung: string, url: string, stamp: string, answer: PostageBatch, reads: Reads) {
  return node(rung, url, stamp, reads, async () => answer);
}

/**
 * A node whose read fails, which is both the unreachable case and the absent-batch case: bee 404s for
 * a batch it does not hold, so bee-js throws for both and the gate cannot tell them apart by shape.
 */
function failingPublisher(rung: string, url: string, stamp: string, failure: string, reads: Reads) {
  return node(rung, url, stamp, reads, () => Promise.reject(new Error(failure)));
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
      publisher('360p', 'http://a:1633', 'a'.repeat(64), batch({ usage: 0.90625 }), reads),
    ]);

    assert.match(message, /90\.6% used/);
    assert.match(message, /ceiling is 90\.0%/);
    assert.match(message, /Dilute it/);
  });

  it('clears a batch that is full to the ceiling but no fuller', async () => {
    const reads: Reads = { asked: [] };
    await new PostageGate(
      [publisher('360p', 'http://a:1633', 'a'.repeat(64), batch({ usage: MAX_UTILIZATION }), reads)],
      MIN_TTL_S,
      MAX_UTILIZATION,
      silent,
    ).assertUsable();
  });

  it('refuses a batch that expires before the floor', async () => {
    const reads: Reads = { asked: [] };
    const message = await refusalFrom([
      publisher(
        '720p',
        'http://b:1633',
        'b'.repeat(64),
        batch({ duration: Duration.fromSeconds(MIN_TTL_S - 1) }),
        reads,
      ),
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

  /**
   * bee answers `/stamps/<id>` with **404 "issuer does not exist"** for a batch it does not hold,
   * verified against a live node on 2026-08-31, so bee-js throws rather than returning an answer with
   * `exists: false` in it. That field is not on `PostageBatch` at all. The absence of a batch is
   * therefore this path and never a field reading, which is why the gate no longer looks for one.
   */
  it('refuses a batch the node does not hold, which arrives as a thrown 404', async () => {
    const reads: Reads = { asked: [] };
    const message = await refusalFrom([
      failingPublisher(
        '480p',
        'http://c:1633',
        'c'.repeat(64),
        'Request failed with status code 404: issuer does not exist',
        reads,
      ),
    ]);

    assert.match(message, /absent or unreadable/);
    assert.match(message, /issuer does not exist/);
  });

  /**
   * ⛔⛔⛔ Absence is a refusal rather than a default, and this is the case the whole file turns on.
   * A batch whose TTL is missing is not a batch with plenty of time. Reading it as one would pass
   * every unreadable answer, which is the exact failure the gate exists to stop.
   *
   * Cast because `PostageBatch` promises the field. What is modelled is a client that is not bee-js:
   * a proxy in front of the node, or a hand-rolled stub, either of which can hand over an object the
   * type says is impossible.
   */
  it('refuses an answer it cannot read rather than treating a missing field as healthy', async () => {
    const reads: Reads = { asked: [] };
    const message = await refusalFrom([
      publisher('1080p', 'http://d:1633', 'd'.repeat(64), batch({ duration: undefined as unknown as Duration }), reads),
    ]);

    assert.match(message, /absent or unreadable/);
    assert.match(message, /no readable batch fields/);
  });

  /**
   * ⛔⛔⛔ The regression, pinned. This is bee's own HTTP JSON, which is what the fake in this file
   * used to be and what the gate used to parse. It has to be refused rather than read, because the
   * two shapes disagree on every field the gate needs and a gate that quietly accepted both would
   * hide the next rename instead of failing on it.
   */
  it('refuses bee’s raw HTTP shape, which is not what bee-js hands over', async () => {
    const reads: Reads = { asked: [] };
    const raw = {
      batchID: 'a'.repeat(64),
      exists: true,
      usable: true,
      batchTTL: HEALTHY_TTL_S,
      utilizationRatio: 0.1,
      depth: DEPTH,
    } as unknown as PostageBatch;
    const message = await refusalFrom([publisher('360p', 'http://a:1633', 'a'.repeat(64), raw, reads)]);

    assert.match(message, /no readable batch fields/);
  });

  it('refuses when the node will not answer at all', async () => {
    const reads: Reads = { asked: [] };
    const message = await refusalFrom([
      failingPublisher('1080p', 'http://d:1633', 'd'.repeat(64), 'connection refused', reads),
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
      publisher('480p', 'http://b:1633', 'b'.repeat(64), batch({ usage: 0.99 }), reads),
      publisher('720p', 'http://c:1633', 'c'.repeat(64), batch({ usage: 0.99 }), reads),
    ]);

    assert.match(message, /480p/);
    assert.equal(reads.asked.length, 2, 'it should stop at the first refusal rather than reading on');
  });
});
