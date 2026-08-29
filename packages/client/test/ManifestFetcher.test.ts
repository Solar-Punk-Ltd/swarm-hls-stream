import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { makeFeedIdentifier } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'vitest';

import {
  FEED_STATE_LIVE,
  FEED_STATE_RECONNECTING,
  FEED_STATE_STALLED,
  FeedHealthTracker,
  type FeedState,
  UNSERVED_POLLS_PROBE_CEILING,
  UNSERVED_SLOT_STALL_MS,
} from '../src/components/SwarmHlsPlayer/feedState';
import {
  ManifestFetcher,
  ManifestStateManager,
  MAX_SLOTS_PER_POLL,
  PROBE_DISTANCES,
  UNSERVED_POLLS_BEFORE_PROBE,
  waitMs,
} from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { MANIFEST_BACKOFF_JITTER_FRACTION, RequestJitter } from '../src/utils/requestJitter';

/**
 * Neither staggers nor spreads, so every assertion in this file measures what it measured before the
 * request jitter existed. A zero bound runs a staggered walk synchronously, and a random that always
 * returns zero leaves a backoff at exactly the length the fetcher asked for.
 *
 * ⛔ Not the production default, which is a real delay off `Math.random`. The tests that cover the
 * jitter itself build their own, and one below deliberately uses the shipped defaults, for the same
 * reason `waitMs` is exercised directly: every test injecting over a thing is how a thing that does
 * nothing stays green.
 */
const NO_JITTER = new RequestJitter(0, () => 0);

const BEE_URL = 'http://bee.test';
const OWNER = '0x1111111111111111111111111111111111111111';
const TOPIC_NAME = 'con29';
const START_INDEX = 5n;

/** Where a restart's `handleInitialFetch` re-anchors, far enough ahead that a rewind is unmistakable. */
const RESYNCED_INDEX = 40n;

/**
 * How far the fixture can name a slot by address.
 *
 * Distinct from how far its publisher has written, which each test sets for itself. A request past
 * this is one the fixture cannot recognise at all, which is a limit of the fixture rather than a case
 * under test, so `stubFetch` asserts on it instead of answering. It has to clear
 * {@link MAX_SLOTS_PER_POLL} slots past any index a test starts from, since one poll may now consume
 * that many.
 */
const LAST_ADDRESSABLE_INDEX = 128n;

const topic = Topic.fromString(TOPIC_NAME);
const hexTopic = topic.toString();

