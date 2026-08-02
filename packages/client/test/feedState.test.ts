import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  backoffDelayMs,
  FEED_STATE_LIVE,
  FEED_STATE_RECONNECTING,
  FEED_STATE_STALLED,
  FeedHealthTracker,
  type FeedState,
  TRACKED_TOPIC_LIMIT,
  UNSERVED_SLOT_POLL_LIMIT,
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
  it('doubles the wait per consecutive failure and stops at half a minute', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map(backoffDelayMs), [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
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
    const { tracker, seen, watch } = makeTracker();
    watch();

    for (let poll = 0; poll < UNSERVED_SLOT_POLL_LIMIT - 1; poll++) {
      tracker.recordUnservedSlot(TOPIC);
    }
    assert.deepEqual(seen, [FEED_STATE_LIVE], 'a viewer who had merely caught up was told something was wrong');

    tracker.recordUnservedSlot(TOPIC);

    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_STALLED]);
  });

  // Deliberate, and the reason the two runs are counted apart. A caught-up viewer sees an unserved
  // slot on nearly every poll and has to keep asking at full cadence to get the next segment when it
  // lands. Backing that off would add latency to the healthy case to describe the unhealthy one.
  it('never holds off a poll over an unserved slot, however long the run', () => {
    const { tracker } = makeTracker();

    for (let poll = 0; poll < UNSERVED_SLOT_POLL_LIMIT * 2; poll++) {
      tracker.recordUnservedSlot(TOPIC);
    }

    assert.equal(tracker.state(TOPIC), FEED_STATE_STALLED);
    assert.equal(tracker.backoffRemainingMs(TOPIC), 0);
  });

  it('ends a stalled run on the first slot that is served', () => {
    const { tracker, seen, watch } = makeTracker();
    watch();

    for (let poll = 0; poll < UNSERVED_SLOT_POLL_LIMIT; poll++) {
      tracker.recordUnservedSlot(TOPIC);
    }
    tracker.recordGatewayResponse(TOPIC);

    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_STALLED, FEED_STATE_LIVE]);
  });

  it('reports a gateway that stopped answering mid-stall as the reconnection it is', () => {
    const { tracker } = makeTracker();

    for (let poll = 0; poll < UNSERVED_SLOT_POLL_LIMIT; poll++) {
      tracker.recordUnservedSlot(TOPIC);
    }
    tracker.recordGatewayFailure(TOPIC);

    assert.equal(tracker.state(TOPIC), FEED_STATE_RECONNECTING);
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
