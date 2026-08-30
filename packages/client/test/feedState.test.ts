import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  backoffDelayMs,
  FEED_STATE_DEGRADED,
  FEED_STATE_ENDED,
  FEED_STATE_LIVE,
  FEED_STATE_RECONNECTING,
  FEED_STATE_STALLED,
  FeedHealthTracker,
  type FeedState,
  PLAYBACK_STALL_BURST,
  PLAYBACK_STALL_WINDOW_MS,
  RUNG_ALIVE_WITHIN_MS,
  TRACKED_TOPIC_LIMIT,
  UNSERVED_POLLS_PROBE_CEILING,
  UNSERVED_SLOT_STALL_MS,
} from '../src/components/SwarmHlsPlayer/feedState';

const TOPIC = 'topic-under-test';

function makeClock() {
  let ms = 0;
  return {
    now: () => ms,
    advance: (by: number) => {
      ms += by;
    },
  };
}

/**
 * Drives an unserved run past the stall window.
 *
 * Two polls and a clock, never a loop over the constant. Looping `UNSERVED_SLOT_STALL_MS` times
 * against an implementation that compares to `UNSERVED_SLOT_STALL_MS` compares the constant only to
 * itself, which is how the old poll-count version stayed green at any value including ten minutes.
 */
function unservedPastWindow(tracker: FeedHealthTracker, clock: { advance: (by: number) => void }): void {
  tracker.recordUnservedSlot(TOPIC);
  clock.advance(UNSERVED_SLOT_STALL_MS);
  tracker.recordUnservedSlot(TOPIC);
}

function makeTracker() {
  const clock = makeClock();
  const seen: FeedState[] = [];
  const tracker = new FeedHealthTracker(clock.now);
  return { clock, tracker, seen, watch: () => tracker.subscribe(TOPIC, (state) => seen.push(state)) };
}

describe('FeedHealthTracker backoff schedule', () => {
  /**
   * Written out as milliseconds rather than derived from the base and the cap.
   *
   * The version of this test that failed review advanced its clock by the same constant the
   * implementation caps at, so no value of that constant could make it fail: a cap of ten minutes
   * stayed green, and so did a base slow enough to make the player useless. A schedule is only
   * pinned by numbers that are not the implementation's own.
   */
  it('doubles the wait per consecutive failure and stops at eight seconds', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map(backoffDelayMs), [2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000]);
  });

  /**
   * The sibling constant, pinned the same way and for the same reason. Every test that exercised the
   * unserved run used to loop the threshold's own value against an implementation comparing to that
   * same value, so the constant was only ever compared to itself: raising it to 600 left all 18 tests
   * green, and 600 polls is ten minutes of a dead feed before a viewer is told anything.
   *
   * ⛔ **Polls were the wrong unit, which is why this is now milliseconds.** The poll rate collapses
   * during exactly the stall it counted, so thirty polls meant about eight seconds while healthy and
   * about thirty-two during a stall. See {@link UNSERVED_SLOT_STALL_MS}. Eight seconds is what the
   * count meant in the healthy case, so only the broken case moves.
   */
  it('waits eight seconds of an unserved feed before telling a viewer', () => {
    assert.equal(UNSERVED_SLOT_STALL_MS, 8_000);
  });

  /** Bounds the probe and nothing else since 2026-08-29. The overlay is timed, not counted. */
  it('keeps probing past a refusal for a bounded number of polls', () => {
    assert.equal(UNSERVED_POLLS_PROBE_CEILING, 30);
  });

  it('counts the wait down against its own clock', () => {
    const { tracker, clock } = makeTracker();

    tracker.recordGatewayFailure(TOPIC);
    assert.equal(tracker.backoffRemainingMs(TOPIC), 2_000);

    clock.advance(1_999);
    assert.equal(tracker.backoffRemainingMs(TOPIC), 1);

    clock.advance(1);
    assert.equal(tracker.backoffRemainingMs(TOPIC), 0);
  });

  it('lengthens the wait each time the gateway fails again', () => {
    const { tracker, clock } = makeTracker();

    tracker.recordGatewayFailure(TOPIC);
    clock.advance(2_000);
    tracker.recordGatewayFailure(TOPIC);

    assert.equal(tracker.backoffRemainingMs(TOPIC), 4_000);
  });

  it('drops the whole wait the moment the gateway answers', () => {
    const { tracker } = makeTracker();

    tracker.recordGatewayFailure(TOPIC);
    tracker.recordGatewayFailure(TOPIC);
    tracker.recordGatewayResponse(TOPIC);

    assert.equal(tracker.backoffRemainingMs(TOPIC), 0);
    assert.equal(tracker.state(TOPIC), FEED_STATE_LIVE);
  });

  /**
   * `Date.now` is not monotonic. A backoff scheduled against it is a deadline in a time base that a
   * system clock correction moves, and an outage is a plausible moment for one: a laptop resuming
   * from sleep resynchronises its clock, which is exactly when the gateway was last unreachable.
   */
  it('is not scheduled against a clock a system time correction can move', () => {
    const tracker = new FeedHealthTracker();
    const realDateNow = Date.now;

    tracker.recordGatewayFailure(TOPIC);
    const beforeCorrection = tracker.backoffRemainingMs(TOPIC);
    try {
      Date.now = () => realDateNow() - 60 * 60 * 1_000;
      const afterCorrection = tracker.backoffRemainingMs(TOPIC);

      assert.ok(
        afterCorrection <= beforeCorrection,
        `the clock stepping back an hour added ${afterCorrection - beforeCorrection}ms to a 2s wait`,
      );
    } finally {
      Date.now = realDateNow;
    }
  });
});

/**
 * What the schedule costs a viewer whose gateway has come back, which is a different question from
 * what the schedule is.
 *
 * ⭐ **Measured 2026-08-29, live, in a real browser, on the four rung ABR ladder.** Three unrelated
 * faults were injected under a watching viewer and the frozen picture was timed: killing the
 * uploader process cost **59.0s**, pausing the writer bee node for **eight seconds** cost **58.9s**,
 * and a writer bee outage cost **58.5s**. Three faults of three very different lengths landing
 * within half a second of each other is one timer rather than three coincidences, and the timer is
 * the schedule above. Waiting out 2 + 4 + 8 + 16 and then a first cap period is exactly sixty
 * seconds in which nothing asks the gateway anything, and all three sat on it.
 *
 * ⛔ **The fault length barely enters into it.** An eight second pause cost 58.9 seconds of frozen
 * picture, so fifty of those seconds were the client's own, spent holding off a gateway that had
 * been answering again for the better part of a minute.
 *
 * The bound is the same client's cost on a single rendition, measured 2026-08-27 across both byte
 * sources: a 20.5 second gateway stop froze the picture 28.6s and 27.6s, of which **10.7s and 9.9s
 * were spent after the gateway had started answering again**. See
 * `docs/bench/crash-at-an-in-tab-viewer-2026-08-27.md`. A ladder viewer walks five feeds where a
 * single rendition walks one, and walking more of them must not make recovery worse than the
 * one-rung case a ladder is built out of.
 */
