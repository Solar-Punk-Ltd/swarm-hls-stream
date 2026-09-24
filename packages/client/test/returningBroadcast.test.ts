import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { FeedHealthTracker } from '../src/components/SwarmHlsPlayer/feedState';
import {
  attachReturningBroadcastRejoin,
  bufferedAheadOf,
  hasReachedEndOfPlayback,
  type PlaybackPosition,
} from '../src/components/SwarmHlsPlayer/returningBroadcast';

const TOPIC = 'the-broadcast-this-viewer-linked-to';

/** A player that ran out of media, which is where a viewer who watched the broadcast end is left. */
const ENDED: PlaybackPosition = { isEnded: true, isPaused: true, bufferedAheadS: 0 };

/** A viewer still watching the recording, well short of the end of what they hold. */
const WATCHING_FURTHER_BACK: PlaybackPosition = { isEnded: false, isPaused: false, bufferedAheadS: 40 };

/**
 * ⛔ The rule that keeps the fix from costing a viewer their place. A broadcast that comes back is
 * joined by restarting the player at the live edge, and a restart takes a viewer who is still
 * watching the recording further back away from it. So the restart waits for the viewer to reach the
 * end of what they were playing.
 *
 * Written in seconds rather than against the margin constant, for the reason the backoff schedule in
 * `feedState.test.ts` gives: a test driven off the constant compares it only to itself.
 */
describe('whether a viewer has reached the end of what they were playing', () => {
  it('has, once the element has ended', () => {
    assert.equal(hasReachedEndOfPlayback(ENDED), true);
  });

  it('has, when paused at the very end of what it holds', () => {
    assert.equal(hasReachedEndOfPlayback({ isEnded: false, isPaused: true, bufferedAheadS: 0 }), true);
  });

  it('has, when paused a fraction of a second short of it', () => {
    assert.equal(hasReachedEndOfPlayback({ isEnded: false, isPaused: true, bufferedAheadS: 0.4 }), true);
  });

  it('has not, when paused with more than half a second still to watch', () => {
    assert.equal(hasReachedEndOfPlayback({ isEnded: false, isPaused: true, bufferedAheadS: 0.6 }), false);
  });

  it('has not, when paused far back in the recording', () => {
    assert.equal(hasReachedEndOfPlayback({ isEnded: false, isPaused: true, bufferedAheadS: 40 }), false);
  });

  /** A viewer mid playback is still watching, whatever the buffer says, and `ended` comes when it ends. */
  it('has not, while still playing', () => {
    assert.equal(hasReachedEndOfPlayback({ isEnded: false, isPaused: false, bufferedAheadS: 0 }), false);
  });

  /** A viewer paused where nothing is held has sought somewhere, not reached the end. */
  it('has not, when paused somewhere nothing is buffered', () => {
    assert.equal(hasReachedEndOfPlayback({ isEnded: false, isPaused: true, bufferedAheadS: null }), false);
  });
});

/** A `TimeRanges` over the given spans, which is all the rule reads from an element's buffer. */
function timeRanges(...spans: [number, number][]): TimeRanges {
  return {
    length: spans.length,
    start: (index: number) => spans[index][0],
    end: (index: number) => spans[index][1],
  };
}

describe('how much is held ahead of the playhead', () => {
  it('reads to the end of the range the playhead is in', () => {
    assert.equal(bufferedAheadOf(timeRanges([0, 10], [20, 30]), 25), 5);
  });

  it('reads nothing ahead at the very end of a range', () => {
    assert.equal(bufferedAheadOf(timeRanges([0, 10]), 10), 0);
  });

  it('reads no range at all in a gap between two', () => {
    assert.equal(bufferedAheadOf(timeRanges([0, 10], [20, 30]), 15), null);
  });

  it('reads no range at all with nothing buffered', () => {
    assert.equal(bufferedAheadOf(timeRanges(), 0), null);
  });
});

type MediaEventName = 'ended' | 'pause' | 'seeked';

/**
 * A media element whose position a test moves, emitting the events the rejoin listens for, keyed on
 * the type as a real one is. Built the way `playbackHealth.test.ts` builds its own, and for the reason
 * given there: a double that ran every listener on every event would pass a rejoin listening for the
 * wrong one.
 */
