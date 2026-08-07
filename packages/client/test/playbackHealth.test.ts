import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { attachPlaybackStallReporter } from '../src/components/SwarmHlsPlayer/playbackHealth';

type MediaEventName = 'playing' | 'waiting' | 'ended';

/**
 * A media element that emits the three events the reporter listens for, keyed on the type as a real
 * one is. A double that adds and removes whatever it is handed reports a reporter listening for the
 * wrong event as working, and a reporter that hears no event is exactly the defect under test.
 */
function makeWatchedPlayer() {
  const listeners = new Map<string, Set<() => void>>();
  const media = {
    addEventListener: (type: string, listener: () => void) => {
      const forType = listeners.get(type) ?? new Set<() => void>();
      forType.add(listener);
      listeners.set(type, forType);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
  };

  let stalls = 0;
  const detach = attachPlaybackStallReporter(media as unknown as HTMLMediaElement, () => {
    stalls += 1;
  });

  return {
    detach,
    stalls: () => stalls,
    listenerCount: () => [...listeners.values()].reduce((total, forType) => total + forType.size, 0),
    emit: (...events: MediaEventName[]) => {
      for (const event of events) {
        for (const listener of [...(listeners.get(event) ?? [])]) {
          listener();
        }
      }
    },
  };
}

/**
 * The signal behind the `degraded` feed state, taken from the media element rather than from hls.js.
 *
 * Deliberately the same counter the bench reports are denominated in: `rebufferCount` there is a
 * `waiting` after the first `playing`, de-duplicated per stall, so the burst threshold in
 * `feedState.ts` is measured in the units this produces rather than translated into them.
 */
describe('reporting a stalled picture to the feed state', () => {
  it('counts a picture that stopped once playback had started', () => {
    const player = makeWatchedPlayer();

    player.emit('playing', 'waiting');

    assert.equal(player.stalls(), 1);
  });

  /**
   * Startup is buffering, not a fault, and a viewer who has not seen a frame yet does not need to be
   * told the stream is unsteady. Without this the overlay appears on the join of every stream, which
   * is the one moment `waiting` is guaranteed.
   */
  it('does not count the buffering every stream does before its first frame', () => {
    const player = makeWatchedPlayer();

    player.emit('waiting', 'waiting', 'waiting', 'waiting');

    assert.equal(player.stalls(), 0);
  });

  /**
   * One stall is one stall however many times the element says so. Chrome emits `waiting` again
   * whenever a seek or a rate change lands inside the same starved buffer, and counting each of them
   * would let a single stall trip a burst threshold on its own.
   */
  it('counts one stall once, however many times the element repeats itself', () => {
    const player = makeWatchedPlayer();

    player.emit('playing', 'waiting', 'waiting', 'waiting');

    assert.equal(player.stalls(), 1);
  });

  it('counts the next stall after the picture came back', () => {
    const player = makeWatchedPlayer();

    player.emit('playing', 'waiting', 'playing', 'waiting');

    assert.equal(player.stalls(), 2);
  });

  /**
   * A finished broadcast starves its buffer exactly as a failing one does. The feed state has its own
   * terminal `ended`, and a stall counted here on the way out competes with it for the last thing a
   * viewer is told.
   */
  it('stops counting once the broadcast has ended', () => {
    const player = makeWatchedPlayer();

    player.emit('playing', 'ended', 'waiting', 'waiting');

    assert.equal(player.stalls(), 0);
  });

  it('leaves nothing attached to a player that has been torn down', () => {
    const player = makeWatchedPlayer();
    assert.ok(player.listenerCount() > 0, 'the reporter never attached to anything');

    player.detach();

    assert.equal(player.listenerCount(), 0);
    player.emit('playing', 'waiting');
    assert.equal(player.stalls(), 0);
  });
});