describe('FeedHealthTracker recovery time', () => {
  /** The slower of the two client-owned recoveries measured on a single rendition, 2026-08-27. */
  const SINGLE_RENDITION_RECOVERY_MS = 10_700;

  /** Attempts to run before calling the schedule flat, well past where any doubling can matter. */
  const SCHEDULE_DEPTH = 64;

  /** When the gateway is asked again, counting from the failure that started the fault. */
  function attemptTimesMs(depth: number): number[] {
    const times: number[] = [];
    let at = 0;
    for (let failures = 1; failures <= depth; failures++) {
      const wait = backoffDelayMs(failures);
      assert.ok(wait > 0, `failure ${failures} scheduled a wait of ${wait}ms, which is not a backoff`);
      at += wait;
      times.push(at);
    }
    return times;
  }

  it('re-asks a gateway that came back inside the time one rendition took to recover in full', () => {
    const gaps = Array.from({ length: SCHEDULE_DEPTH }, (_, i) => backoffDelayMs(i + 1));
    const longestGapMs = Math.max(...gaps);

    assert.ok(
      longestGapMs < SINGLE_RENDITION_RECOVERY_MS,
      `a ladder viewer can go ${longestGapMs / 1_000}s without the gateway being asked, where a ` +
        `single rendition recovered in full in ${SINGLE_RENDITION_RECOVERY_MS / 1_000}s`,
    );
  });

  it('gets more than one more chance inside the minute all three 2026-08-29 faults froze for', () => {
    const FROZEN_MS = 59_000;
    const chances = attemptTimesMs(SCHEDULE_DEPTH).filter((at) => at < FROZEN_MS).length;

    assert.ok(
      chances >= 6,
      `the gateway was asked ${chances} times in the ${FROZEN_MS / 1_000}s the picture was frozen`,
    );
  });
});

describe('FeedHealthTracker states', () => {
  it('starts a topic it has never seen as live', () => {
    const { tracker } = makeTracker();

    assert.equal(tracker.state(TOPIC), FEED_STATE_LIVE);
  });

  it('calls a gateway that will not answer a reconnection', () => {
    const { tracker, seen, watch } = makeTracker();
    watch();

    tracker.recordGatewayFailure(TOPIC);

    assert.equal(tracker.state(TOPIC), FEED_STATE_RECONNECTING);
    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_RECONNECTING]);
  });

  it('says it once, not once per failed poll', () => {
    const { tracker, clock, seen, watch } = makeTracker();
    watch();

    for (let attempt = 0; attempt < 5; attempt++) {
      clock.advance(60_000);
      tracker.recordGatewayFailure(TOPIC);
    }

    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_RECONNECTING]);
  });

  /**
   * The other shape of a feed going quiet, and the one that answers 404 the whole way through. A
   * lapsed stamp, a chunk that never synced, or a gateway that does not hold this feed all look
   * exactly like a viewer who has caught up with the publisher, until the run gets long.
   */
  it('stays quiet through a run of unserved slots and then calls the feed stalled', () => {
    const { tracker, clock, seen, watch } = makeTracker();
    watch();

    tracker.recordUnservedSlot(TOPIC);
    clock.advance(UNSERVED_SLOT_STALL_MS - 1);
    tracker.recordUnservedSlot(TOPIC);
    assert.deepEqual(seen, [FEED_STATE_LIVE], 'a viewer who had merely caught up was told something was wrong');

    clock.advance(1);
    tracker.recordUnservedSlot(TOPIC);

    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_STALLED]);
  });

  // Deliberate, and the reason the two runs are counted apart. A caught-up viewer sees an unserved
  // slot on nearly every poll and has to keep asking at full cadence to get the next segment when it
  // lands. Backing that off would add latency to the healthy case to describe the unhealthy one.
  it('never holds off a poll over an unserved slot, however long the run', () => {
    const { tracker, clock } = makeTracker();

    unservedPastWindow(tracker, clock);
    clock.advance(UNSERVED_SLOT_STALL_MS * 10);
    tracker.recordUnservedSlot(TOPIC);

    assert.equal(tracker.state(TOPIC), FEED_STATE_STALLED);
    assert.equal(tracker.backoffRemainingMs(TOPIC), 0);
  });

  it('ends a stalled run on the first slot that is served', () => {
    const { tracker, clock, seen, watch } = makeTracker();
    watch();

    unservedPastWindow(tracker, clock);
    tracker.recordGatewayResponse(TOPIC);

    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_STALLED, FEED_STATE_LIVE]);
  });

  /**
   * The direction the sibling test below does not cover, and the one that was wrong: a failure
   * followed by answered polls, rather than answered polls followed by a failure.
   *
   * An unserved slot is the gateway answering. Carrying the failure count through it pinned the
   * topic to `reconnecting` from one earlier flake until the publisher wrote again, so `stalled` was
   * unreachable for exactly the case it was written for, a publisher that has stopped for good.
   */
  it('lets an answered poll end a run of failures, whatever the answer carried', () => {
    const { tracker, clock, seen, watch } = makeTracker();
    watch();

    tracker.recordGatewayFailure(TOPIC);
    clock.advance(2_000);
    unservedPastWindow(tracker, clock);

    assert.equal(tracker.state(TOPIC), FEED_STATE_STALLED);
    assert.equal(tracker.backoffRemainingMs(TOPIC), 0, 'a gateway answering every poll was still being held off');
    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_RECONNECTING, FEED_STATE_LIVE, FEED_STATE_STALLED]);
  });

  // And the backoff restarts from the base rather than resuming a run the gateway already broke.
  it('starts the next backoff over after the gateway has answered in between', () => {
    const { tracker, clock } = makeTracker();

    tracker.recordGatewayFailure(TOPIC);
    clock.advance(2_000);
    tracker.recordUnservedSlot(TOPIC);
    tracker.recordGatewayFailure(TOPIC);

    assert.equal(tracker.backoffRemainingMs(TOPIC), 2_000);
  });

  it('reports a gateway that stopped answering mid-stall as the reconnection it is', () => {
    const { tracker, clock } = makeTracker();

    unservedPastWindow(tracker, clock);
    tracker.recordGatewayFailure(TOPIC);

    assert.equal(tracker.state(TOPIC), FEED_STATE_RECONNECTING);
  });
});

