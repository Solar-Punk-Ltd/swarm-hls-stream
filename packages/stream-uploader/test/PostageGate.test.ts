import { BatchId, Duration, PostageBatch, Size } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GateRefusalError } from '../src/libs/GateRefusalError.js';
import { PostageGate, StampedPublisher } from '../src/libs/PostageGate.js';
import { GateReading, GateRefusal } from '../src/libs/StartGates.js';

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
 * a batch it does not hold, so bee-js throws for both.
 *
 * ⛔ `status` is the one thing that tells the two apart, and `gateReadingOfError` reads nothing else.
 * bee-js puts the response's status on the `BeeResponseError` it throws, so a caller modelling an
 * answer the node gave passes it, and a caller leaving it out is modelling a read that never reached
 * a node at all.
 */
function failingPublisher(rung: string, url: string, stamp: string, failure: string, reads: Reads, status?: number) {
  return node(rung, url, stamp, reads, () =>
    Promise.reject(status === undefined ? new Error(failure) : Object.assign(new Error(failure), { status })),
  );
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
   *
   * The 404 is on the thrown error as well as in its text, because that is where bee-js puts it and
   * where the gate reads it. A fixture carrying the number in prose alone models a read that never
   * landed, which is the opposite of the case this test is named for.
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
        404,
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

/**
 * ⛔ **One rung per boot is what the first-failure throw reports once the service starts anyway.**
 *
 * Stopping at the first refusal is right when the refusal stops the boot, and wrong from the owner's
 * ruling of 2026-09-17 onwards: under `warn` the uploader runs, so a stage with two exhausted batches
 * told an operator about one of them and kept the other until the next restart. Given somewhere to
 * put a refusal this reads every rung and hands each one over. With no collector nothing changes,
 * which is what `refuse` still needs.
 */
describe('the postage gate with somewhere to put a refusal', () => {
  it('reads every rung rather than stopping at the first that fails', async () => {
    const reads: Reads = { asked: [] };
    const collected: GateRefusal[] = [];

    await new PostageGate(
      [
        publisher('360p', 'http://a:1633', 'a'.repeat(64), batch({ usage: 0.99 }), reads),
        publisher('480p', 'http://b:1633', 'b'.repeat(64), batch(), reads),
        failingPublisher('720p', 'http://c:1633', 'c'.repeat(64), 'connection refused', reads),
      ],
      MIN_TTL_S,
      MAX_UTILIZATION,
      silent,
    ).assertUsable((refusal) => collected.push(refusal));

    assert.equal(reads.asked.length, 3, 'every rung has to be read, not just the ones before the first failure');
    assert.deepEqual(
      collected.map((refusal) => refusal.rung),
      ['360p', '720p'],
    );
    assert.match(collected[0].message, /99\.0% used/);
    assert.match(collected[1].message, /connection refused/);
  });

  it('carries the node url on each refusal, for the log rather than for /health', async () => {
    const reads: Reads = { asked: [] };
    const collected: GateRefusal[] = [];

    await new PostageGate(
      [failingPublisher('1080p', 'http://d:1633', 'd'.repeat(64), 'no such batch', reads)],
      MIN_TTL_S,
      MAX_UTILIZATION,
      silent,
    ).assertUsable((refusal) => collected.push(refusal));

    assert.equal(collected[0].url, 'http://d:1633');
    assert.equal(collected[0].rung, '1080p');
  });

  it('still refuses an empty publisher set while collecting', async () => {
    await assert.rejects(
      () => new PostageGate([], MIN_TTL_S, MAX_UTILIZATION, silent).assertUsable(() => {}),
      /no postage batch at all/,
    );
  });
});

/** The same credential-stripping {@link ChequebookGate} does, and through the same helper. */
describe('what a postage refusal says about the node url', () => {
  it('strips a credential out of a refusal', async () => {
    const reads: Reads = { asked: [] };
    const message = await refusalFrom([
      failingPublisher('360p', 'http://operator:hunter2@a:1633', 'a'.repeat(64), 'connection refused', reads),
    ]);

    assert.doesNotMatch(message, /hunter2/);
    assert.match(message, /a:1633/);
  });

  it('strips one out of the reading it logs when the batch clears', async () => {
    const reads: Reads = { asked: [] };
    const lines: string[] = [];

    await new PostageGate(
      [publisher('360p', 'http://operator:hunter2@a:1633', 'a'.repeat(64), batch(), reads)],
      MIN_TTL_S,
      MAX_UTILIZATION,
      { info: (line: string) => lines.push(line) },
    ).assertUsable();

    assert.doesNotMatch(lines[0], /hunter2/);
  });
});

/** The same, for the rung a postage refusal was about. See `GateRefusalError`. */
describe('which node a postage refusal names', () => {
  it('carries the node on the error, with its credential stripped', async () => {
    const reads: Reads = { asked: [] };
    const gate = new PostageGate(
      [failingPublisher('1080p', 'http://operator:hunter2@d:1633', 'd'.repeat(64), 'connection refused', reads)],
      MIN_TTL_S,
      MAX_UTILIZATION,
      silent,
    );

    await assert.rejects(
      () => gate.assertUsable(),
      (error: unknown) => {
        assert.ok(error instanceof GateRefusalError);
        // Normalised, since safeUrl rebuilds a url it had to take a credential out of. See its doc.
        assert.equal(error.nodeUrl, 'http://d:1633/');
        return true;
      },
    );
  });
});

/**
 * ⛔⛔⛔ **Which of two facts a refusal is, because only one of them is about the batch.**
 *
 * A 404 from `/stamps/<id>` is the node saying it does not hold this batch, and every upload on that
 * rung would fail the same way. A timeout, a 502 or an answer with nothing readable in it says only
 * that no reading arrived, which is what the live host hit on 2026-09-16 against a pool address with
 * no node behind it. The owner ruled on 2026-09-17, decision 7 option b, that the shipped mode
 * refuses the first and warns about the second, so the gate marks every refusal with which one it is
 * and `runStartGates` decides what the boot does about it.
 *
 * The gate reads the status off the error rather than out of its text, because bee-js throws
 * `BeeResponseError` with a `status` field on it. An error carrying no status at all is unreadable,
 * since a transport failure never reached a node that could have answered.
 */
describe('which reading a postage refusal carries', () => {
  /** A node whose batch read rejects with `failure`, the way bee-js does for a status it was given. */
  function throwing(failure: unknown, reads: Reads): StampedPublisher {
    return {
      rung: '360p',
      url: 'http://a:1633',
      stamp: 'a'.repeat(64),
      bee: {
        getPostageBatch: async (batchId: string): Promise<PostageBatch> => {
          reads.asked.push(batchId);
          throw failure;
        },
      },
    };
  }

  async function readingOf(publishers: readonly StampedPublisher[]): Promise<GateReading | undefined> {
    const collected: GateRefusal[] = [];
    await new PostageGate(publishers, MIN_TTL_S, MAX_UTILIZATION, silent).assertUsable((refusal) =>
      collected.push(refusal),
    );
    assert.equal(collected.length, 1, 'exactly one refusal was expected');
    return collected[0].reading;
  }

  function beeResponseError(message: string, status: number | undefined): Error {
    return Object.assign(new Error(message), { name: 'BeeResponseError', status });
  }

  it('reads a 404 as the node answering that it does not hold the batch', async () => {
    const reads: Reads = { asked: [] };

    assert.equal(await readingOf([throwing(beeResponseError('issuer does not exist', 404), reads)]), 'answered');
  });

  it('reads a 5xx as no reading at all, the way the node wait reads one', async () => {
    const reads: Reads = { asked: [] };

    assert.equal(await readingOf([throwing(beeResponseError('bad gateway', 502), reads)]), 'unreadable');
  });

  it('reads a transport failure with no status as no reading at all', async () => {
    const reads: Reads = { asked: [] };
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:1633'), { code: 'ECONNREFUSED' });

    assert.equal(await readingOf([throwing(refused, reads)]), 'unreadable');
  });

  it('reads the timeout that ended the boot on 2026-09-16 as no reading at all', async () => {
    const reads: Reads = { asked: [] };

    assert.equal(await readingOf([throwing(new Error('timeout of 20000ms exceeded'), reads)]), 'unreadable');
  });

  // An axios error reaching the gate unwrapped carries its status one level down. Both are read,
  // because this gate's client contract is any client rather than bee-js in particular.
  it('reads a status carried on the response under the error', async () => {
    const reads: Reads = { asked: [] };
    const forbidden = Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } });

    assert.equal(await readingOf([throwing(forbidden, reads)]), 'answered');
  });

  it('reads an answer with no readable batch fields as no reading at all', async () => {
    const reads: Reads = { asked: [] };
    const unreadable = publisher(
      '360p',
      'http://a:1633',
      'a'.repeat(64),
      batch({ duration: undefined as unknown as Duration }),
      reads,
    );

    assert.equal(await readingOf([unreadable]), 'unreadable');
  });

  it('reads usable=false as the node answering about the batch', async () => {
    const reads: Reads = { asked: [] };
    const unusable = publisher('360p', 'http://a:1633', 'a'.repeat(64), batch({ usable: false }), reads);

    assert.equal(await readingOf([unusable]), 'answered');
  });

  it('reads a batch under the time floor as the node answering about the batch', async () => {
    const reads: Reads = { asked: [] };
    const expiring = publisher(
      '360p',
      'http://a:1633',
      'a'.repeat(64),
      batch({ duration: Duration.fromSeconds(MIN_TTL_S - 1) }),
      reads,
    );

    assert.equal(await readingOf([expiring]), 'answered');
  });

  it('reads a batch over the utilization ceiling as the node answering about the batch', async () => {
    const reads: Reads = { asked: [] };
    const full = publisher('360p', 'http://a:1633', 'a'.repeat(64), batch({ usage: 0.99 }), reads);

    assert.equal(await readingOf([full]), 'answered');
  });
});