function makePlayer(start: PlaybackPosition) {
  let position = start;
  const listeners = new Map<string, Set<() => void>>();
  const media = {
    get ended() {
      return position.isEnded;
    },
    get paused() {
      return position.isPaused;
    },
    get currentTime() {
      return 100;
    },
    get buffered() {
      return position.bufferedAheadS === null ? timeRanges() : timeRanges([0, 100 + position.bufferedAheadS]);
    },
    addEventListener: (type: string, listener: () => void) => {
      const forType = listeners.get(type) ?? new Set<() => void>();
      forType.add(listener);
      listeners.set(type, forType);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
  };

  const tracker = new FeedHealthTracker(() => 0);
  let rejoins = 0;
  const detach = attachReturningBroadcastRejoin(media as unknown as HTMLMediaElement, tracker, TOPIC, () => {
    rejoins += 1;
  });

  return {
    tracker,
    detach,
    rejoins: () => rejoins,
    listenerCount: () => [...listeners.values()].reduce((total, forType) => total + forType.size, 0),
    moveTo: (next: PlaybackPosition, ...events: MediaEventName[]) => {
      position = next;
      for (const event of events) {
        for (const listener of [...(listeners.get(event) ?? [])]) {
          listener();
        }
      }
    },
  };
}

describe('rejoining a broadcast that has come back', () => {
  /** The viewer of 2026-09-24, who watched the end and was left paused on it. */
  it('rejoins at once when the viewer had already reached the end', () => {
    const player = makePlayer(ENDED);

    player.tracker.recordFeedResumed(TOPIC);

    assert.equal(player.rejoins(), 1);
  });

  it('leaves a viewer still watching further back where they are, until they reach the end', () => {
    const player = makePlayer(WATCHING_FURTHER_BACK);

    player.tracker.recordFeedResumed(TOPIC);
    assert.equal(player.rejoins(), 0, 'a viewer watching the recording was pulled to the live edge');

    player.moveTo(ENDED, 'pause', 'ended');

    assert.equal(player.rejoins(), 1);
  });

  /** Pausing near the end without the element ending, then seeking to it, both count as reaching it. */
  it('rejoins a paused viewer who seeks to the end of what they hold', () => {
    const player = makePlayer({ isEnded: false, isPaused: true, bufferedAheadS: 30 });
    player.tracker.recordFeedResumed(TOPIC);

    player.moveTo({ isEnded: false, isPaused: true, bufferedAheadS: 0 }, 'seeked');

    assert.equal(player.rejoins(), 1);
  });

  it('does not rejoin on a pause that is not at the end', () => {
    const player = makePlayer(WATCHING_FURTHER_BACK);
    player.tracker.recordFeedResumed(TOPIC);

    player.moveTo({ isEnded: false, isPaused: true, bufferedAheadS: 30 }, 'pause');

    assert.equal(player.rejoins(), 0);
  });

  /** Nothing changes for a broadcast that never comes back: the viewer stays on the end. */
  it('never rejoins a broadcast that did not come back', () => {
    const player = makePlayer(WATCHING_FURTHER_BACK);

    player.moveTo(ENDED, 'pause', 'ended');
    player.tracker.recordFeedEnded(TOPIC);
    player.tracker.recordGatewayResponse(TOPIC);

    assert.equal(player.rejoins(), 0);
  });

  it('ignores a different broadcast coming back', () => {
    const player = makePlayer(ENDED);

    player.tracker.recordFeedResumed('a-rung-or-another-broadcast');

    assert.equal(player.rejoins(), 0);
  });

  /** Every rung of a ladder announces its own return, and the group is told once per rung. */
  it('rejoins once, however many times the return is announced', () => {
    const player = makePlayer(ENDED);

    player.tracker.recordFeedResumed(TOPIC);
    player.tracker.recordFeedResumed(TOPIC);
    player.moveTo(ENDED, 'ended', 'pause', 'seeked');

    assert.equal(player.rejoins(), 1);
  });

  it('leaves nothing attached to a player that has been torn down', () => {
    const player = makePlayer(WATCHING_FURTHER_BACK);
    assert.ok(player.listenerCount() > 0, 'the rejoin never attached to anything');

    player.detach();
    player.tracker.recordFeedResumed(TOPIC);
    player.moveTo(ENDED, 'pause', 'ended');

    assert.equal(player.listenerCount(), 0);
    assert.equal(player.rejoins(), 0);
  });
});