describe('FeedHealthTracker proof that did not come from a feed read', () => {
  const OTHER_TOPIC = 'another-topic-on-the-same-gateway';

  /**
   * The measured defect this exists for. A viewer's gateway was stopped for 20.5 seconds on
   * 2026-08-06 and the feed was not asked for again until 30 seconds, because the backoff doubles
   * from the failure that set it and nothing shortens it. All the while hls.js was fetching segments
   * through that same gateway and those started succeeding the moment it returned, so the client
   * held the answer and threw it away. 16.2 of the 30.6 second freeze was that wait.
   * `docs/bench/browser-crash-2026-08-06T05-31-04-624Z.md`.
   */
  it('ends the wait on every topic held off, since one gateway serves them all', () => {
    const clock = makeClock();
    const tracker = new FeedHealthTracker(clock.now);

    tracker.recordGatewayFailure(TOPIC);
    tracker.recordGatewayFailure(OTHER_TOPIC);
    assert.ok(tracker.backoffRemainingMs(TOPIC) > 0 && tracker.backoffRemainingMs(OTHER_TOPIC) > 0);

    tracker.recordGatewayReachable();

    assert.equal(tracker.backoffRemainingMs(TOPIC), 0);
    assert.equal(tracker.backoffRemainingMs(OTHER_TOPIC), 0, 'only the first topic was released');
    assert.equal(tracker.state(TOPIC), FEED_STATE_LIVE);
    assert.equal(tracker.state(OTHER_TOPIC), FEED_STATE_LIVE);
  });

  /**
   * The reason this clears the backoff and not the unserved run, and the reason it is not
   * `recordGatewayResponse`. A segment is fetched by chunk address, so it proves the gateway is
   * serving bytes and says nothing at all about whether any publisher is still writing. A feed that
   * stopped an hour ago goes on delivering the segments it already announced, and treating that as
   * the feed advancing would erase a stall the viewer has already been told about.
   */
  it('leaves a stalled feed stalled, because a segment says nothing about a publisher', () => {
    const { tracker, clock, seen, watch } = makeTracker();
    watch();

    unservedPastWindow(tracker, clock);
    assert.equal(tracker.state(TOPIC), FEED_STATE_STALLED);

    tracker.recordGatewayReachable();

    assert.equal(tracker.state(TOPIC), FEED_STATE_STALLED);
    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_STALLED]);
  });

  /**
   * This runs once per segment loaded, which is four times a second at the shipping profile, so the
   * healthy case has to be free. Nothing is in trouble, so there is nothing to release and nothing
   * to say.
   */
  it('starts tracking nothing when no topic is in trouble', () => {
    const { tracker, seen, watch } = makeTracker();
    watch();

    tracker.recordGatewayReachable();
    tracker.recordGatewayReachable();

    assert.deepEqual(seen, [FEED_STATE_LIVE]);
    assert.equal(tracker.state(TOPIC), FEED_STATE_LIVE);
  });

  /**
   * ⭐ The ladder half of the same defect, and why "a feed read only proves the gateway served that
   * feed" was the wrong reading of it. One gateway serves every feed this tracker holds, so a feed
   * read getting through is the same evidence a segment arriving is: the gateway is up. A viewer on
   * the four rung ladder holds five entries, each backing off on its own count, and leaving four of
   * them asleep while the fifth is demonstrably being served is four rungs of nothing to switch to.
   *
   * The two halves are split because they are proven by different things. Reaching the gateway is
   * proven for everybody. That *this* feed reads cleanly is proven only where it was read, so the
   * count stays where it stands: the overlay keeps saying reconnecting rather than flickering once
   * per sibling poll, and a rung that fails again goes back to the wait it had earned rather than
   * to the base.
   */
  it('lets every other held topic try again at once, and forgives only the one proven', () => {
    const clock = makeClock();
    const tracker = new FeedHealthTracker(clock.now);

    tracker.recordGatewayFailure(TOPIC);
    tracker.recordGatewayFailure(OTHER_TOPIC);
    tracker.recordGatewayFailure(OTHER_TOPIC);
    const earnedWaitMs = tracker.backoffRemainingMs(OTHER_TOPIC);
    assert.ok(earnedWaitMs > 0, 'the rung under test was never held off in the first place');

    tracker.recordGatewayReachable(TOPIC);

    assert.equal(tracker.backoffRemainingMs(TOPIC), 0);
    assert.equal(tracker.backoffRemainingMs(OTHER_TOPIC), 0, 'a rung was left asleep beside a rung being served');
    assert.equal(tracker.state(TOPIC), FEED_STATE_LIVE);
    assert.equal(
      tracker.state(OTHER_TOPIC),
      FEED_STATE_RECONNECTING,
      'a sibling poll must not read as this feed recovering',
    );

    tracker.recordGatewayFailure(OTHER_TOPIC);
    assert.ok(
      tracker.backoffRemainingMs(OTHER_TOPIC) > earnedWaitMs,
      'failing again restarted the schedule instead of continuing it',
    );
  });

  /**
   * Releasing a topic rewrites the map entry that is being walked. The tracker deletes before every
   * write so that eviction takes the least recently updated, so an unguarded walk drops entries
   * partway through and leaves some viewers held off by an outage that is over.
   */
  it('releases all of them, however many were held off at once', () => {
    const clock = makeClock();
    const tracker = new FeedHealthTracker(clock.now);
    const topics = Array.from({ length: TRACKED_TOPIC_LIMIT }, (_, i) => `topic-${i}`);

    for (const topic of topics) {
      tracker.recordGatewayFailure(topic);
    }
    tracker.recordGatewayReachable();

    const stillWaiting = topics.filter((topic) => tracker.backoffRemainingMs(topic) > 0);
    assert.deepEqual(stillWaiting, [], `${stillWaiting.length} topics were left waiting out a finished outage`);
  });
});

describe('FeedHealthTracker subscribers', () => {
  /**
   * The finding this exists for. A player mounting into an outage already under way is the common
   * case rather than the rare one, because a fatal network error restarts the player, so the
   * subscriber that arrives after an outage began is the one the outage itself created.
   */
  it('tells a subscriber the state that is already true, before subscribe returns', () => {
    const { tracker, seen, watch } = makeTracker();

    tracker.recordGatewayFailure(TOPIC);
    watch();

    assert.deepEqual(seen, [FEED_STATE_RECONNECTING]);
  });

  it('stops telling one that has unsubscribed', () => {
    const { tracker, seen, watch } = makeTracker();
    const unsubscribe = watch();

    unsubscribe();
    tracker.recordGatewayFailure(TOPIC);

    assert.deepEqual(seen, [FEED_STATE_LIVE]);
  });

  it('tells only the subscribers of the topic that changed', () => {
    const { tracker } = makeTracker();
    const other: FeedState[] = [];
    tracker.subscribe('a-different-topic', (state) => other.push(state));

    tracker.recordGatewayFailure(TOPIC);

    assert.deepEqual(other, [FEED_STATE_LIVE]);
  });

  /**
   * Without this the throw travels back up the promise chain that reported the gateway answering,
   * lands in the handler for the gateway not answering, and is recorded as the opposite of what
   * happened, backing off a gateway that is working.
   */
  it('does not let one listener that throws become a report about the gateway', () => {
    const { tracker, seen, watch } = makeTracker();
    const realConsoleError = console.error;
    console.error = () => {};
    try {
      tracker.subscribe(TOPIC, () => {
        throw new Error('a render this listener drives failed');
      });
      watch();

      tracker.recordGatewayFailure(TOPIC);

      assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_RECONNECTING]);
      assert.equal(tracker.backoffRemainingMs(TOPIC), 2_000, 'a listener throwing changed the backoff');
    } finally {
      console.error = realConsoleError;
    }
  });
});

