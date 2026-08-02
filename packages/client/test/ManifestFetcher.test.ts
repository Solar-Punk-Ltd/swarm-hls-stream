import { FeedIndex, Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'vitest';

import {
  FEED_STATE_LIVE,
  FEED_STATE_RECONNECTING,
  FEED_STATE_STALLED,
  FeedHealthTracker,
  type FeedState,
  UNSERVED_SLOT_POLL_LIMIT,
} from '../src/components/SwarmHlsPlayer/feedState';
import { ManifestFetcher, ManifestStateManager, waitMs } from '../src/components/SwarmHlsPlayer/ManifestManagement';
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
async function settle(ticks = 50): Promise<void> {
  for (let tick = 0; tick < ticks; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * A shorter budget for the polls that 404, which never reach the serialising queue. Used only in the
 * loops long enough that the full budget would outrun the test timeout, and safe there because both
 * of those tests end on an assertion that a report fired, which cannot happen unless every poll in
 * the loop was counted.
 */
const UNSERVED_POLL_TICKS = 8;

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

  /** One poll of a feed that answers nothing for the slot the player is waiting on. */
  async function pollUnservedSlot(): Promise<void> {
    const gate = deferred<void>();
    stubFetch(gate.promise, () => new Response('not found', { status: 404 }));
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    gate.resolve();
    await settle(UNSERVED_POLL_TICKS);
  }

  /** One poll that the publisher does answer, which is what a run of unserved polls has to forget. */
  async function pollServedSlot(): Promise<void> {
    const gate = deferred<void>();
    stubFetch(gate.promise);
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    gate.resolve();
    await settle();
  }

  // The previous test pins that one unserved slot is silent, which is the ordinary case for a viewer
  // who has caught up. On its own that assertion is equally satisfied by never reporting at all, and
  // never reporting is what this branch shipped: a slot no gateway will serve strands the feed there
  // for good, while later slots exist and every signal the player emits still says fine.
  it('reports a feed that has sat on an unserved slot for too many polls', async () => {
    const reported: string[] = [];
    console.error = (...args: unknown[]) => reported.push(args.map(String).join(' '));

    for (let poll = 0; poll < UNSERVED_SLOT_POLL_LIMIT - 1; poll++) {
      await pollUnservedSlot();
    }
    assert.deepEqual(reported, [], 'a viewer who has merely caught up with the publisher was told something is wrong');

    await pollUnservedSlot();

    assert.equal(reported.length, 1, `expected exactly one report, got ${reported.length}: ${reported.join(' | ')}`);
    assert.match(
      reported[0],
      new RegExp(`has not advanced past slot ${START_INDEX + 1n} in ${UNSERVED_SLOT_POLL_LIMIT} polls`),
      `the report does not name the stuck slot: ${reported[0]}`,
    );

    await pollUnservedSlot();
    assert.equal(reported.length, 1, 'the report repeats on every poll after the threshold');
  });

  // The run has to be a run. A feed that answers slowly but does answer must never reach the report,
  // however long the session lasts.
  //
  // The last two steps are what make the silence meaningful. Two runs of `LIMIT - 1` add up to well
  // past the threshold, so staying quiet through them means the served slot reset the count. And one
  // further unserved poll must then report, which can only happen if all `LIMIT - 1` polls before it
  // were counted, so the same assertion also rules out the reading where nothing counted at all.
  it('forgets the run once a slot is served', async () => {
    const reported: string[] = [];
    console.error = (...args: unknown[]) => reported.push(args.map(String).join(' '));

    for (let poll = 0; poll < UNSERVED_SLOT_POLL_LIMIT - 1; poll++) {
      await pollUnservedSlot();
    }
    await pollServedSlot();
    for (let poll = 0; poll < UNSERVED_SLOT_POLL_LIMIT - 1; poll++) {
      await pollUnservedSlot();
    }

    assert.deepEqual(reported, [], 'a feed that is still advancing was reported as stalled');
    assert.equal(manager.getIndex(hexTopic)!.toBigInt(), START_INDEX + 1n, 'the served slot did not advance the feed');

    await pollUnservedSlot();

    assert.equal(reported.length, 1, 'the polls after the reset were not counted, so the silence above proved nothing');
  });
});

/**
 * The backoff and the feed-state signal were first built entirely inside `handleFollowupFetch`, and
 * `handleInitialFetch` is the path taken after every mount and after every self-restart, because the
 * player's effect cleanup clears the topic. A fatal network error is what triggers a restart, so the
 * one path the mechanism never touched was the one an outage guarantees a visit to.
 */
/**
 * Every backoff test below injects its own delay and asserts a test-owned array, which proves the
 * fetcher asks for the right wait and nothing about whether the shipped wait waits. Production is
 * `new ManifestFetcher()` with all defaults, and a default that returned immediately put a page of
 * players back on a down gateway at full cadence with the whole suite green.
 *
 * A lower bound rather than a window, because that is the clock assertion that survives contention.
 */
describe('the wait the fetcher ships with', () => {
  it('actually waits', async () => {
    const startedAt = performance.now();

    await waitMs(20);

    assert.ok(performance.now() - startedAt >= 20, 'the shipped delay returned early or not at all');
  });

  it('waits longer when it is asked for longer', async () => {
    const startedAt = performance.now();

    await waitMs(60);

    assert.ok(performance.now() - startedAt >= 60, 'the shipped delay ignores its argument');
  });
});

describe('ManifestFetcher against a gateway that stops answering (LAT-3)', () => {
  let fetcher: ManifestFetcher;
  let health: FeedHealthTracker;
  let waited: number[];
  let requested: string[];

  beforeEach(() => {
    manager.clear(hexTopic);
    let clockMs = 0;
    health = new FeedHealthTracker(() => clockMs);
    waited = [];
    requested = [];
    fetcher = new ManifestFetcher(manager, health, async (ms) => {
      waited.push(ms);
      clockMs += ms;
    });
    fetcher.beeUrl = BEE_URL;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realConsoleError;
  });

  function stubFetch(respond: (url: string) => Response): void {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      return respond(url);
    };
  }

  const gatewayDown = () => new Response('bad gateway', { status: 502 });

  /** What the feed endpoint answers on the initial path, index header and all. */
  function feedHead(index: bigint, lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXTINF:2,', `seg-${index}.ts`]) {
    return new Response(lines.join('\n'), { headers: { 'Swarm-Feed-Index': index.toString(16) } });
  }

  function seedFollowupState(): void {
    manager.updateManifest(hexTopic, ['#EXTM3U'], [{ extinf: '#EXTINF:2,', uri: 'seg-5.ts' }], false);
    manager.setIndex(hexTopic, FeedIndex.fromBigInt(START_INDEX));
  }

  /** Polls a feed whose gateway answers but has nothing in the slot, until the run is called stalled. */
  async function pollUntilStalled(): Promise<void> {
    console.error = () => {};
    stubFetch(() => new Response('not found', { status: 404 }));
    for (let poll = 0; poll < UNSERVED_SLOT_POLL_LIMIT; poll++) {
      await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
      await settle(UNSERVED_POLL_TICKS);
    }
  }

  /**
   * The initial path is where a restart lands, and the feed endpoint answers with the publisher's
   * last update, so it answers exactly the same for a broadcast that stopped an hour ago. Clearing
   * the unserved run there erased the stall the player had already spent thirty polls establishing,
   * on a picture that is still frozen, and left it to be earned again from zero.
   */
  it('does not erase a stall it has already reported, when the player restarts into it', async () => {
    seedFollowupState();
    await pollUntilStalled();
    assert.equal(
      health.state(hexTopic),
      FEED_STATE_STALLED,
      'the fixture never reached a stall, so this proves nothing',
    );

    manager.clear(hexTopic);
    stubFetch(() => feedHead(START_INDEX));
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);

    assert.equal(health.state(hexTopic), FEED_STATE_STALLED, 'the restart reported the frozen feed as healthy');
  });

  // The other half. Reaching the gateway does have to end a run of failures, or the backoff outlives
  // the outage that set it.
  it('does clear a run of failures when the restart reaches the gateway again', async () => {
    stubFetch(gatewayDown);
    await assert.rejects(fetcher.fetch(`${OWNER}/${TOPIC_NAME}`));
    assert.equal(health.state(hexTopic), FEED_STATE_RECONNECTING);

    stubFetch(() => feedHead(START_INDEX));
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);

    assert.equal(health.state(hexTopic), FEED_STATE_LIVE);
    assert.equal(health.backoffRemainingMs(hexTopic), 0);
  });

  /**
   * A 200 that is not a playlist this player can read is not the gateway being healthy. Handing the
   * empty serialisation to hls.js is a fatal parse error, which restarts the player straight back
   * into this method, and a gateway recorded as healthy imposes no backoff on that loop and says
   * nothing to the viewer, so it spins on a black picture for as long as the tab is open.
   */
  for (const [name, body] of [
    ['a captive portal answering 200 with html', '<html><body>Sign in to continue</body></html>'],
    ['a playlist that parses to no segments at all', '#EXTM3U\n#EXT-X-TARGETDURATION:2'],
  ] as const) {
    it(`refuses ${name}, instead of handing hls.js an empty manifest`, async () => {
      stubFetch(() => new Response(body, { headers: { 'Swarm-Feed-Index': START_INDEX.toString(16) } }));
      const seen: FeedState[] = [];
      health.subscribe(hexTopic, (state) => seen.push(state));

      // Twice, because the second attempt is the one that can flicker: calling the gateway healthy
      // before finding out whether its answer is usable takes an already-reconnecting topic back to
      // live and then straight to reconnecting again, once per attempt, for the whole outage.
      await assert.rejects(fetcher.fetch(`${OWNER}/${TOPIC_NAME}`));
      await assert.rejects(fetcher.fetch(`${OWNER}/${TOPIC_NAME}`));

      assert.equal(health.state(hexTopic), FEED_STATE_RECONNECTING);
      assert.equal(health.backoffRemainingMs(hexTopic), 4_000, 'nothing held the restart loop off');
      assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_RECONNECTING], 'the overlay flickered between attempts');
    });
  }

  // The same shape one step earlier. A response the player cannot take an index from is a response
  // it cannot use, and it used to escape after the state had already been set back to live.
  it('refuses a 200 that omits the feed index header', async () => {
    stubFetch(() => new Response(manifestForIndex(START_INDEX)));

    await assert.rejects(fetcher.fetch(`${OWNER}/${TOPIC_NAME}`), /Missing feed index header/);

    assert.equal(health.state(hexTopic), FEED_STATE_RECONNECTING);
  });

  /**
   * The mirror of the two follow-up teardown tests above, on the path that had no guard at all. The
   * wait this branch added holds the initial fetch open for the whole backoff, and the outage that
   * sets that backoff is what drives the restart that tears the topic down, so the window and the
   * event that fires into it are now the same event.
   */
  it('does not resurrect a topic that was torn down while its first fetch was in flight', async () => {
    const gate = deferred<void>();
    globalThis.fetch = async () => {
      await gate.promise;
      return feedHead(START_INDEX);
    };

    const pending = fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    manager.clear(hexTopic);
    gate.resolve();

    await assert.rejects(pending, /torn down/);
    assert.equal(manager.getIndex(hexTopic), null, 'a torn-down topic was resurrected at a pre-teardown index');
    assert.equal(manager.serialize(hexTopic, `${BEE_URL}/bytes`), '', 'segments were appended to a cleared topic');
  });

  it('says the feed is reconnecting when the first fetch of a mount cannot reach the gateway', async () => {
    stubFetch(gatewayDown);

    await assert.rejects(fetcher.fetch(`${OWNER}/${TOPIC_NAME}`));

    assert.equal(health.state(hexTopic), FEED_STATE_RECONNECTING);
  });

  // The root cause, stated as a test. The restart discards the topic, and the state describing why
  // it restarted has to survive that or a viewer sees the overlay flicker off exactly when the
  // outage is at its worst.
  it('keeps saying so across the restart that the outage itself causes', async () => {
    stubFetch(gatewayDown);
    await assert.rejects(fetcher.fetch(`${OWNER}/${TOPIC_NAME}`));

    manager.clear(hexTopic);
    const seen: FeedState[] = [];
    health.subscribe(hexTopic, (state) => seen.push(state));

    assert.deepEqual(seen, [FEED_STATE_RECONNECTING], 'the remounted player was told the feed was fine');
  });

  // Exact waits, not "some wait happened". The version of this that failed review asserted a request
  // count under a ceiling, which a backoff slow enough to make the player useless satisfies better.
  it('waits out a lengthening backoff on the path a restart takes', async () => {
    stubFetch(gatewayDown);

    await assert.rejects(fetcher.fetch(`${OWNER}/${TOPIC_NAME}`));
    await assert.rejects(fetcher.fetch(`${OWNER}/${TOPIC_NAME}`));
    await assert.rejects(fetcher.fetch(`${OWNER}/${TOPIC_NAME}`));

    assert.deepEqual(waited, [2_000, 4_000], 'the first attempt should not wait, and the rest should double');
  });

  it('stops holding the gateway off the moment it answers', async () => {
    stubFetch(gatewayDown);
    await assert.rejects(fetcher.fetch(`${OWNER}/${TOPIC_NAME}`));

    stubFetch(() => feedHead(START_INDEX));
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);

    assert.deepEqual(waited, [2_000]);
    assert.equal(health.state(hexTopic), FEED_STATE_LIVE);
    assert.equal(health.backoffRemainingMs(hexTopic), 0);
  });

  /**
   * The failure this shape produced before. A run of failures left a backoff behind that only a
   * successful follow-up cleared, and after a remount there are no follow-ups until the initial
   * fetch has set an index, so the first thing the player did on a recovered gateway was sit out
   * the remains of a thirty second hold with nothing said.
   */
  it('does not hold a remounted player off a gateway that has already answered it', async () => {
    stubFetch(gatewayDown);
    for (let attempt = 0; attempt < 5; attempt++) {
      await assert.rejects(fetcher.fetch(`${OWNER}/${TOPIC_NAME}`));
    }

    manager.clear(hexTopic);
    stubFetch(() => feedHead(START_INDEX));
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);

    requested.length = 0;
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    await settle();

    assert.equal(requested.length, 1, 'the follow-up poll after a recovered gateway was still being held off');
  });

  it('clears the signal when the stream comes back already finished', async () => {
    stubFetch(gatewayDown);
    await assert.rejects(fetcher.fetch(`${OWNER}/${TOPIC_NAME}`));

    const finished = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXTINF:2,', 'seg-5.ts', '#EXT-X-ENDLIST'];
    stubFetch(() => feedHead(START_INDEX, finished));
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);

    // A finalised manifest sets no index, so this topic stays on the initial path for the rest of
    // the session. Anything that only cleared the signal from the follow-up path never runs again.
    assert.equal(manager.getIndex(hexTopic), null, 'the fixture no longer strands the topic, so this proves less');
    assert.equal(health.state(hexTopic), FEED_STATE_LIVE);
  });

  it('holds off the poll cadence when the gateway fails mid-stream', async () => {
    seedFollowupState();
    console.error = () => {};
    stubFetch(gatewayDown);

    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    await settle();

    assert.equal(health.state(hexTopic), FEED_STATE_RECONNECTING);
    assert.equal(health.backoffRemainingMs(hexTopic), 2_000);

    requested.length = 0;
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    await settle();

    assert.deepEqual(requested, [], 'the next poll went out while the gateway was still being held off');
  });

  // The opposite case wearing the same status code. A viewer who has caught up with the publisher
  // gets one of these on nearly every poll and has to keep asking at full cadence.
  it('does not hold anything off over a slot the publisher has not written yet', async () => {
    seedFollowupState();
    stubFetch(() => new Response('not found', { status: 404 }));

    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    await settle();

    assert.equal(health.backoffRemainingMs(hexTopic), 0);
    assert.equal(health.state(hexTopic), FEED_STATE_LIVE);

    requested.length = 0;
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    await settle();

    assert.equal(requested.length, 1, 'a caught-up viewer stopped polling and would never see the next segment');
  });

  /**
   * The feed-state writes used to sit outside the generation guard that protects the index three
   * lines below them, so a response issued before a teardown could report the gateway as answering
   * for a topic whose replacement had already found it was not.
   */
  /**
   * The other half of that asymmetry, which the source comment is emphatic about and nothing
   * asserted. Wrapping the failure record in the same generation guard the success path sits inside
   * left the whole suite green, and it would undo the branch's root cause: a fatal network error is
   * what tears the topic down, so guarding the failure discards the report of the very outage that
   * caused the teardown.
   */
  it('keeps a gateway failure that arrives after its topic was torn down', async () => {
    seedFollowupState();
    console.error = () => {};
    const gate = deferred<void>();
    globalThis.fetch = async () => {
      await gate.promise;
      return gatewayDown();
    };

    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    manager.clear(hexTopic);
    gate.resolve();
    await settle();

    assert.equal(
      health.state(hexTopic),
      FEED_STATE_RECONNECTING,
      'the outage that caused the teardown went unreported',
    );
    assert.equal(health.backoffRemainingMs(hexTopic), 2_000);
  });

  it('does not let a response that outlived its topic say the gateway is answering', async () => {
    seedFollowupState();
    const gate = deferred<void>();
    globalThis.fetch = async () => {
      await gate.promise;
      return new Response(manifestForIndex(START_INDEX + 1n));
    };

    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    manager.clear(hexTopic);
    health.recordGatewayFailure(hexTopic);
    gate.resolve();
    await settle();

    assert.equal(health.state(hexTopic), FEED_STATE_RECONNECTING);
  });
});
