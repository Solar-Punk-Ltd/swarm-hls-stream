import { FeedIndex, Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { ManifestFetcher, ManifestStateManager } from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { makeFeedIdentifier } from '../src/utils/bee';

const BEE_URL = 'http://bee.test';
const OWNER = '0x1111111111111111111111111111111111111111';
const TOPIC_NAME = 'con29';
const START_INDEX = 5n;

/** Where a restart's `handleInitialFetch` re-anchors, far enough ahead that a rewind is unmistakable. */
const RESYNCED_INDEX = 40n;

/** How far ahead the fixture can answer, which is more slots than any test here consumes. */
const LAST_SEEDED_INDEX = 12n;

const topic = Topic.fromString(TOPIC_NAME);
const hexTopic = topic.toString();

/** Feed slot ids the publisher would write, so a request can be read back as the index it asked for. */
const indexById = new Map<string, bigint>();
for (let i = 0n; i <= LAST_SEEDED_INDEX; i++) {
  indexById.set(makeFeedIdentifier(topic, FeedIndex.fromBigInt(i)).toString(), i);
}

/** One slot's manifest, carrying a segment no other slot carries so a lost slot is a lost segment. */
function manifestForIndex(index: bigint): string {
  return ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXTINF:2,', `seg-${index}.ts`].join('\n');
}

function requestedIndex(url: string): bigint | undefined {
  return indexById.get(url.slice(url.lastIndexOf('/') + 1));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Lets every settled fetch reach the serialising queue and finish updating state.
 *
 * A fixed budget of macrotask ticks rather than a condition, because the condition worth waiting for
 * is the absence of a second advance, and waiting for something not to happen has no signal to watch.
 * The budget is bounded and generous: once the fetch stub has resolved there is no I/O left, so the
 * callbacks need a handful of ticks, and a defect that needed more than fifty is not the one here.
 * Verified the other way round, which is the part that matters: on 37d1cba these tests fail.
 */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 50; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const manager = ManifestStateManager.getInstance();
const realFetch = globalThis.fetch;
const realConsoleError = console.error;

describe('ManifestFetcher follow-up fetches (CON-29)', () => {
  let fetcher: ManifestFetcher;
  let requested: bigint[];

  beforeEach(() => {
    manager.clear(hexTopic);
    manager.updateManifest(
      hexTopic,
      ['#EXTM3U'],
      [{ extinf: '#EXTINF:2,', uri: 'seg-5.ts', discontinuity: false }],
      false,
    );
    manager.setIndex(hexTopic, FeedIndex.fromBigInt(START_INDEX));

    fetcher = new ManifestFetcher(manager);
    fetcher.beeUrl = BEE_URL;
    requested = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realConsoleError;
  });

  /** Answers every follow-up request, holding each one open until `gate` resolves. */
  function stubFetch(gate: Promise<void>, respond = (index: bigint) => new Response(manifestForIndex(index))): void {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const index = requestedIndex(String(input));
      assert.notEqual(index, undefined, `a slot outside the fixture was requested: ${String(input)}`);
      requested.push(index!);
      await gate;
      return respond(index!);
    };
  }

  // `handleFollowupFetch` is fire and forget: it starts the SOC fetch and returns the already
  // serialised state, so hls.js schedules its next level reload while the previous fetch is still
  // outstanding. Both calls read the same index and ask for the same slot, and then each callback
  // re-read the index and advanced from whatever it found, so the pair advanced twice. The slot in
  // between was never fetched and its segments never reached the viewer. The second callback got
  // that far rather than short-circuiting because `updateManifest` returns `true` for a duplicate
  // parse, where "nothing new, keep polling" and "this slot was consumed, advance" are the same
  // value read two ways.
  it('does not consume a feed slot it never fetched when two follow-up fetches overlap', async () => {
    const gate = deferred<void>();
    stubFetch(gate.promise);

    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    gate.resolve();
    await settle();

    const finalIndex = manager.getIndex(hexTopic)!.toBigInt();
    assert.ok(requested.length > 0, 'no follow-up fetch was issued, so this test asserted nothing');
    assert.ok(finalIndex > START_INDEX, 'the index never advanced, so this test asserted nothing');
    for (let index = START_INDEX + 1n; index <= finalIndex; index++) {
      assert.ok(
        requested.includes(index),
        `slot ${index} was consumed without ever being fetched, so a batch of segments never reaches the viewer`,
      );
    }
  });

  // The half a re-entry guard can quietly break. Refusing the overlapping call is only correct if
  // the topic is released afterwards, and a guard that never released would stop the player
  // following the feed at all while every assertion above stayed green.
  it('fetches the next slot on a later poll, once the overlapping one has settled', async () => {
    const first = deferred<void>();
    stubFetch(first.promise);

    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    first.resolve();
    await settle();

    const afterFirst = manager.getIndex(hexTopic)!.toBigInt();
    const second = deferred<void>();
    stubFetch(second.promise);
    requested.length = 0; // only what the later poll asks for is under test here
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    second.resolve();
    await settle();

    assert.deepEqual(requested, [afterFirst + 1n], `the later poll asked for ${requested} rather than the next slot`);
    assert.equal(manager.getIndex(hexTopic)!.toBigInt(), afterFirst + 1n, 'the later poll did not advance the feed');
  });

  // `SwarmHlsPlayer`'s effect cleanup clears the topic and destroys the player, and nothing cancels
  // a follow-up already in flight. Pinning the target index fixed the skip above and, on its own,
  // made this case worse than it was: the late callback recreated the topic at its pre-teardown
  // index, and an index that exists routes the next mount into the follow-up branch, so the player
  // resumed however far behind it had been rather than resyncing to the live head. On the base
  // commit the callback's `getIndex(...)!` threw instead, which left the index null and was
  // accidentally protective.
  it('does not write its index into the state that replaced the one it read', async () => {
    const gate = deferred<void>();
    stubFetch(gate.promise);

    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    manager.clear(hexTopic);
    gate.resolve();
    await settle();

    assert.equal(manager.getIndex(hexTopic), null, 'a torn-down topic was resurrected at a stale index');
    assert.equal(manager.serialize(hexTopic, `${BEE_URL}/bytes`), '', 'segments were appended to a cleared topic');
  });

  // The same defect in the other order: the player restarts and resyncs to the live head before the
  // abandoned fetch lands. Both orderings happen, and only this one moves the index backwards.
  it('does not rewind the feed when a restart has already resynced ahead of it', async () => {
    const gate = deferred<void>();
    stubFetch(gate.promise);

    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    manager.clear(hexTopic);
    manager.updateManifest(hexTopic, ['#EXTM3U'], [{ extinf: '#EXTINF:2,', uri: 'seg-40.ts' }], false);
    manager.setIndex(hexTopic, FeedIndex.fromBigInt(RESYNCED_INDEX));
    gate.resolve();
    await settle();

    assert.equal(
      manager.getIndex(hexTopic)!.toBigInt(),
      RESYNCED_INDEX,
      'a stale callback dragged the feed back behind the live head, where it advances one slot per poll',
    );
  });

  // A 404 is the ordinary case, not an error: it means the publisher has not written the slot yet.
  // The guard has to be released on that path too, or one poll that outruns the publisher ends the
  // broadcast for that viewer.
  it('keeps following the feed after a follow-up fetch fails, without reporting it', async () => {
    const failed = deferred<void>();
    stubFetch(failed.promise, () => new Response('not found', { status: 404 }));
    const reported: unknown[] = [];
    console.error = (...args: unknown[]) => reported.push(args);

    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    failed.resolve();
    await settle();

    assert.equal(manager.getIndex(hexTopic)!.toBigInt(), START_INDEX, 'a 404 advanced the feed past an unwritten slot');
    assert.deepEqual(reported, [], 'a slot the publisher has not written yet was logged as an error');

    const retry = deferred<void>();
    stubFetch(retry.promise);
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    retry.resolve();
    await settle();

    assert.equal(
      manager.getIndex(hexTopic)!.toBigInt(),
      START_INDEX + 1n,
      'the topic stayed marked in flight after a failure, so the player stopped following the feed',
    );
  });
});