describe('FeedHealthTracker bounds', () => {
  // Only topics in trouble are held and a topic is dropped as soon as its gateway answers, so what
  // accumulates otherwise is topics a viewer left while they were failing, which nothing comes back
  // to clear.
  it('forgets the least recently updated topic rather than growing without limit', () => {
    const { tracker } = makeTracker();

    for (let i = 0; i <= TRACKED_TOPIC_LIMIT; i++) {
      tracker.recordGatewayFailure(`topic-${i}`);
    }

    assert.equal(tracker.state('topic-0'), FEED_STATE_LIVE, 'the oldest failing topic was still held');
    assert.equal(tracker.state(`topic-${TRACKED_TOPIC_LIMIT}`), FEED_STATE_RECONNECTING);
  });

  // Forgetting a topic changes what the tracker reports about it, so a subscriber that is not told
  // renders "Reconnecting" for the rest of the session while the tracker considers it healthy.
  it('tells a subscriber when its topic is the one evicted', () => {
    const { tracker } = makeTracker();
    const seen: FeedState[] = [];
    tracker.recordGatewayFailure('topic-0');
    tracker.subscribe('topic-0', (state) => seen.push(state));

    for (let i = 1; i <= TRACKED_TOPIC_LIMIT; i++) {
      tracker.recordGatewayFailure(`topic-${i}`);
    }

    assert.deepEqual(seen, [FEED_STATE_RECONNECTING, FEED_STATE_LIVE]);
  });

  it('tells every subscriber when the whole tracker is cleared', () => {
    const { tracker, seen, watch } = makeTracker();
    tracker.recordGatewayFailure(TOPIC);
    watch();

    tracker.clear();

    assert.deepEqual(seen, [FEED_STATE_RECONNECTING, FEED_STATE_LIVE]);
  });

  it('keeps a topic that is still failing ahead of ones that failed before it', () => {
    const { tracker } = makeTracker();

    tracker.recordGatewayFailure('topic-0');
    for (let i = 1; i < TRACKED_TOPIC_LIMIT; i++) {
      tracker.recordGatewayFailure(`topic-${i}`);
    }
    tracker.recordGatewayFailure('topic-0');
    tracker.recordGatewayFailure('one-too-many');

    assert.equal(tracker.state('topic-0'), FEED_STATE_RECONNECTING, 'the topic still failing was evicted');
    assert.equal(tracker.state('topic-1'), FEED_STATE_LIVE);
  });
});

/**
 * A broadcast that ends is not a fault, and it is the one state here that never resolves. The other
 * two describe something being retried behind the overlay; this one describes there being nothing
 * left to retry, so it has to survive everything that would otherwise clear or overwrite it.
 */
describe('FeedHealthTracker on a broadcast that has ended', () => {
  it('says the broadcast ended', () => {
    const { tracker, seen, watch } = makeTracker();
    watch();

    tracker.recordFeedEnded(TOPIC);

    assert.equal(tracker.state(TOPIC), FEED_STATE_ENDED);
    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_ENDED]);
  });

  it('says it once however many finalized manifests arrive', () => {
    const { tracker, seen, watch } = makeTracker();
    watch();

    tracker.recordFeedEnded(TOPIC);
    tracker.recordFeedEnded(TOPIC);
    tracker.recordFeedEnded(TOPIC);

    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_ENDED]);
  });

  /** A gateway going down after the broadcast finished does not make the broadcast unfinished. */
  it('outranks a gateway that stops answering afterwards', () => {
    const { tracker } = makeTracker();
    tracker.recordFeedEnded(TOPIC);

    tracker.recordGatewayFailure(TOPIC);

    assert.equal(tracker.state(TOPIC), FEED_STATE_ENDED);
  });

  it('outranks a feed that then sits on an unserved slot', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordFeedEnded(TOPIC);

    unservedPastWindow(tracker, clock);
    clock.advance(UNSERVED_SLOT_STALL_MS);
    tracker.recordUnservedSlot(TOPIC);

    assert.equal(tracker.state(TOPIC), FEED_STATE_ENDED);
  });

  /** `recordGatewayReachable` clears the other two states. It must not un-end a broadcast. */
  it('is not cleared by the gateway answering again', () => {
    const { tracker } = makeTracker();
    tracker.recordFeedEnded(TOPIC);

    tracker.recordGatewayReachable(TOPIC);
    tracker.recordGatewayResponse(TOPIC);

    assert.equal(tracker.state(TOPIC), FEED_STATE_ENDED);
  });

  it('leaves a topic that never ended alone', () => {
    const { tracker } = makeTracker();

    tracker.recordFeedEnded('some-other-broadcast');

    assert.equal(tracker.state(TOPIC), FEED_STATE_LIVE);
  });
});

/**
 * The fault the other three states cannot describe, from
 * `docs/bench/the-fourteen-minute-collapse-2026-08-07.md`.
 *
 * A gateway answered every request it was given, correctly, for twenty minutes. For the last six of
 * them it answered about five times more slowly than it had, the player's buffer never recovered, and
 * the viewer watched a picture that stopped every couple of seconds. `feedStateMessage` was empty in
 * all 1185 samples, because the other three states all describe a gateway failing to deliver and this
 * one delivered.
 *
 * Counted from the viewer's own symptom rather than from a transfer time, so there is no threshold to
 * pick per profile: the picture stopping is the thing worth saying, and a slow read the buffer
 * absorbs is not.
 */
/** A run of stalls close enough together to be one bad patch, at whatever the clock currently reads. */
function stall(tracker: FeedHealthTracker, times: number): void {
  for (let count = 0; count < times; count++) {
    tracker.recordPlaybackStall(TOPIC);
  }
}

