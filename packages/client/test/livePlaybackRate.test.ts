import type Hls from 'hls.js';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { attachLivePlaybackRateGuard } from '../src/components/SwarmHlsPlayer/livePlaybackRate';
import { MAX_LIVE_SYNC_PLAYBACK_RATE } from '../src/components/SwarmHlsPlayer/playerConfig';

/** What hls.js writes into `config` to mean "leave the playback rate alone". */
const CATCH_UP_OFF = 1;

/**
 * The two objects the guard sits between: a media element that reports a rate and emits
 * `ratechange`, and the live `hls.config` the latency controller reads on every tick.
 */
function makeGuardedPlayer() {
  const listeners = new Set<() => void>();
  const media = {
    playbackRate: 1,
    addEventListener: (type: string, listener: () => void) => {
      assert.equal(type, 'ratechange', `the guard listened for ${type}, which no rate change emits`);
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  const hls = { config: { maxLiveSyncPlaybackRate: MAX_LIVE_SYNC_PLAYBACK_RATE } };

  const detach = attachLivePlaybackRateGuard(media as unknown as HTMLMediaElement, hls as unknown as Hls);

  return {
    detach,
    catchUpRate: () => hls.config.maxLiveSyncPlaybackRate,
    setRate: (rate: number) => {
      media.playbackRate = rate;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

/**
 * The half of LAT-2 that enabling catch-up creates. hls.js adapts the rate inside one branch, and
 * the else half of that branch writes the rate back to 1 whenever the drift is not worth nudging.
 * The component turns on the browser's native controls, so a viewer choosing 1.5x is put back to 1x
 * within a second, silently, on every live stream. Catch-up is only worth having with this in place.
 */
describe('the live catch-up does not take the viewer speed control away (LAT-2)', () => {
  for (const [name, rate] of [
    ['faster than the catch-up could ever go', 1.5],
    ['at the top of the browser menu', 2],
    ['slower than ordinary speed', 0.5],
    ['barely above the catch-up ceiling', MAX_LIVE_SYNC_PLAYBACK_RATE + 0.01],
  ] as const) {
    it(`stands down when the viewer picks a speed ${name}`, () => {
      const player = makeGuardedPlayer();

      player.setRate(rate);

      assert.equal(player.catchUpRate(), CATCH_UP_OFF, `hls.js would drag ${rate}x back to 1x on the next timeupdate`);
    });
  }

  for (const rate of [1, 1.05, MAX_LIVE_SYNC_PLAYBACK_RATE]) {
    it(`keeps catching up while the rate stays at ${rate}, which is one hls.js writes itself`, () => {
      const player = makeGuardedPlayer();

      player.setRate(rate);

      assert.equal(player.catchUpRate(), MAX_LIVE_SYNC_PLAYBACK_RATE);
    });
  }

  // Standing down permanently would be a second way to lose the feature, and a quieter one: latency
  // would grow again for the rest of the session with nothing to show it had.
  it('starts catching up again once the viewer returns to ordinary speed', () => {
    const player = makeGuardedPlayer();

    player.setRate(1.5);
    player.setRate(1);

    assert.equal(player.catchUpRate(), MAX_LIVE_SYNC_PLAYBACK_RATE);
  });

  it('stops watching a media element the player has let go of', () => {
    const player = makeGuardedPlayer();

    player.detach();
    player.setRate(2);

    assert.equal(player.catchUpRate(), MAX_LIVE_SYNC_PLAYBACK_RATE, 'a detached guard still wrote to a live config');
  });
});
