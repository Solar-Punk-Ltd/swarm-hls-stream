import { FeedIndex, Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractFeedIndex,
  type FeedRequest,
  feedSlotPath,
  makeFeedIdentifier,
  nextFeedRequest,
} from '../src/feedFollow.js';

type SlotRequest = Extract<FeedRequest, { kind: 'slot' }>;

const OWNER = '1f8f0d5d0d2e0b1a3c4d5e6f708192a3b4c5d6e7';
const TOPIC = Topic.fromString('swarm-hls-feed-follow-vector');

/** One poll by a follower that has read up to `known`, which is how the player and the bench call it. */
function requestAfter(known: FeedIndex | null): FeedRequest {
  return nextFeedRequest(OWNER, TOPIC, known);
}

/**
 * Addresses produced by bee-js 9.8.1's own `feed/identifier.js`, which computes what a bee node
 * computes when it resolves a feed.
 *
 * Frozen literals rather than a call into that module, because its export map exposes only the
 * package root and deep-importing past one is not resolution this test should depend on. The point is
 * to have an anchor outside our own arithmetic: our implementation exists only because bee-js does
 * not re-export theirs, so the two agreeing is the whole warrant for keeping a copy.
 */
const BEE_JS_IDENTIFIERS: Record<number, string> = {
  0: '1c2c0e3309184791ad5ec0ec2c97568088ecb784e970cd2ef67aa19889f029b3',
  1: '4727d6cdbe1096edddda633d60d2ca9afd372ea0bcf4f9dcd6ba1f58c7caf807',
  42: '8f8e0d58b0b180e8e8ad8775cfb8f9349f4ecfb28973b655e5cff650beee4654',
};

describe('makeFeedIdentifier', () => {
  it('agrees with bee-js on every vector', () => {
    for (const [index, expected] of Object.entries(BEE_JS_IDENTIFIERS)) {
      const actual = makeFeedIdentifier(TOPIC, FeedIndex.fromBigInt(BigInt(index))).toString();
      assert.equal(actual, expected, `index ${index}`);
    }
  });
});

describe('nextFeedRequest', () => {
  it('resolves the head when nothing is known yet', () => {
    const request = nextFeedRequest(OWNER, TOPIC, null);

    assert.equal(request.kind, 'head');
    assert.equal(request.path, `feeds/${OWNER}/${TOPIC.toString()}`);
  });

  it('asks for the slot after the newest one read, by address', () => {
    const request = nextFeedRequest(OWNER, TOPIC, FeedIndex.fromBigInt(41n));

    assert.equal(request.kind, 'slot');
    assert.equal(request.path, `soc/${OWNER}/${BEE_JS_IDENTIFIERS[42]}`);
    assert.equal(request.kind === 'slot' && request.index.toBigInt(), 42n);
  });

  /**
   * The assertion this module was created for.
   *
   * The bench and the player each had their own copy of this decision, and they disagreed about
   * exactly this: the player resolved the head once, the bench resolved it on every poll. That is a
   * 50-57% frozen endpoint against a 0.2% frozen one, and it is why every latency figure taken before
   * 2026-08-04 measured the instrument. Anything following a feed through this function cannot make
   * that mistake, and this is the arm that says so.
   */
  it('costs exactly one head lookup however long the feed is followed', () => {
    const asked: FeedRequest[] = [];
    let known: FeedIndex | null = null;

    for (let poll = 0; poll < 50; poll++) {
      const request = requestAfter(known);
      asked.push(request);
      known = request.kind === 'head' ? FeedIndex.fromBigInt(0n) : request.index;
    }

    const heads = asked.filter((request) => request.kind === 'head');
    assert.equal(heads.length, 1, `the head was resolved ${heads.length} times in 50 polls`);
    assert.equal(asked[0].kind, 'head');
    assert.equal(new Set(asked.map((request) => request.path)).size, 50, 'a poll asked twice for one slot');
  });

  it('walks one slot per poll rather than skipping ahead', () => {
    const indices: bigint[] = [];
    let known = FeedIndex.fromBigInt(0n);

    for (let poll = 0; poll < 5; poll++) {
      const request: SlotRequest = nextFeedRequest(OWNER, TOPIC, known);
      assert.equal(request.kind, 'slot');
      known = request.index;
      indices.push(known.toBigInt());
    }

    assert.deepEqual(indices, [1n, 2n, 3n, 4n, 5n]);
  });
});

/**
 * The address of a slot a caller already knows the number of, which is a different question from the
 * one `nextFeedRequest` answers.
 *
 * A VOD catalog entry carries the SOC index of its final manifest, so a thumbnail needs *that* slot
 * rather than the one after it. Expressing that as `nextFeedRequest(owner, topic, index - 1)` reads
 * as arithmetic nobody can check and is wrong at index 0, so it gets its own name.
 */
describe('feedSlotPath', () => {
  it('addresses the slot it was given, not the one after it', () => {
    assert.equal(feedSlotPath(OWNER, TOPIC, FeedIndex.fromBigInt(42n)), `soc/${OWNER}/${BEE_JS_IDENTIFIERS[42]}`);
  });

  it('addresses slot zero, which no offset from a previous slot can reach', () => {
    assert.equal(feedSlotPath(OWNER, TOPIC, FeedIndex.fromBigInt(0n)), `soc/${OWNER}/${BEE_JS_IDENTIFIERS[0]}`);
  });

  /**
   * The two spell one address, so a change to either has to move both. They were separate strings for
   * about an hour and that is exactly how the last feed-reading rule drifted.
   */
  it('spells the same address nextFeedRequest does', () => {
    const request = nextFeedRequest(OWNER, TOPIC, FeedIndex.fromBigInt(41n));

    assert.equal(request.path, feedSlotPath(OWNER, TOPIC, FeedIndex.fromBigInt(42n)));
  });
});

/**
 * Tested here rather than beside `resolvedFeedIndex`, whose cases live in `e2e/test/gateway.test.ts`
 * and are therefore outside the mutation runner's reach. A guard nothing can kill a mutant in is not
 * a guard.
 */
describe('extractFeedIndex', () => {
  it('reads the index a head lookup resolved to', () => {
    const headers = new Headers({ 'swarm-feed-index': '0000000000000966' });

    assert.equal(extractFeedIndex(headers).toBigInt(), 2_406n);
  });

  it('is case insensitive on the header name, because the Headers API is', () => {
    const headers = new Headers({ 'Swarm-Feed-Index': '0000000000000022' });

    assert.equal(extractFeedIndex(headers).toBigInt(), 34n);
  });

  /** The walk has no fallback at this point, so a missing head has to stop it rather than start it at zero. */
  it('throws when the header is absent', () => {
    assert.throws(() => extractFeedIndex(new Headers()), /no swarm-feed-index header/);
  });

  /** Named rather than a bare BigInt SyntaxError, which says nothing about which feed failed. */
  it('throws a header-naming error when the index is not hex', () => {
    assert.throws(
      () => extractFeedIndex(new Headers({ 'swarm-feed-index': 'not-hex' })),
      /unreadable swarm-feed-index/,
    );
  });
});