describe('FeedHealthTracker on a gateway that is slow rather than absent', () => {
  /**
   * Pinned against the archived runs rather than against the implementation, the way the two
   * constants above are, and for the same reason: a test that loops `PLAYBACK_STALL_BURST` times
   * against a comparison to `PLAYBACK_STALL_BURST` only ever compares a constant to itself.
   *
   * Both numbers come from replaying every archived browser run's rebuffer counter through candidate
   * rules. In a rolling twenty seconds, excluding startup, the collapse run reaches 4 stalls and the
   * only other degraded run reaches 4, while the worst run a viewer would call healthy reaches 1. The
   * next rule down, 3 stalls in fifteen seconds, fires 2786 seconds into a clean hour.
   */
  it('is set to the burst that separated a degraded run from a healthy one', () => {
    assert.equal(PLAYBACK_STALL_BURST, 4);
    assert.equal(PLAYBACK_STALL_WINDOW_MS, 20_000);
  });

  /**
   * Written in seconds and stalls rather than against the two constants, which is the discipline the
   * backoff schedule above is written under and the one this block needed most. Every one of these
   * driven off `PLAYBACK_STALL_BURST` passes at a burst of 1, where a single stall on any stream puts
   * the overlay up, because a loop of `BURST - 1` runs zero times. Only the pin above failed it.
   */
  it('says nothing about the three stalls in a row a healthy stream can have', () => {
    const { tracker, seen, watch } = makeTracker();
    watch();

    stall(tracker, 3);

    assert.deepEqual(seen, [FEED_STATE_LIVE]);
  });

  it('calls the stream degraded on the fourth stall in twenty seconds', () => {
    const { tracker, seen, watch } = makeTracker();
    watch();

    stall(tracker, 4);

    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_DEGRADED]);
  });

  it('says it once, not once per stall in the burst', () => {
    const { tracker, seen, watch } = makeTracker();
    watch();

    stall(tracker, 12);

    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_DEGRADED]);
  });

  /**
   * The window is what makes this a burst rather than a total. Without it a stream that stalls four
   * times in an hour wears the overlay for the rest of the session, which describes nothing.
   *
   * Spaced by a real duration rather than by the window constant, which the first version of this
   * test used. Advancing by the same value the implementation compares against passes at any window
   * length at all, including one longer than a broadcast.
   */
  it('forgets a stall old enough to have been a different problem', () => {
    const { tracker, clock } = makeTracker();

    for (let stall = 0; stall < 16; stall++) {
      tracker.recordPlaybackStall(TOPIC);
      clock.advance(21_000);
    }

    assert.equal(tracker.state(TOPIC), FEED_STATE_LIVE);
  });

  /** The other side of the window: four stalls spread thinly are not the burst four together are. */
  it('does not add up stalls a viewer would not have felt as one bad patch', () => {
    const { tracker, clock } = makeTracker();

    for (let stall = 0; stall < 4; stall++) {
      tracker.recordPlaybackStall(TOPIC);
      clock.advance(7_000);
    }

    assert.equal(tracker.state(TOPIC), FEED_STATE_LIVE);
  });

  /**
   * ⭐ The case the collapse actually was, and the one the other states get wrong. Slots kept being
   * served all the way through: 384 served against 34 empty after the onset, and the longest run of
   * consecutive unserved slots in the whole run was 2. A served slot ends a stalled feed and a run of
   * failures, because it disproves both. It disproves nothing about a player that cannot keep up.
   */
  it('is not cleared by the gateway serving a slot, because it never stopped serving them', () => {
    const { tracker } = makeTracker();

    for (let poll = 0; poll < 4; poll++) {
      tracker.recordPlaybackStall(TOPIC);
      tracker.recordGatewayResponse(TOPIC);
      tracker.recordUnservedSlot(TOPIC);
      tracker.recordGatewayReachable(TOPIC);
    }

    assert.equal(tracker.state(TOPIC), FEED_STATE_DEGRADED);
  });

  /**
   * Clears itself off the back of the polling the fetcher is already doing, rather than off a timer.
   * Every poll records something, and every record re-reads the clock, so a window that has emptied
   * is noticed within a poll of emptying without this class ever having to schedule anything.
   */
  it('goes back to live on the first poll after the burst has aged out', () => {
    const { tracker, clock, seen, watch } = makeTracker();
    watch();

    stall(tracker, 4);
    clock.advance(PLAYBACK_STALL_WINDOW_MS + 1);
    tracker.recordGatewayResponse(TOPIC);

    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_DEGRADED, FEED_STATE_LIVE]);
  });

  it('forgets the stalls along with the topic when the tracker is cleared', () => {
    const { tracker } = makeTracker();

    stall(tracker, 4);
    tracker.clear(TOPIC);

    assert.equal(tracker.state(TOPIC), FEED_STATE_LIVE);
  });

  /**
   * The weakest of the four, deliberately. Each of the other three names something more specific
   * about why the picture stopped, and a viewer told the stream is unsteady when the gateway has gone
   * away entirely has been told the smaller half of the truth.
   */
  for (const [name, escalate] of [
    ['a gateway that stopped answering', (tracker: FeedHealthTracker) => tracker.recordGatewayFailure(TOPIC)] as [
      string,
      (tracker: FeedHealthTracker, clock: { advance: (by: number) => void }) => void,
    ],
    ['a feed that stopped advancing', unservedPastWindow],
    ['a broadcast that ended', (tracker: FeedHealthTracker) => tracker.recordFeedEnded(TOPIC)],
  ] as const) {
    it(`is outranked by ${name}`, () => {
      const { tracker, clock } = makeTracker();
      stall(tracker, 4);

      escalate(tracker, clock);

      assert.notEqual(tracker.state(TOPIC), FEED_STATE_DEGRADED);
    });
  }

  it('is still there underneath once the stronger fault clears', () => {
    const { tracker } = makeTracker();
    stall(tracker, 4);

    tracker.recordGatewayFailure(TOPIC);
    tracker.recordGatewayReachable(TOPIC);

    assert.equal(tracker.state(TOPIC), FEED_STATE_DEGRADED);
  });

  it('keeps a degraded topic tracked, so the burst survives a poll that found nothing wrong', () => {
    const { tracker } = makeTracker();
    stall(tracker, 4);

    tracker.recordGatewayResponse(TOPIC);

    assert.equal(tracker.state(TOPIC), FEED_STATE_DEGRADED);
  });

  /** The window is bounded by time, and the memory it costs must be bounded by the burst. */
  it('does not grow its record of a stream that stalls without pause', () => {
    const { tracker, clock } = makeTracker();

    for (let stall = 0; stall < 10_000; stall++) {
      tracker.recordPlaybackStall(TOPIC);
      clock.advance(1);
    }

    assert.ok(
      tracker.stallsRecorded(TOPIC) <= PLAYBACK_STALL_BURST,
      `kept ${tracker.stallsRecorded(TOPIC)} stalls, which is a leak on any stream that never recovers`,
    );
  });
});

/**
 * The ladder splits one broadcast across five feeds, and the overlay watches none of them.
 *
 * ⛔ **This is the fault V6 caught live on 2026-08-29.** A viewer's gateway was taken away for
 * twenty-odd seconds. Every rung recorded its failures, the picture froze for 26.6s, and the client
 * rendered nothing at all, which is how it says the feed is live. The viewer was told everything was
 * fine while looking at a frozen frame.
 *
 * The overlay subscribes to the entry topic, the one in the `swarm://` source URL, because that is
 * the only topic a viewer's link names and it is the one that survives a restart. The rung topics
 * are per session and are discovered from the master playlist. So on the ladder every fault was
 * being recorded against a topic nobody was watching, and the two states that describe a gateway
 * problem, `reconnecting` and `stalled`, could not reach a viewer at all. `ended` reached them
 * because {@link LadderFeedPoller} was already taught to record it against the group, and `degraded`
 * reached them because playback stalls are counted off the video element against the entry topic.
 *
 * ⭐ **Every rung has to agree before the group says anything.** One gateway serves all five feeds,
 * so a single rung being served is proof the gateway is answering, and the others are then behind
 * for their own reasons. This is the same all-rungs rule the ended signal already uses.
 */