/** Feed slot ids the publisher would write, so a request can be read back as the index it asked for. */
const indexById = new Map<string, bigint>();
for (let i = 0n; i <= LAST_ADDRESSABLE_INDEX; i++) {
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
 *
 * ⛔ **One poll per call, never a loop of them.** Node floors `setTimeout(0)` at about a millisecond,
 * so this budget costs tens of milliseconds of real time and a loop pays that per poll. Six loops here
 * used to, the worst two measuring 2306ms and 677ms on a quiet machine, and the 677ms one took
 * **5491ms** under a full `pnpm verify`, past vitest's 5000ms default, which failed the repo gate with
 * nothing wrong. A budget is also the weaker wait: it can only be long enough or too short. Every loop here
 * now awaits {@link ManifestFetcher.settled}, which is the walk's own completion signal. See the note
 * above `poll` in the #84 block, which reached this conclusion first.
 */
async function settle(ticks = 50): Promise<void> {
  for (let tick = 0; tick < ticks; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const manager = ManifestStateManager.getInstance();
const realFetch = globalThis.fetch;
const realConsoleError = console.error;

describe('ManifestFetcher follow-up fetches (CON-29)', () => {
  let fetcher: ManifestFetcher;
  let requested: bigint[];
  let publishedThrough: bigint;
  /**
   * Held explicitly rather than left to the fetcher's own, so the unserved run this block drives can
   * be read and, more importantly, aged. The default tracker runs on `performance.now`, which a test
   * cannot move.
   */
  let health: FeedHealthTracker;
  let clockMs: number;

  beforeEach(() => {
    manager.clear(hexTopic);
    manager.updateManifest(
      hexTopic,
      ['#EXTM3U'],
      [{ extinf: '#EXTINF:2,', uri: 'seg-5.ts', discontinuity: false }],
      false,
    );
    manager.setIndex(hexTopic, FeedIndex.fromBigInt(START_INDEX));

    clockMs = 0;
    health = new FeedHealthTracker(() => clockMs);
    fetcher = new ManifestFetcher(manager, health, undefined, NO_JITTER);
    fetcher.beeUrl = BEE_URL;
    requested = [];
    publishedThrough = START_INDEX + 1n;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realConsoleError;
  });

  /**
   * What a publisher who has written every slot up to `publishedThrough` answers.
   *
   * A slot past that is a 404, which is the ordinary answer to a viewer who has caught up, and the
   * only thing that tells a poll to stop walking. A fixture that served every address instead would
   * let one poll run to {@link MAX_SLOTS_PER_POLL} in tests about something else entirely.
   */
  function servedByPublisher(index: bigint): Response {
    return index <= publishedThrough
      ? new Response(manifestForIndex(index))
      : new Response('not found', { status: 404 });
  }

  /** Answers every follow-up request, holding each one open until `gate` resolves. */
  function stubFetch(gate: Promise<void>, respond = servedByPublisher): void {
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
    publishedThrough = START_INDEX + 4n; // room for the pair to advance past a slot nobody fetched
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

  /**
   * What the re-entry guard is actually for, which the test above does not reach.
   *
   * That one asserts every consumed slot was fetched, and two concurrent walks each fetch what they
   * consume, so it holds either way: deleting `!this.inFlight.has(hexTopic) &&` from the guard left
   * all 47 tests in this file green, on the current code and on pristine pre-fix code alike. What the
   * guard buys is cost. hls.js reloads a live playlist on its own cadence and does not wait for the
   * last reload's walk to finish, so without it a viewer whose gateway is answering slowly opens a
   * fresh walk per reload, each re-requesting slots the ones already running are mid-flight on. That
   * is a viewer paying more the worse their gateway gets, which is the direction it must not go.
   *
   * ⚠️ **Asserted as the sequence, and a count would not have worked.** Four overlapping polls issue
   * four requests for the same first slot and then get correspondingly less far, so the totals
   * coincide: measured with the guard deleted, this run asks `[6, 6, 6, 6, 7]` where one walk asks
   * `[6, 7, 8, 9, 10]`, five requests either way. The count also varies between runs, since the extra
   * walks interleave, so a length assertion here would be flaky rather than merely weak. The sequence
   * is deterministic whenever it passes, and it pins the other direction too: a guard that never
   * released would ask for fewer slots than one walk does.
   */
  it('opens one walk per topic however many polls overlap, rather than one per poll', async () => {
    publishedThrough = START_INDEX + 4n;
    const gate = deferred<void>();
    stubFetch(gate.promise);

    // Every one of these lands while the first walk is still held on its first request, which is what
    // an hls.js reload does to a gateway slower than the reload cadence.
    for (let poll = 0; poll < 4; poll++) {
      await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    }
    gate.resolve();
    await fetcher.settled();

    assert.deepEqual(
      requested,
      [START_INDEX + 1n, START_INDEX + 2n, START_INDEX + 3n, START_INDEX + 4n, START_INDEX + 5n],
      `four overlapping polls asked for ${requested}, rather than each slot once and then one past the publisher: ` +
        'a poll opened its own walk instead of joining the one already running',
    );
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
    publishedThrough = afterFirst + 1n; // the publisher wrote one more slot between the two polls
    const second = deferred<void>();
    stubFetch(second.promise);
    requested.length = 0; // only what the later poll asks for is under test here
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    second.resolve();
    await settle();

    assert.deepEqual(
      requested,
      [afterFirst + 1n, afterFirst + 2n],
      `the later poll asked for ${requested} rather than the next slot and then one past the publisher`,
    );
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

  /**
   * One poll of a feed that answers nothing for the slot the player is waiting on.
   *
   * Awaits the walk rather than a tick budget, because both tests below run thirty of these and one
   * ran 5491ms against vitest's 5000ms default under a loaded machine. The count is also what those
   * tests assert on, and the walk is where a poll is counted, so this is the wait that cannot be too
   * short: see {@link settle}.
   */
  async function pollUnservedSlot(): Promise<void> {
    const gate = deferred<void>();
    stubFetch(gate.promise, () => new Response('not found', { status: 404 }));
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    gate.resolve();
    await fetcher.settled();
  }

  /** One poll that the publisher does answer, which is what a run of unserved polls has to forget. */
  async function pollServedSlot(): Promise<void> {
    const gate = deferred<void>();
    stubFetch(gate.promise);
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    gate.resolve();
    await fetcher.settled();
  }

  // The previous test pins that one unserved slot is silent, which is the ordinary case for a viewer
  // who has caught up. On its own that assertion is equally satisfied by never reporting at all, and
  // never reporting is what this branch shipped: a slot no gateway will serve strands the feed there
  // for good, while later slots exist and every signal the player emits still says fine.
  it('reports a feed that has sat on an unserved slot for too many polls', async () => {
    const reported: string[] = [];
    console.error = (...args: unknown[]) => reported.push(args.map(String).join(' '));

    for (let poll = 0; poll < UNSERVED_POLLS_PROBE_CEILING - 1; poll++) {
      await pollUnservedSlot();
    }
    assert.deepEqual(reported, [], 'a viewer who has merely caught up with the publisher was told something is wrong');

    await pollUnservedSlot();

    assert.equal(reported.length, 1, `expected exactly one report, got ${reported.length}: ${reported.join(' | ')}`);
    assert.match(
      reported[0],
      new RegExp(`has not advanced past slot ${START_INDEX + 1n} in ${UNSERVED_POLLS_PROBE_CEILING} polls`),
      `the report does not name the stuck slot: ${reported[0]}`,
    );

    await pollUnservedSlot();
    assert.equal(reported.length, 1, 'the report repeats on every poll after the threshold');
  });

  /**
   * ⛔ **The risk the timed threshold introduces, and the only test that can catch it.**
   *
   * Every poll of a healthy feed ends on the 404 that says the publisher has been caught, so a
   * viewer at the live edge is riding an open unserved run at every instant. Counting polls, that
   * was harmless. Timing the run, a feed polled slowly enough would age into `stalled` while
   * advancing perfectly, and the only thing standing between a caught-up viewer and a permanent
   * overlay is the served slot ending the run before the next one starts.
   *
   * ⚠️ **The window is per run, not per session, and that distinction is the test.** Twenty rounds
   * at a quarter window each is eighty seconds, ten windows of elapsed time, and the feed must still
   * read live throughout because no single run ever reaches eight seconds.
   *
   * A slower cadence than this would be right to call stalled rather than wrong: on a two second
   * stream, eight seconds with no new segment is a draining buffer whatever the reason, which is
   * exactly what the state is for.
   *
   * Mutation-checked on 2026-08-29: making `recordGatewayResponse` carry the run through turns this
   * red, which is what the sibling guard in the #84 block could not do.
   */
  it('does not age a feed that keeps being served into a stall', async () => {
    console.error = () => {};
    const BETWEEN_POLLS_MS = UNSERVED_SLOT_STALL_MS / 4;
    const ROUNDS = 20;

    for (let round = 0; round < ROUNDS; round++) {
      await pollUnservedSlot();
      clockMs += BETWEEN_POLLS_MS;
      // The publisher writes one more slot between polls, as it does live. Without this the walk
      // catches up on the first round and every later "served" poll is really an unserved one.
      publishedThrough += 1n;
      await pollServedSlot();
      clockMs += BETWEEN_POLLS_MS;

      assert.equal(
        health.state(hexTopic),
        FEED_STATE_LIVE,
        `round ${round}: a feed served every ${BETWEEN_POLLS_MS}ms was called stalled after ` +
          `${clockMs}ms, which is ${(clockMs / UNSERVED_SLOT_STALL_MS).toFixed(1)} windows of session`,
      );
    }
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

    for (let poll = 0; poll < UNSERVED_POLLS_PROBE_CEILING - 1; poll++) {
      await pollUnservedSlot();
    }
    await pollServedSlot();
    for (let poll = 0; poll < UNSERVED_POLLS_PROBE_CEILING - 1; poll++) {
      await pollUnservedSlot();
    }

    assert.deepEqual(reported, [], 'a feed that is still advancing was reported as stalled');
    assert.equal(manager.getIndex(hexTopic)!.toBigInt(), START_INDEX + 1n, 'the served slot did not advance the feed');

    await pollUnservedSlot();

    assert.equal(reported.length, 1, 'the polls after the reset were not counted, so the silence above proved nothing');
  });
});

/**
 * The defect a browser found on 2026-08-05, stated as tests.
 *
 * The player consumed exactly one feed slot per playlist reload, and hls.js reloads a live playlist
 * about once per segment duration plus the round trip it just measured. So a viewer's picture could
 * only advance at `duration / (duration + roundTrip)` of real time and the rest of the wall clock was
 * spent frozen: 0.82x at a 0.25s segment with 17.3% of the clock frozen, 0.90x at 0.5s, 0.98x at
 * 1.0s, each matching that ratio to within 0.02, over 897 logged requests. The shorter the segment
 * the worse it got, because a shorter segment does not make the client faster, it makes it ask more
 * often at a fixed cost per ask. See `docs/bench/what-starves-the-viewer-2026-08-05.md`.
 *
 * The fix is not to poll faster. It is to stop treating one poll as worth one slot.
 */
describe('keeping up with a publisher that writes faster than hls.js reloads (#84)', () => {
  /** Advanced by `poll`, so a healthy feed's unserved run genuinely gets a chance to age. */
  let keepUpClockMs = 0;

  let fetcher: ManifestFetcher;
  let health: FeedHealthTracker;
  let requested: bigint[];
  let publishedThrough: bigint;
  let finalSlot: bigint | null;

  beforeEach(() => {
    manager.clear(hexTopic);
    manager.updateManifest(hexTopic, ['#EXTM3U'], [{ extinf: '#EXTINF:2,', uri: 'seg-5.ts' }], false);
    manager.setIndex(hexTopic, FeedIndex.fromBigInt(START_INDEX));

    keepUpClockMs = 0;
    health = new FeedHealthTracker(() => keepUpClockMs);
    fetcher = new ManifestFetcher(manager, health, undefined, NO_JITTER);
    fetcher.beeUrl = BEE_URL;
    requested = [];
    publishedThrough = START_INDEX;
    finalSlot = null;

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const index = requestedIndex(String(input));
      assert.notEqual(index, undefined, `a slot outside the fixture was requested: ${String(input)}`);
      requested.push(index!);
      if (index! > publishedThrough) {
        return new Response('not found', { status: 404 });
      }
      const lines = [manifestForIndex(index!)];
      if (index! === finalSlot) {
        lines.push('#EXT-X-ENDLIST');
      }
      return new Response(lines.join('\n'));
    };
  });

  afterEach(async () => {
    // The second of two guards on the same failure. An assertion that throws mid-test never reaches
    // the next `poll`, so the walk it left running would record its next request against whichever
    // test runs after it. Drained before the stub is restored, so a walk still in flight is answered
    // by the fixture rather than by the network.
    await fetcher.settled();
    globalThis.fetch = realFetch;
    console.error = realConsoleError;
  });

  /**
   * Awaits the walk rather than pumping ticks at it.
   *
   * The stalled-feed loop below runs 35 rounds, and at the 50-tick budget {@link settle} defaults to
   * that was 1750 macrotask round trips of real time, which Node floors at about a millisecond each
   * and vitest then cut off at its 5000ms timeout. The abandoned walk that outlived the cut off is
   * what recorded an extra request against the test that ran next.
   *
   * Shortening the budget is the wrong knob: the test that timed out asserts that no report fired,
   * so a budget too short to let the walk report would make it pass for the wrong reason. Waiting on
   * the walk itself is both faster and the stronger assertion.
   */
  /**
   * How far the clock moves per poll here.
   *
   * ⚠️ **Measured, not assumed: this fixture never records an unserved slot at all.** Its walk ends
   * each poll having consumed everything published, with `unservedPollsRecorded` sitting at zero
   * throughout, so the test below cannot fail whatever this clock does. Verified by mutation on
   * 2026-08-29: making `recordGatewayResponse` keep the run left all 52 tests here green.
   *
   * The clock still moves, because a frozen one would hide the day the walk does start recording
   * one. The claim that a healthy feed never ages into a stall is carried by
   * `does not age a feed that keeps being served into a stall` in the CON-29 block, which drives
   * the unserved path deliberately and was mutation-checked.
   */
  const GENEROUS_POLL_INTERVAL_MS = UNSERVED_SLOT_STALL_MS * 2;

  const poll = async () => {
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    await fetcher.settled();
    keepUpClockMs += GENEROUS_POLL_INTERVAL_MS;
  };

  // The defect itself. One poll used to be worth one segment however many the publisher had written,
  // so a client polling every 327ms against a publisher writing every 267ms lost a segment a second.
  it('consumes every slot the publisher has written, rather than one per poll', async () => {
    publishedThrough = START_INDEX + 5n;

    await poll();

    assert.equal(
      manager.getIndex(hexTopic)!.toBigInt(),
      publishedThrough,
      'one poll did not reach the publisher, so a viewer falls further behind with every segment',
    );
    const manifest = manager.serialize(hexTopic, `${BEE_URL}/bytes`);
    for (let index = START_INDEX + 1n; index <= publishedThrough; index++) {
      assert.match(manifest, new RegExp(`seg-${index}\\.ts`), `slot ${index} was walked past without being played`);
    }
  });

  // The other half: catching up must end. A poll that kept asking would turn a caught-up viewer,
  // which is every healthy viewer, into a loop against the gateway bounded only by the cap below.
  it('stops one slot past the publisher, which is how it learns it has caught up', async () => {
    publishedThrough = START_INDEX + 2n;

    await poll();

    assert.deepEqual(requested, [START_INDEX + 1n, START_INDEX + 2n, START_INDEX + 3n]);
  });

  // A viewer whose tab was hidden, or whose gateway was slow, comes back to a backlog. Draining it
  // is right, draining all of it inside one poll is not: the topic stays marked in flight for the
  // whole walk, and a teardown lands in the middle of it.
  it('hands control back rather than draining an unbounded backlog in one poll', async () => {
    publishedThrough = START_INDEX + BigInt(MAX_SLOTS_PER_POLL) * 3n;

    await poll();

    assert.equal(requested.length, MAX_SLOTS_PER_POLL, `one poll made ${requested.length} feed reads`);
    assert.equal(manager.getIndex(hexTopic)!.toBigInt(), START_INDEX + BigInt(MAX_SLOTS_PER_POLL));

    await poll();

    assert.equal(
      manager.getIndex(hexTopic)!.toBigInt(),
      START_INDEX + BigInt(MAX_SLOTS_PER_POLL) * 2n,
      'the next poll did not carry on from where the cap stopped it',
    );
  });

  /**
   * The teardown the comment above the cap test describes, actually made.
   *
   * That the write is refused is well covered: three tests kill a mutant that removes the index guard
   * in `applySlot`. What the walk does *afterwards* is a separate question, and it was covered only by
   * accident, through the end-of-stream test that happens to share the same `return`. A walk that read
   * a refusal and carried on would keep asking, up to the cap, against a topic the player has already
   * destroyed, and every one of those reads is paid for by the viewer's gateway.
   *
   * Torn down when the walk asks for its second slot, which is the window `SwarmHlsPlayer`'s effect
   * cleanup fires in: it clears the topic and destroys the player on unmount and on every
   * `restartTrigger` bump, and the bump is the recovery path for a fatal error, so it lands exactly
   * when a walk is already in flight.
   */
  it('stops the walk when the topic is torn down between slots', async () => {
    publishedThrough = START_INDEX + BigInt(MAX_SLOTS_PER_POLL);
    const answerFromFixture = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      if (requestedIndex(String(input)) === START_INDEX + 2n) {
        manager.clear(hexTopic);
      }
      return answerFromFixture(input);
    };

    await poll();

    assert.deepEqual(
      requested,
      [START_INDEX + 1n, START_INDEX + 2n],
      'the walk kept reading slots for a topic the player had already torn down',
    );
    assert.equal(manager.getIndex(hexTopic), null, 'a torn-down topic was resurrected mid-walk');
  });

  // Every poll of a healthy feed now ends on the 404 that says the publisher has been caught. That
  // is the same status code a feed stuck on a slot no gateway will serve answers with, and counting
  // the two the same way would report every advancing feed as stalled.
  it('never calls an advancing feed stalled, however long it runs', async () => {
    const reported: string[] = [];
    console.error = (...args: unknown[]) => reported.push(args.map(String).join(' '));

    for (let round = 0; round < UNSERVED_POLLS_PROBE_CEILING + 5; round++) {
      publishedThrough += 1n; // the publisher writes one more slot between polls, as it does live
      await poll();
    }

    assert.deepEqual(reported, [], 'a feed that advanced on every poll was reported as stuck');
    assert.equal(health.state(hexTopic), FEED_STATE_LIVE);
    assert.equal(
      manager.getIndex(hexTopic)!.toBigInt(),
      publishedThrough,
      'the fixture never kept up, so this proves less',
    );
  });

  // A finalised manifest sets no index, so a walk that read `#EXT-X-ENDLIST` and carried on would
  // ask for the same slot again on every step until it hit the cap, for the rest of the session.
  it('stops walking at the end of the stream', async () => {
    publishedThrough = START_INDEX + 6n;
    finalSlot = START_INDEX + 2n;

    await poll();

    assert.deepEqual(requested, [START_INDEX + 1n, START_INDEX + 2n], 'the walk carried on past the end of the stream');
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
 *
 * **Contention was never what broke these, and the lower bound was never the problem.** Both used to
 * assert `elapsed >= requested` exactly, and one failed under a full `pnpm verify` and then passed
 * three times in isolation, which reads like load and is not: contention only makes elapsed longer.
 * `setTimeout` schedules on libuv's clock and this measures with `performance.now()`, and the two
 * disagree slightly. Measured over 4000 runs on this machine, `setTimeout(20)` returned in under
 * 20ms by `performance.now()` **1.18% of the time**, worst case 0.87ms early. Two assertions per
 * run is roughly a 2% chance of a red `pnpm verify` on a branch with nothing wrong with it.
 *
 * So the bound carries the slack that granularity needs and nothing more. It still separates every
 * defect worth naming, because those are a wait that returns immediately and a wait that ignores its
 * argument, and both are off by tens of milliseconds rather than by one. See TEST-53.
 */

/** Measured worst-case early return is 0.87ms, so this is a shade over 2x that and still tiny. */
const TIMER_GRANULARITY_MS = 2;

describe('the wait the fetcher ships with', () => {
  it('actually waits', async () => {
    const startedAt = performance.now();

    await waitMs(20);

    assert.ok(
      performance.now() - startedAt >= 20 - TIMER_GRANULARITY_MS,
      'the shipped delay returned early or not at all',
    );
  });

  it('waits longer when it is asked for longer', async () => {
    const startedAt = performance.now();

    await waitMs(60);

    assert.ok(performance.now() - startedAt >= 60 - TIMER_GRANULARITY_MS, 'the shipped delay ignores its argument');
  });
});

describe('ManifestFetcher against a gateway that stops answering (LAT-3)', () => {
  let fetcher: ManifestFetcher;
  let health: FeedHealthTracker;
  let waited: number[];
  let requested: string[];
  /**
   * Hoisted so a test can move it. The fetcher advances this whenever it waits, and an unserved
   * slot is deliberately never backed off, so a run of them moves no clock on its own. Since the
   * stall is timed rather than counted, a test that only polls never reaches one.
   */
  let clockMs = 0;

  beforeEach(() => {
    manager.clear(hexTopic);
    clockMs = 0;
    health = new FeedHealthTracker(() => clockMs);
    waited = [];
    requested = [];
    fetcher = new ManifestFetcher(
      manager,
      health,
      async (ms) => {
        waited.push(ms);
        clockMs += ms;
      },
      NO_JITTER,
    );
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
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    await fetcher.settled();
    clockMs += UNSERVED_SLOT_STALL_MS;
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    await fetcher.settled();
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

    await assert.rejects(fetcher.fetch(`${OWNER}/${TOPIC_NAME}`), /no swarm-feed-index header/);

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
   * the remains of a hold it had earned during the outage, with nothing said.
   */
  it('does not hold a remounted player off a gateway that has already answered it', async () => {
    stubFetch(gatewayDown);
    for (let attempt = 0; attempt < 5; attempt++) {
      await assert.rejects(fetcher.fetch(`${OWNER}/${TOPIC_NAME}`));
    }
    assert.equal(health.backoffRemainingMs(hexTopic), 8_000, 'the run never reached the cap, so this proves less');

    manager.clear(hexTopic);
    stubFetch(() => feedHead(START_INDEX));
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);

    // Read here, before any follow-up runs. The version of this that failed review closed on a
    // request count taken after a follow-up that would itself have cleared the hold, against a fake
    // clock the injected delay advances, so a hold merely waited out read as zero too and the poll
    // went out either way. Nothing about it could fail for the reason its own name gives.
    assert.equal(health.state(hexTopic), FEED_STATE_LIVE, 'the recovered gateway was still reported as unreachable');
    assert.equal(health.backoffRemainingMs(hexTopic), 0, 'the remounted player was still being held off');

    // And the next failure starts the schedule over rather than resuming at the cap.
    stubFetch(gatewayDown);
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    await settle();

    assert.equal(health.backoffRemainingMs(hexTopic), 2_000, 'the recovery did not reset the backoff schedule');
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

  /**
   * Opening a recording, which is the one route where every playlist a viewer is ever offered is a
   * finished one. The test above already drove it and asked only what the health signal said, so the
   * playlist it handed back went unread: it carried no `#EXTM3U`, which hls.js refuses whole as
   * `Missing format identifier #EXTM3U` and reports as fatal rather than as a bad playlist.
   */
  it('hands back a playable playlist when the feed head is already the recording', async () => {
    const recording = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:2,',
      'seg-0.ts',
      '#EXTINF:2,',
      'seg-1.ts',
      '#EXT-X-ENDLIST',
    ];
    stubFetch(() => feedHead(START_INDEX, recording));

    const manifest = await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);

    assert.ok(manifest.startsWith('#EXTM3U'), `a playlist must open with #EXTM3U, got:\n${manifest}`);
    assert.ok(manifest.includes('#EXT-X-TARGETDURATION:2'), `the target duration must survive, got:\n${manifest}`);
    assert.ok(manifest.includes('#EXT-X-ENDLIST'), `a finished playlist must be closed, got:\n${manifest}`);
    assert.match(manifest, /seg-0\.ts[\s\S]*seg-1\.ts/, `both segments, in order, got:\n${manifest}`);
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

/**
 * The property the bench and the player disagreed about for the whole of LAT-10.
 *
 * `GET /feeds/{owner}/{topic}` asks a node to resolve the newest update, and it cannot keep up with a
 * feed advancing once a second: measured on 2026-08-04 it was 50 to 57% frozen at 1.0 to 7.0 seconds
 * against 0.2% frozen at 46ms for explicit-address reads of the same chunks on the same node. The
 * player has always resolved it once and then walked slot addresses. The bench resolved it on every
 * poll, and so reported the lookup's freeze as the product's.
 *
 * Both sides now route through `nextFeedRequest`, and this is the client's arm of that: the same
 * assertion runs in `packages/shared/test/feedFollow.test.ts` against the shared decision and in
 * `e2e/test/gateway.test.ts` against the bench's follower.
 */
describe('following the feed costs one head lookup (LAT-10)', () => {
  let fetcher: ManifestFetcher;
  let requested: string[];
  let publishedThrough: bigint;

  beforeEach(() => {
    manager.clear(hexTopic);
    fetcher = new ManifestFetcher(manager, undefined, undefined, NO_JITTER);
    fetcher.beeUrl = BEE_URL;
    requested = [];
    publishedThrough = START_INDEX + 3n;

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      const index = requestedIndex(url);
      if (index === undefined) {
        return new Response(manifestForIndex(START_INDEX), {
          headers: { 'Swarm-Feed-Index': START_INDEX.toString(16) },
        });
      }
      return index > publishedThrough
        ? new Response('not found', { status: 404 })
        : new Response(manifestForIndex(index));
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realConsoleError;
  });

  it('resolves the head on mount and never again', async () => {
    for (let poll = 0; poll < 6; poll++) {
      await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
      await fetcher.settled();
    }

    const heads = requested.filter((url) => url.includes('/feeds/'));
    assert.equal(heads.length, 1, `the head was resolved ${heads.length} times: ${requested.join(' ')}`);
    assert.equal(requested[0], `${BEE_URL}/feeds/${OWNER}/${hexTopic}`);
  });

  it('walks by explicit slot address from wherever the head landed', async () => {
    for (let poll = 0; poll < 4; poll++) {
      await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
      await fetcher.settled();
    }

    const followUps = requested.slice(1);
    assert.ok(followUps.length > 0, 'nothing followed the head lookup, so this asserted nothing');
    assert.ok(
      followUps.every((url) => url.includes('/soc/')),
      `a follow-up went back to the head lookup: ${followUps.join(' ')}`,
    );
    assert.equal(
      manager.getIndex(hexTopic)!.toBigInt(),
      publishedThrough,
      'walking slot addresses never reached the publisher',
    );
  });
});

/**
 * A slot that is refused while later slots are already retrievable, and the reader that cannot see
 * past it (#71).
 *
 * ## The measurement this is built on
 *
 * `ManifestFetcher` stops its walk at the first 404, because that is how a reader who has caught up
 * with the publisher finds out. A 404 also means something else, and on this deployment it usually
 * means the other thing. Measured 2026-08-06 beside a broadcast with the uploader killed, by an
 * instrument that asks past every refusal:
 *
 * | | |
 * | --- | ---: |
 * | slots refused | 76 |
 * | **refused with a served slot behind them** | **74** |
 * | refused with nothing behind them, a true head | 2 |
 * | worst stall | **65 consecutive polls, 19.1s** |
 * | nearest served distance | **+1 in 73 of 74** |
 *
 * `docs/bench/what-is-behind-a-refused-slot-2026-08-06.md`. The reader was one request away from
 * moving for the whole of that nineteen seconds.
 *
 * ## Why skipping is safe
 *
 * Each feed slot carries a **full manifest window**, sized in bytes against one chunk, so a later
 * slot still names the segments the skipped ones announced. The fixture below models that rather
 * than one segment per slot, because a fixture that gave each slot a single segment would make
 * jumping look lossy when it is not, and would test the fixture instead of the client.
 */
describe('a refused slot that later slots are already behind (#71)', () => {
  /** How many segments of history each slot's manifest carries, as the live window does. */
  const WINDOW = 4n;

  let fetcher: ManifestFetcher;
  let health: FeedHealthTracker;
  let requested: bigint[];
  let publishedThrough: bigint;
  /** Slots the gateway refuses although the publisher wrote them, which is what the probe is for. */
  let unretrievable: Set<bigint>;
  /** Slots holding the finished recording, which names every segment and renumbers from zero. */
  let recordingAt: Set<bigint>;
  /** Advanced by `poll`, so a run of unserved slots ages the way it would in a browser. */
  let probeClockMs = 0;

  beforeEach(() => {
    manager.clear(hexTopic);
    manager.updateManifest(hexTopic, ['#EXTM3U'], [{ extinf: '#EXTINF:2,', uri: 'seg-5.ts' }], false);
    manager.setIndex(hexTopic, FeedIndex.fromBigInt(START_INDEX));

    probeClockMs = 0;
    health = new FeedHealthTracker(() => probeClockMs);
    fetcher = new ManifestFetcher(manager, health, undefined, NO_JITTER);
    fetcher.beeUrl = BEE_URL;
    requested = [];
    publishedThrough = START_INDEX;
    unretrievable = new Set();
    recordingAt = new Set();

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const index = requestedIndex(String(input));
      assert.notEqual(index, undefined, `a slot outside the fixture was requested: ${String(input)}`);
      requested.push(index!);
      if (index! > publishedThrough || unretrievable.has(index!)) {
        return new Response('not found', { status: 404 });
      }
      const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:2'];
      const from = recordingAt.has(index!) ? 0n : index! > WINDOW ? index! - WINDOW : 0n;
      for (let seg = from; seg <= index!; seg++) {
        lines.push('#EXTINF:2,', `seg-${seg}.ts`);
      }
      if (recordingAt.has(index!)) {
        lines.push('#EXT-X-ENDLIST');
      }
      return new Response(lines.join('\n'));
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realConsoleError;
  });

  /** Awaits the walk, not a tick budget: the stalled-ladder test below polls thirty-five times. */
  /**
   * One feed poll, and the clock moving the way a real one does.
   *
   * The interval is what an unchanged live playlist is reloaded at, and it has to be here because
   * an unserved slot is deliberately never backed off: nothing else in this fixture would move a
   * clock, and the stall this block relies on is timed rather than counted.
   */
  const FEED_POLL_INTERVAL_MS = 1_000;

  const poll = async () => {
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    await fetcher.settled();
    probeClockMs += FEED_POLL_INTERVAL_MS;
  };

  const at = () => manager.getIndex(hexTopic)!.toBigInt();

  /**
   * The ordinary case, and the reason this waits at all. A reader riding the live edge is refused on
   * many polls simply because the publisher has not written yet, and probing every one of those would
   * add a request per poll for every viewer to find nothing.
   */
  it('asks for nothing extra while the run of refusals is short', async () => {
    publishedThrough = START_INDEX;

    for (let attempt = 0; attempt < UNSERVED_POLLS_BEFORE_PROBE - 1; attempt++) {
      await poll();
    }

    assert.deepEqual(
      [...new Set(requested)],
      [START_INDEX + 1n],
      'a reader that had merely caught up went looking past the publisher',
    );
  });

  it('looks past the refusal once the run is long enough to mean something', async () => {
    publishedThrough = START_INDEX + 8n;
    unretrievable.add(START_INDEX + 1n);

    for (let attempt = 0; attempt < UNSERVED_POLLS_BEFORE_PROBE; attempt++) {
      await poll();
    }

    assert.equal(at(), START_INDEX + 2n, 'the reader stayed parked on a slot that later slots were behind');
    assert.ok(
      requested.includes(START_INDEX + 2n),
      `the slot after the refusal was never asked for: asked ${[...new Set(requested)].join(',')}`,
    );
  });

  // The whole point of jumping: the segments the skipped slot announced are in the window of the one
  // that answered, so a viewer loses no media by stepping over a slot they cannot fetch.
  it('loses no segment by stepping over the slot it could not fetch', async () => {
    publishedThrough = START_INDEX + 8n;
    unretrievable.add(START_INDEX + 1n);

    for (let attempt = 0; attempt < UNSERVED_POLLS_BEFORE_PROBE; attempt++) {
      await poll();
    }

    const manifest = manager.serialize(hexTopic, `${BEE_URL}/bytes`);
    assert.match(manifest, new RegExp(`seg-${START_INDEX + 1n}\\.ts`), 'the skipped slot took its segment with it');
  });

  /**
   * A hole several slots wide, which is one of the seventy-four and the reason the probe is a short
   * ladder rather than a single request at +1.
   */
  it('carries on past a hole too wide for the first probe', async () => {
    publishedThrough = START_INDEX + 16n;
    for (const offset of [1n, 2n, 3n, 4n]) {
      unretrievable.add(START_INDEX + offset);
    }

    for (let attempt = 0; attempt < UNSERVED_POLLS_BEFORE_PROBE; attempt++) {
      await poll();
    }

    assert.equal(at(), START_INDEX + 5n, 'a hole wider than one slot parked the reader anyway');
  });

  /**
   * The failure the probe must not invent. A reader at the true head finds nothing behind it either,
   * so it must stay where it is rather than treat its own probes as a reason to move.
   */
  it('stays where it is when there is genuinely nothing behind the refusal', async () => {
    publishedThrough = START_INDEX;

    for (let attempt = 0; attempt < UNSERVED_POLLS_BEFORE_PROBE + 2; attempt++) {
      await poll();
    }

    assert.equal(at(), START_INDEX, 'the reader moved past the publisher, onto a slot nobody has written');
    assert.equal(health.state(hexTopic), FEED_STATE_LIVE, 'a caught-up viewer was told something was wrong');
  });

  // And a probe that finds nothing costs the run nothing: the next poll asks again from the same slot.
  it('keeps asking for the slot it is waiting on after a probe finds nothing', async () => {
    publishedThrough = START_INDEX;

    for (let attempt = 0; attempt < UNSERVED_POLLS_BEFORE_PROBE + 1; attempt++) {
      await poll();
    }
    const asked = requested.filter((index) => index === START_INDEX + 1n).length;

    assert.equal(asked, UNSERVED_POLLS_BEFORE_PROBE + 1, 'the reader stopped asking for the slot it needs');
  });

  /**
   * The ladder is a bet that a refusal is a hole rather than the publisher's head, and it is a good
   * bet: seventy-four of seventy-six refusals had a served slot behind them. It is a bet that has
   * been settled by the time the feed is called stalled, though. By then it has been placed
   * twenty-seven times and lost every one, so whatever is missing is not within reach of it, and
   * carrying on costs four extra requests per poll for as long as the page stays open.
   *
   * Stopping it does not stop recovery. The walk still asks for the next slot every poll at full
   * cadence, so a slot that becomes retrievable later is picked up by the ordinary path.
   */
  it('stops probing once it has asked on every poll and found nothing', async () => {
    publishedThrough = START_INDEX;

    for (let attempt = 0; attempt < UNSERVED_POLLS_PROBE_CEILING + 5; attempt++) {
      await poll();
    }
    const beyond = requested.filter((index) => index > START_INDEX + 1n).length;
    const needed = requested.filter((index) => index === START_INDEX + 1n).length;

    assert.equal(health.state(hexTopic), FEED_STATE_STALLED, 'the run never reached the stalled threshold');
    assert.ok(
      beyond <= (UNSERVED_POLLS_PROBE_CEILING - UNSERVED_POLLS_BEFORE_PROBE + 1) * PROBE_DISTANCES.length,
      `probed ${beyond} times past the refusal, which is more than the probe ceiling allows`,
    );
    assert.equal(needed, UNSERVED_POLLS_PROBE_CEILING + 5, 'the reader stopped asking for the slot it actually needs');
  });
});

/**
 * The end of a broadcast reaches a viewer as one of two finished playlists, and neither may replace
 * the one being played.
 *
 * `normalizeHeaders` pins every playlist this client serves to media sequence zero, so segment N
 * means "the Nth since this viewer joined". Changing the front of the list changes what every number
 * already handed to hls.js refers to, which is exactly what it reports as `media sequence mismatch`,
 * escalates to fatal on a single-variant stream, and the player answers by restarting at zero.
 *
 * Both finished playlists would do it. The closing manifest is a live window and starts later than a
 * viewer who joined earlier. The recording names every segment and starts earlier than a viewer who
 * joined partway through, which is the one measured live on 2026-08-06.
 */
describe('a broadcast ending under a viewer who joined partway through (#94)', () => {
  const TOPIC_ID = 'ending-topic';
  const seg = (n: number) => ({ extinf: '#EXTINF:2,', uri: `seg-${n}.ts` });
  const live = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => seg(from + i));

  function joinedMidBroadcast() {
    const manager = ManifestStateManager.getInstance();
    manager.clear(TOPIC_ID);
    manager.updateManifest(TOPIC_ID, ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:600'], live(600, 650), false);
    return manager;
  }

  const uris = (manager: ManifestStateManager) =>
    manager
      .serialize(TOPIC_ID, '')
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'));

  it('keeps its own playlist when the recording arrives naming the whole broadcast', () => {
    const manager = joinedMidBroadcast();
    const before = uris(manager);

    manager.updateManifest(TOPIC_ID, ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0'], live(0, 650), true);

    assert.deepEqual(uris(manager), before, 'the recording replaced the playlist and rewound the viewer');
  });

  it('keeps its own playlist when the closing manifest is a window that starts later', () => {
    const manager = joinedMidBroadcast();
    const before = uris(manager);

    manager.updateManifest(TOPIC_ID, ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:615'], live(615, 650), true);

    assert.deepEqual(uris(manager), before, 'the closing window truncated the front of the playlist');
  });

  it('takes the segments a closing manifest adds after the last one held', () => {
    const manager = joinedMidBroadcast();

    manager.updateManifest(TOPIC_ID, ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:615'], live(615, 653), true);

    assert.deepEqual(uris(manager).slice(-3), ['seg-651.ts', 'seg-652.ts', 'seg-653.ts']);
  });

  it('ends the playlist either way, which is the fact worth keeping from it', () => {
    const manager = joinedMidBroadcast();

    manager.updateManifest(TOPIC_ID, ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0'], live(0, 650), true);

    assert.match(manager.serialize(TOPIC_ID, ''), /#EXT-X-ENDLIST/);
  });

  it('ignores a finished playlist that shares no segment with this one', () => {
    const manager = joinedMidBroadcast();
    const before = uris(manager);

    manager.updateManifest(TOPIC_ID, ['#EXTM3U'], [{ extinf: '#EXTINF:2,', uri: 'other-stream.ts' }], true);

    assert.deepEqual(uris(manager), before, 'a foreign playlist was concatenated onto the end');
  });
});

/**
 * The live failure of #94, driven through the fetcher rather than asserted on the state manager.
 *
 * Measured on 2026-08-06: the uploader published the closing manifest and the recording 273ms apart,
 * the closing one was momentarily unretrievable, and the probe added in 0.8a stepped over it onto the
 * recording. So the uploader publishing a closing manifest first is necessary and not sufficient, and
 * the guard has to hold on the path the probe takes and not only where the manifests are folded in.
 */
describe('the probe landing on the recording instead of the manifest that ended the stream (#94)', () => {
  let fetcher: ManifestFetcher;
  let requested: bigint[];

  beforeEach(() => {
    manager.clear(hexTopic);
    manager.updateManifest(hexTopic, ['#EXTM3U'], [{ extinf: '#EXTINF:2,', uri: 'seg-5.ts' }], false);
    manager.setIndex(hexTopic, FeedIndex.fromBigInt(START_INDEX));
    fetcher = new ManifestFetcher(manager, new FeedHealthTracker(() => 0), undefined, NO_JITTER);
    fetcher.beeUrl = BEE_URL;
    requested = [];

    // Slot 6 is the closing manifest and cannot be fetched; slot 7 is the recording and can.
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const index = requestedIndex(String(input));
      assert.notEqual(index, undefined, `a slot outside the fixture was requested: ${String(input)}`);
      requested.push(index!);
      if (index! !== START_INDEX + 2n) {
        return new Response('not found', { status: 404 });
      }
      const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:2'];
      for (let seg = 0n; seg <= START_INDEX + 2n; seg++) {
        lines.push('#EXTINF:2,', `seg-${seg}.ts`);
      }
      lines.push('#EXT-X-ENDLIST');
      return new Response(lines.join('\n'));
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realConsoleError;
  });

  const poll = async () => {
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    await fetcher.settled();
  };

  const firstSegment = () =>
    manager
      .serialize(hexTopic, '')
      .split('\n')
      .find((line) => line.length > 0 && !line.startsWith('#'));

  it('does not rewind the viewer to the first second of the broadcast', async () => {
    for (let attempt = 0; attempt <= UNSERVED_POLLS_BEFORE_PROBE; attempt++) {
      await poll();
    }

    assert.ok(requested.includes(START_INDEX + 2n), 'the probe never reached the recording, so this asserted nothing');
    assert.match(
      firstSegment() ?? '',
      /seg-5\.ts$/,
      'the recording replaced the playlist and sent the viewer back to its start',
    );
  });

  it('still learns that the broadcast ended', async () => {
    for (let attempt = 0; attempt <= UNSERVED_POLLS_BEFORE_PROBE; attempt++) {
      await poll();
    }

    assert.match(manager.serialize(hexTopic, ''), /#EXT-X-ENDLIST/);
  });
});

/**
 * ⛔ Every other block in this file injects {@link NO_JITTER}, so the fetcher's two uses of the
 * stagger could both be deleted with the suite still green. These are the tests that fail.
 *
 * They are separate from the backoff block above on purpose: that one asserts the wait the fetcher
 * asks for, and this one asserts that the wait it asks for is not the one every other viewer was
 * given.
 */
describe('ManifestFetcher keeping its requests off the instant every other viewer picked', () => {
  const hexTopic = Topic.fromString(TOPIC_NAME).toString();
  const manager = ManifestStateManager.getInstance();
  const realFetch = globalThis.fetch;
  const realConsoleError = console.error;

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realConsoleError;
    manager.clear(hexTopic);
  });

  /**
   * ⛔ The herd this exists for. `backoffDelayMs` is a pure function of the failure count, so a
   * hundred viewers that lost one gateway in the same second ask it again in the same millisecond,
   * every time, for as long as it stays down. Spreading the wait is what breaks that up, and it is
   * free because the viewer was already waiting.
   */
  it('spreads a backoff that every viewer computed identically', async () => {
    manager.clear(hexTopic);
    console.error = () => {};
    const health = new FeedHealthTracker(() => 0);
    const waited: number[] = [];
    // Half of the quarter that is spread, so the wait comes back an eighth short of the raw backoff.
    const fetcher = new ManifestFetcher(
      manager,
      health,
      async (ms) => void waited.push(ms),
      new RequestJitter(0, () => 0.5),
    );
    fetcher.beeUrl = BEE_URL;

    health.recordGatewayFailure(hexTopic);
    const raw = health.backoffRemainingMs(hexTopic);
    assert.ok(raw > 0, 'the fixture never set a backoff to spread');

    globalThis.fetch = async () => new Response('bad gateway', { status: 502 });
    await fetcher.fetch(`${OWNER}/${TOPIC_NAME}`).catch(() => {});

    assert.equal(waited.length, 1, 'the initial fetch did not wait out a backoff at all');
    assert.ok(waited[0] < raw, `waited the raw ${raw}ms, so every viewer still returns together`);
    assert.equal(waited[0], raw - raw * MANIFEST_BACKOFF_JITTER_FRACTION * 0.5);
  });

  /**
   * The follow-up path has no wait of its own to spread, so the stagger is a delay this adds. hls.js
   * derives its reload cadence from the playlist's target duration and its newest segment, and every
   * viewer of one broadcast reads the same two.
   */
  it('staggers the walk that a level reload triggers', async () => {
    manager.clear(hexTopic);
    manager.updateManifest(hexTopic, ['#EXTM3U'], [{ extinf: '#EXTINF:2,', uri: 'seg-5.ts' }], false);
    manager.setIndex(hexTopic, FeedIndex.fromBigInt(START_INDEX));

    const staggered: (() => void)[] = [];
    const fetcher = new ManifestFetcher(
      manager,
      new FeedHealthTracker(() => 0),
      undefined,
      new RequestJitter(
        60,
        () => 0.5,
        (task) => {
          staggered.push(task);
          return { cancel: () => {} };
        },
      ),
    );
    fetcher.beeUrl = BEE_URL;

    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return new Response('not found', { status: 404 });
    };

    fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    await settle(5);

    assert.equal(requests, 0, 'the walk went straight to the gateway, unstaggered');
    assert.equal(staggered.length, 1, 'the walk was never staggered');

    staggered[0]();
    await settle(5);
    assert.ok(requests > 0, 'the walk never ran once its stagger was up');
  });

  /**
   * The guarantee a stagger could plausibly have broken. `inFlight` is what stops two walks
   * advancing the same feed, and it used to be registered in the same tick the walk started in.
   * Holding the walk back opens a window between the two, and a second reload landing inside it
   * would start a walk that the first one's index has already been taken for.
   */
  it('still allows only one walk per topic while a stagger is outstanding', async () => {
    manager.clear(hexTopic);
    manager.updateManifest(hexTopic, ['#EXTM3U'], [{ extinf: '#EXTINF:2,', uri: 'seg-5.ts' }], false);
    manager.setIndex(hexTopic, FeedIndex.fromBigInt(START_INDEX));

    const staggered: (() => void)[] = [];
    const fetcher = new ManifestFetcher(
      manager,
      new FeedHealthTracker(() => 0),
      undefined,
      new RequestJitter(
        60,
        () => 0.5,
        (task) => {
          staggered.push(task);
          return { cancel: () => {} };
        },
      ),
    );
    fetcher.beeUrl = BEE_URL;
    globalThis.fetch = async () => new Response('not found', { status: 404 });

    fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);
    fetcher.fetch(`${OWNER}/${TOPIC_NAME}`);

    assert.equal(staggered.length, 1, `${staggered.length} walks were queued for one topic`);
  });
});