describe('FeedHealthTracker on a ladder, where the faults land on rungs and the overlay watches the group', () => {
  const GROUP = 'entry-topic-the-viewer-linked';
  const RUNG_1080 = 'rung-1080p';
  const RUNG_360 = 'rung-360p';

  function makeLadder() {
    const clock = makeClock();
    const seen: FeedState[] = [];
    const tracker = new FeedHealthTracker(clock.now);
    tracker.trackGroup(GROUP, [RUNG_1080, RUNG_360]);
    tracker.subscribe(GROUP, (state) => seen.push(state));

    return { clock, tracker, seen };
  }

  it('tells a viewer the gateway is gone when every rung has stopped reaching it', () => {
    const { tracker, seen } = makeLadder();

    tracker.recordGatewayFailure(RUNG_1080);
    tracker.recordGatewayFailure(RUNG_360);

    assert.equal(tracker.state(GROUP), FEED_STATE_RECONNECTING);
    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_RECONNECTING]);
  });

  /** A served rung is proof the gateway answers, so the rung beside it is behind, not unreachable. */
  it('stays quiet while one rung is still being served', () => {
    const { tracker } = makeLadder();

    tracker.recordGatewayFailure(RUNG_1080);

    assert.equal(tracker.state(GROUP), FEED_STATE_LIVE);
  });

  it('takes the overlay down again when a rung reads cleanly', () => {
    const { tracker, seen } = makeLadder();

    tracker.recordGatewayFailure(RUNG_1080);
    tracker.recordGatewayFailure(RUNG_360);
    tracker.recordGatewayReachable(RUNG_1080);

    assert.equal(tracker.state(GROUP), FEED_STATE_LIVE);
    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_RECONNECTING, FEED_STATE_LIVE]);
  });

  /** The publisher stopping is the group's business; one rung caught up with it is not. */
  it('calls the group stalled only once every rung has sat on an unserved slot', () => {
    const { tracker, clock } = makeLadder();

    tracker.recordUnservedSlot(RUNG_1080);
    clock.advance(UNSERVED_SLOT_STALL_MS * 2);
    assert.equal(tracker.state(GROUP), FEED_STATE_LIVE, 'rung 360 is still being served');

    tracker.recordUnservedSlot(RUNG_360);
    clock.advance(UNSERVED_SLOT_STALL_MS);
    assert.equal(tracker.state(GROUP), FEED_STATE_STALLED);
  });

  /**
   * The group's own entry still counts. Playback stalls are recorded against it directly, off the
   * video element, and so is the end of the broadcast.
   */
  it('keeps the states that were already reaching the group', () => {
    const { tracker } = makeLadder();

    for (let stall = 0; stall < PLAYBACK_STALL_BURST; stall++) {
      tracker.recordPlaybackStall(GROUP);
    }
    assert.equal(tracker.state(GROUP), FEED_STATE_DEGRADED);

    tracker.recordFeedEnded(GROUP);
    assert.equal(tracker.state(GROUP), FEED_STATE_ENDED);
  });

  /** A stream with no ladder has no members, and folding nothing must leave it exactly as it was. */
  it('leaves a single-rendition stream reading off its own topic', () => {
    const clock = makeClock();
    const tracker = new FeedHealthTracker(clock.now);

    tracker.recordGatewayFailure(TOPIC);

    assert.equal(tracker.state(TOPIC), FEED_STATE_RECONNECTING);
  });
});

/**
 * ⛔⛔⛔ **`stalled` was unreachable on a ladder, and the threshold was the smaller half of why.**
 *
 * Two faults, found together on 2026-08-29 after V6 fixed the sibling one:
 *
 * 1. `LadderFeedPoller` never called {@link FeedHealthTracker.recordUnservedSlot} at all, so on a
 *    ladder the counter behind this state was permanently zero and the state was dead code.
 * 2. The threshold was a POLL COUNT, and the poll rate is not a constant: it collapses during
 *    exactly the stall it counts. Measured on two recorded uploader crashes, feed reads went from a
 *    264ms gap before the crash to 1064ms during the freeze, so thirty polls is about 8 seconds
 *    while healthy and about 32 during a stall. A 12.4 second freeze accumulated 13 polls, never
 *    reached the threshold, and the viewer was told nothing for twelve seconds.
 *
 * ⭐ **Eight seconds is the same number the poll count meant while healthy**, so a viewer at the
 * live edge is no more likely to see the overlay than before. What changes is the stall case, where
 * the count silently stretched to four times its intended duration. It is also
 * {@link MANIFEST_RETRY_CAP_MS}, which is already this client's answer to how long a quiet feed may
 * go unmentioned.
 *
 * A viewer who has merely caught up with the publisher cannot reach it: a segment lands every 0.5 to
 * 2 seconds and each one ends the run. Eight seconds of an unbroken unserved run means the publisher
 * really has stopped.
 */
describe('FeedHealthTracker calling a feed stalled by elapsed time rather than by poll count', () => {
  it('says nothing on a burst of polls inside the window, however many', () => {
    const { tracker, clock } = makeTracker();

    for (let poll = 0; poll < 500; poll++) {
      tracker.recordUnservedSlot(TOPIC);
    }
    clock.advance(UNSERVED_SLOT_STALL_MS - 1);

    assert.equal(tracker.state(TOPIC), FEED_STATE_LIVE);
  });

  it('calls it stalled once the run outlives the window, on as few as two polls', () => {
    const { tracker, clock } = makeTracker();

    tracker.recordUnservedSlot(TOPIC);
    clock.advance(UNSERVED_SLOT_STALL_MS);
    tracker.recordUnservedSlot(TOPIC);

    assert.equal(tracker.state(TOPIC), FEED_STATE_STALLED);
  });

  /** The run is what is timed, so a slot arriving restarts the clock rather than pausing it. */
  it('starts the clock over when a slot is served', () => {
    const { tracker, clock } = makeTracker();

    tracker.recordUnservedSlot(TOPIC);
    clock.advance(UNSERVED_SLOT_STALL_MS - 500);
    tracker.recordGatewayResponse(TOPIC);

    tracker.recordUnservedSlot(TOPIC);
    clock.advance(UNSERVED_SLOT_STALL_MS - 500);
    assert.equal(tracker.state(TOPIC), FEED_STATE_LIVE);
  });

  it('tells a group watcher only once every rung has been unserved for the window', () => {
    const clock = makeClock();
    const tracker = new FeedHealthTracker(clock.now);
    const GROUP = 'entry-topic';
    tracker.trackGroup(GROUP, ['rung-a', 'rung-b']);

    tracker.recordUnservedSlot('rung-a');
    clock.advance(UNSERVED_SLOT_STALL_MS);
    tracker.recordUnservedSlot('rung-b');
    assert.equal(tracker.state(GROUP), FEED_STATE_LIVE, 'rung-b has only just stopped being served');

    clock.advance(UNSERVED_SLOT_STALL_MS);
    tracker.recordUnservedSlot('rung-a');
    assert.equal(tracker.state(GROUP), FEED_STATE_STALLED);
  });

  /** A gateway that is not answering at all is a different, more specific thing to say. */
  it('still prefers reconnecting over stalled when the gateway is also failing', () => {
    const { tracker, clock } = makeTracker();

    tracker.recordUnservedSlot(TOPIC);
    clock.advance(UNSERVED_SLOT_STALL_MS);
    tracker.recordUnservedSlot(TOPIC);
    tracker.recordGatewayFailure(TOPIC);

    assert.equal(tracker.state(TOPIC), FEED_STATE_RECONNECTING);
  });
});

/**
 * ⛔⛔⛔ **Three rungs outvoted the one the viewer could actually see.**
 *
 * Measured live on 2026-08-30, on both byte paths. One rung of a four rung ladder was silenced under
 * a watching viewer, the picture stopped for 87.2 seconds in the tab and 103.2 through a gateway,
 * three rungs published throughout, and the overlay said `live` for the whole of it. The group's
 * health is what its rungs agree on, and three of four agreed nothing was wrong.
 *
 * ⭐ Agreement is still right for reaching the gateway, which is what it was built for: one gateway
 * serves every feed, so a rung that cannot reach the host its siblings are reaching has a flake of
 * its own and the viewer is still watching. It is wrong for a feed that has stopped advancing, which
 * is a fault the viewer sees the instant it is the rung they are on. So only that half follows the
 * watched rung, and only once a player has said which one it is on.
 */
describe('FeedHealthTracker judging the rung a viewer is actually watching', () => {
  const GROUP = 'entry-topic-the-viewer-linked';
  const RUNG_1080 = 'rung-1080p';
  const RUNG_360 = 'rung-360p';

  function makeLadder() {
    const clock = makeClock();
    const seen: FeedState[] = [];
    const tracker = new FeedHealthTracker(clock.now);
    tracker.trackGroup(GROUP, [RUNG_1080, RUNG_360]);
    tracker.subscribe(GROUP, (state) => seen.push(state));

    return { clock, tracker, seen };
  }

  /** Two polls and a clock, never a loop over the constant. See {@link unservedPastWindow}. */
  function goesQuiet(tracker: FeedHealthTracker, clock: { advance: (by: number) => void }, rung: string): void {
    tracker.recordUnservedSlot(rung);
    clock.advance(UNSERVED_SLOT_STALL_MS);
    tracker.recordUnservedSlot(rung);
  }

  it('tells the viewer their own rung has stopped, while the others carry on publishing', () => {
    const { tracker, clock, seen } = makeLadder();
    tracker.watchRung(GROUP, RUNG_1080);

    goesQuiet(tracker, clock, RUNG_1080);

    assert.equal(tracker.state(GROUP), FEED_STATE_STALLED);
    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_STALLED]);
  });

  it('stays quiet when the rung that stopped is not the one being watched', () => {
    const { tracker, clock } = makeLadder();
    tracker.watchRung(GROUP, RUNG_360);

    goesQuiet(tracker, clock, RUNG_1080);

    assert.equal(tracker.state(GROUP), FEED_STATE_LIVE);
  });

  /**
   * ⛔ The constraint the owner attached to this fix. A rung failing to reach a gateway its siblings
   * are reaching is that rung's own flake, and raising the overlay on it is what the agreement rule
   * exists to prevent. Watching the rung must not change that.
   */
  it('keeps the agreement rule for a gateway that one rung alone cannot reach', () => {
    const { tracker } = makeLadder();
    tracker.watchRung(GROUP, RUNG_1080);

    tracker.recordGatewayFailure(RUNG_1080);

    assert.equal(tracker.state(GROUP), FEED_STATE_LIVE);
  });

  it('moving to a living rung takes the overlay back down', () => {
    const { tracker, clock, seen } = makeLadder();
    tracker.watchRung(GROUP, RUNG_1080);
    goesQuiet(tracker, clock, RUNG_1080);

    tracker.watchRung(GROUP, RUNG_360);

    assert.equal(tracker.state(GROUP), FEED_STATE_LIVE);
    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_STALLED, FEED_STATE_LIVE]);
  });

  /** The control. Without a named rung nothing about a ladder's health reads any differently. */
  it('falls back to what every rung agrees on once no rung is named', () => {
    const { tracker, clock } = makeLadder();
    tracker.watchRung(GROUP, RUNG_1080);
    goesQuiet(tracker, clock, RUNG_1080);

    tracker.watchRung(GROUP, null);

    assert.equal(tracker.state(GROUP), FEED_STATE_LIVE, 'rung 360 is still being served');
  });

  /**
   * A player and a poller disagreeing about the shape of the stream. Believing the player would point
   * the overlay at a feed nothing is reading, which never advances and so always reads as stalled.
   */
  it('refuses a rung the ladder does not walk, and keeps the one it had', () => {
    const { tracker, clock } = makeLadder();
    tracker.watchRung(GROUP, RUNG_1080);

    tracker.watchRung(GROUP, 'a-rung-from-some-other-broadcast');
    goesQuiet(tracker, clock, RUNG_1080);

    assert.equal(tracker.state(GROUP), FEED_STATE_STALLED, 'the bogus rung replaced the one being watched');
  });

  it('keeps the watched rung when a poller re-tracks the group it still walks', () => {
    const { tracker, clock } = makeLadder();
    tracker.watchRung(GROUP, RUNG_1080);

    tracker.trackGroup(GROUP, [RUNG_1080, RUNG_360]);
    goesQuiet(tracker, clock, RUNG_1080);

    assert.equal(tracker.state(GROUP), FEED_STATE_STALLED);
  });

  it('forgets the watched rung when the ladder it belonged to is torn down', () => {
    const { tracker, clock } = makeLadder();
    tracker.watchRung(GROUP, RUNG_1080);

    tracker.untrackGroup(GROUP);
    tracker.trackGroup(GROUP, [RUNG_1080, RUNG_360]);
    goesQuiet(tracker, clock, RUNG_1080);

    assert.equal(tracker.state(GROUP), FEED_STATE_LIVE, 'a torn down ladder kept a viewer on one of its rungs');
  });
});

/**
 * ⛔⛔⛔ **A Swarm feed that stops advancing does not error, so hls.js has nothing to react to.**
 *
 * hls.js changes level on a fragment load error. A rung whose transcode has stopped still serves its
 * playlist perfectly, it just never grows, so a player waiting for a segment it was never offered
 * waits for ever. Measured live 2026-08-30 on both byte paths: the viewer stayed on the dead rung for
 * the whole outage and the picture stopped for 87.2 and 103.2 seconds with three healthy rungs beside
 * it. The client already counted the unserved run per rung. Nothing read it.
 *
 * ⛔⛔ **The margin is the whole of the difficulty.** A rung being stalled is not the same question as
 * a rung being dead. When a broadcast stops entirely, its rungs go quiet one after another as each
 * runs out its own last segment, so the first one past the window finds its siblings still reading
 * live and would be judged dead on its own, and so would the next. A ladder that was never broken
 * would strip itself down to one rung. See `RUNG_ALIVE_WITHIN_MS`.
 */
describe('FeedHealthTracker telling a rung that stopped being produced from a broadcast that stopped', () => {
  const GROUP = 'entry-topic-the-viewer-linked';
  const RUNG_1080 = 'rung-1080p';
  const RUNG_360 = 'rung-360p';

  function makeLadder() {
    const clock = makeClock();
    const stopped: string[] = [];
    const tracker = new FeedHealthTracker(clock.now);
    tracker.trackGroup(GROUP, [RUNG_1080, RUNG_360]);
    const unsubscribe = tracker.onRungStopped((rung) => stopped.push(rung));

    return { clock, tracker, stopped, unsubscribe };
  }

  it('announces a rung that has been quiet past the window while a sibling is being served', () => {
    const { tracker, clock, stopped } = makeLadder();

    tracker.recordUnservedSlot(RUNG_1080);
    clock.advance(UNSERVED_SLOT_STALL_MS);
    tracker.recordUnservedSlot(RUNG_1080);

    assert.deepEqual(stopped, [RUNG_1080]);
  });

  it('says nothing while the run is still inside the window', () => {
    const { tracker, clock, stopped } = makeLadder();

    tracker.recordUnservedSlot(RUNG_1080);
    clock.advance(UNSERVED_SLOT_STALL_MS - 1);
    tracker.recordUnservedSlot(RUNG_1080);

    assert.deepEqual(stopped, []);
  });

  /**
   * ⭐⭐⭐ The case the margin exists for, and the one that would have cost a viewer their whole ladder.
   *
   * ⛔ **The first version of this passed against an implementation with no margin at all.** It
   * advanced the clock a full window past the LATER rung, by which point both rungs read as stalled
   * and no sibling was live to judge against, so it agreed with anything. The instant that decides
   * this is the one where the first rung crosses the window while the second is still short of it,
   * and a test of this rule has to stand on that instant. Walking poll by poll is what visits it.
   */
  it('announces nothing when the whole broadcast stops, however staggered the rungs are', () => {
    const { tracker, clock, stopped } = makeLadder();
    const ONE_SEGMENT_MS = 2_000;
    const POLL_MS = 750;

    tracker.recordUnservedSlot(RUNG_1080);
    clock.advance(ONE_SEGMENT_MS);
    tracker.recordUnservedSlot(RUNG_360);

    for (let sinceStop = ONE_SEGMENT_MS; sinceStop < UNSERVED_SLOT_STALL_MS * 2; sinceStop += POLL_MS) {
      clock.advance(POLL_MS);
      tracker.recordUnservedSlot(RUNG_1080);
      tracker.recordUnservedSlot(RUNG_360);
    }

    assert.deepEqual(stopped, [], 'a broadcast that stopped was read as its rungs dying one by one');
    assert.equal(tracker.state(GROUP), FEED_STATE_STALLED, 'and the group should still say so');
  });

  /**
   * The same instant, stood on directly rather than walked to, with the sibling's own state asserted.
   *
   * ⛔ That assertion is what makes this falsifiable. Without it the case passes whenever the sibling
   * happens to have stalled too, which is a run in which nothing was judged at all.
   */
  it('leaves the first rung past the window alone while its sibling still reads live', () => {
    const { tracker, clock, stopped } = makeLadder();
    const ONE_SEGMENT_MS = 2_000;

    tracker.recordUnservedSlot(RUNG_1080);
    clock.advance(ONE_SEGMENT_MS);
    tracker.recordUnservedSlot(RUNG_360);
    clock.advance(UNSERVED_SLOT_STALL_MS - ONE_SEGMENT_MS);
    tracker.recordUnservedSlot(RUNG_1080);

    assert.equal(tracker.state(RUNG_1080), FEED_STATE_STALLED, 'the rung under judgement should have stalled');
    assert.equal(tracker.state(RUNG_360), FEED_STATE_LIVE, 'the sibling should still read live, or nothing is judged');
    assert.deepEqual(stopped, []);
  });

  /**
   * The margin pinned from both sides, by a clock rather than by a loop over the constant. A test
   * that only advanced by `RUNG_ALIVE_WITHIN_MS` would stay green at any value of it, including one
   * that makes the whole rule unreachable.
   */
  it('refuses a sibling whose own silence has reached the margin', () => {
    const { tracker, clock, stopped } = makeLadder();

    tracker.recordUnservedSlot(RUNG_1080);
    clock.advance(UNSERVED_SLOT_STALL_MS - RUNG_ALIVE_WITHIN_MS);
    tracker.recordUnservedSlot(RUNG_360);
    clock.advance(RUNG_ALIVE_WITHIN_MS);
    tracker.recordUnservedSlot(RUNG_1080);

    assert.deepEqual(stopped, []);
  });

  it('accepts a sibling that fell one millisecond short of the margin', () => {
    const { tracker, clock, stopped } = makeLadder();

    tracker.recordUnservedSlot(RUNG_1080);
    clock.advance(UNSERVED_SLOT_STALL_MS - RUNG_ALIVE_WITHIN_MS + 1);
    tracker.recordUnservedSlot(RUNG_360);
    clock.advance(RUNG_ALIVE_WITHIN_MS - 1);
    tracker.recordUnservedSlot(RUNG_1080);

    assert.deepEqual(stopped, [RUNG_1080]);
  });

  it('announces one death once, however many polls it takes', () => {
    const { tracker, clock, stopped } = makeLadder();

    tracker.recordUnservedSlot(RUNG_1080);
    clock.advance(UNSERVED_SLOT_STALL_MS);
    for (let poll = 0; poll < 20; poll++) {
      tracker.recordUnservedSlot(RUNG_1080);
    }

    assert.deepEqual(stopped, [RUNG_1080]);
  });

  it('announces a rung that came back and stopped again', () => {
    const { tracker, clock, stopped } = makeLadder();

    tracker.recordUnservedSlot(RUNG_1080);
    clock.advance(UNSERVED_SLOT_STALL_MS);
    tracker.recordUnservedSlot(RUNG_1080);
    tracker.recordGatewayResponse(RUNG_1080);

    tracker.recordUnservedSlot(RUNG_1080);
    clock.advance(UNSERVED_SLOT_STALL_MS);
    tracker.recordUnservedSlot(RUNG_1080);

    assert.deepEqual(stopped, [RUNG_1080, RUNG_1080]);
  });

  /** A finished broadcast is not a broken rung, and dropping rungs off one helps nobody. */
  it('says nothing about a rung whose broadcast ended', () => {
    const { tracker, clock, stopped } = makeLadder();

    tracker.recordFeedEnded(RUNG_1080);
    tracker.recordUnservedSlot(RUNG_1080);
    clock.advance(UNSERVED_SLOT_STALL_MS);
    tracker.recordUnservedSlot(RUNG_1080);

    assert.deepEqual(stopped, []);
  });

  /** A viewer of a single-rendition stream has nowhere to move to, so there is nothing to say. */
  it('says nothing about a topic that is not a rung of any ladder', () => {
    const clock = makeClock();
    const stopped: string[] = [];
    const tracker = new FeedHealthTracker(clock.now);
    tracker.onRungStopped((rung) => stopped.push(rung));

    unservedPastWindow(tracker, clock);

    assert.equal(tracker.state(TOPIC), FEED_STATE_STALLED, 'the topic should still read as stalled');
    assert.deepEqual(stopped, []);
  });

  it('stops announcing once the listener has gone', () => {
    const { tracker, clock, stopped, unsubscribe } = makeLadder();

    unsubscribe();
    tracker.recordUnservedSlot(RUNG_1080);
    clock.advance(UNSERVED_SLOT_STALL_MS);
    tracker.recordUnservedSlot(RUNG_1080);

    assert.deepEqual(stopped, []);
  });
});
