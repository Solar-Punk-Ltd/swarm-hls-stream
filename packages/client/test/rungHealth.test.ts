import { Topic } from '@ethersphere/bee-js';
import { buildSwarmUri } from '@swarm-hls-stream/shared';
import type Hls from 'hls.js';
import { Events } from 'hls.js';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  FEED_STATE_LIVE,
  FEED_STATE_STALLED,
  FeedHealthTracker,
  RUNG_DEATH_LAG_SEGMENTS,
  UNSERVED_SLOT_STALL_MS,
} from '../src/components/SwarmHlsPlayer/feedState';

/** One segment at the longest stage this project runs, so the clock in these cases is a real one. */
const SEGMENT_MS = 2_000;
import { attachRungFailover, attachWatchedRungReporter } from '../src/components/SwarmHlsPlayer/rungHealth';

const OWNER = '0x1234567890123456789012345678901234567890';
const GROUP = 'the-broadcast-a-viewer-linked-to';

/** The rungs of the ladder this project publishes, tallest first, as the poller names them. */
const RUNG_NAMES = ['rung-1080p', 'rung-720p', 'rung-480p', 'rung-360p'] as const;
const HEIGHTS = [1080, 720, 480, 360] as const;

const hexOf = (rung: string): string => Topic.fromString(rung).toString();

function makeClock() {
  let ms = 0;
  return { now: () => ms, advance: (by: number) => void (ms += by) };
}

/**
 * One rung stops being produced while the rest of its ladder carries on delivering segments.
 *
 * ⛔⛔⛔ **The siblings have to actually be SERVED.** What judges a rung is how many segments the
 * ladder delivered that it did not, so a helper that only advanced a clock sets nothing up at all,
 * and every case built on it would agree with an implementation containing no rule whatsoever. That
 * is not hypothetical: this WAS a clock and two polls, and it is what these cases were standing on
 * while the rule underneath them was got wrong three times running.
 */
function stopPublishing(
  feedHealth: FeedHealthTracker,
  clock: { advance: (by: number) => void },
  deadRung: string,
  stillPublishing: readonly string[],
): void {
  const deadHex = hexOf(deadRung);
  feedHealth.recordUnservedSlot(deadHex);
  for (let segment = 0; segment < RUNG_DEATH_LAG_SEGMENTS; segment++) {
    clock.advance(SEGMENT_MS);
    for (const sibling of stillPublishing) {
      feedHealth.recordGatewayResponse(hexOf(sibling));
    }
    feedHealth.recordUnservedSlot(deadHex);
  }
}

/**
 * A player holding a parsed four rung ladder, and the tracker walking the same four feeds.
 *
 * The double answers what the two attach functions actually touch: the level list, the level
 * currently loading, and the two events. `removeLevel` reproduces hls.js's own behaviour, which is
 * what makes the index question real: it drops the entry, so every level above it shifts down, and
 * it clears the current level when the removed one was playing.
 *
 * ⛔ `walked` and `parsed` are separate because they genuinely come apart. The poller keeps walking
 * every rung of the ladder while hls.js only holds the levels it still has, so after a rung has been
 * dropped the two sets differ, and that is exactly the state the last-rung case has to be set up in.
 */
function makeLadderPlayer({
  walked = RUNG_NAMES,
  parsed = walked,
}: { walked?: readonly string[]; parsed?: readonly string[] } = {}) {
  const clock = makeClock();
  const feedHealth = new FeedHealthTracker(clock.now);
  feedHealth.trackGroup(GROUP, walked.map(hexOf));

  const switchedListeners = new Set<(event: unknown, data: { level: number }) => void>();
  const removed: number[] = [];

  const hls = {
    levels: parsed.map((rung) => ({
      uri: buildSwarmUri(OWNER, rung),
      height: HEIGHTS[RUNG_NAMES.indexOf(rung as (typeof RUNG_NAMES)[number])],
    })),
    loadLevel: 0,
    nextLoadLevel: -1,
    nextAutoLevel: 1,
    removeLevel(index: number) {
      removed.push(index);
      if (this.levels.length === 1) {
        return;
      }
      const wasLoading = index === this.loadLevel;
      this.levels = this.levels.filter((_level, at) => at !== index);
      if (wasLoading) {
        this.loadLevel = -1;
      }
    },
    on(event: string, listener: (event: unknown, data: { level: number }) => void) {
      assert.equal(event, Events.LEVEL_SWITCHED, `the reporter listened for ${event}`);
      switchedListeners.add(listener);
    },
    off(event: string, listener: (event: unknown, data: { level: number }) => void) {
      if (event === Events.LEVEL_SWITCHED) {
        switchedListeners.delete(listener);
      }
    },
  };

  return {
    clock,
    feedHealth,
    hls: hls as unknown as Hls,
    removed,
    heightsLeft: () => hls.levels.map((level) => level.height),
    loadLevel: () => hls.loadLevel,
    setLoadLevel: (level: number) => void (hls.loadLevel = level),
    nextLoadLevel: () => hls.nextLoadLevel,
    switchTo: (level: number) => {
      for (const listener of switchedListeners) {
        listener(Events.LEVEL_SWITCHED, { level });
      }
    },
    /** This player's own ladder losing one rung while every other rung it walks carries on. */
    silence: (rung: string) =>
      stopPublishing(
        feedHealth,
        clock,
        rung,
        walked.filter((other) => other !== rung),
      ),
  };
}

/**
 * ⛔⛔⛔ **A Swarm feed that stops advancing does not error, so hls.js never switches away from it.**
 *
 * Measured live on 2026-08-30, both byte paths, one rung of four silenced under a watching viewer:
 * the player stayed on the dead rung for the whole outage, the picture stopped for 87.2 seconds in
 * the tab and 103.2 through a gateway, and three healthy rungs published beside it throughout.
 * hls.js changes level on a fragment load error, and a rung whose transcode has stopped still serves
 * its playlist perfectly. It just never grows.
 */
describe('dropping a rung that has stopped being produced', () => {
  it('takes the dead rung out of the ladder', () => {
    const player = makeLadderPlayer();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-1080p');

    assert.deepEqual(player.heightsLeft(), [720, 480, 360]);
  });

  /**
   * ⛔ The index a rung sits at is not a property of the rung. hls.js reindexes on every removal, so
   * a second death resolved against a remembered index removes whichever rung has shifted into it.
   */
  it('finds the second dead rung where it now sits, not where it started', () => {
    const player = makeLadderPlayer();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-1080p');
    player.silence('rung-480p');

    assert.deepEqual(player.heightsLeft(), [720, 360]);
  });

  /**
   * Every player on the page hears every announcement, and most of them are about other ladders.
   *
   * ⛔ The other broadcast needs two rungs of its own and one of them has to really be announced. A
   * ladder of one can never announce anything, so a single-rung stand-in would leave this case
   * passing on there being no announcement at all rather than on one being correctly ignored.
   */
  it('ignores a rung this player is not holding', () => {
    const player = makeLadderPlayer();
    const otherDead = 'a-rung-of-someone-elses-broadcast';
    const otherLive = 'the-rung-someone-else-is-watching';
    player.feedHealth.trackGroup('another-broadcast', [otherDead, otherLive].map(hexOf));
    const heard: string[] = [];
    player.feedHealth.onRungStopped((rung) => heard.push(rung));
    attachRungFailover(player.hls, player.feedHealth);

    stopPublishing(player.feedHealth, player.clock, otherDead, [otherLive]);

    assert.deepEqual(heard, [hexOf(otherDead)], 'the other ladder should have announced its own dead rung');
    assert.deepEqual(player.removed, []);
    assert.deepEqual(player.heightsLeft(), [...HEIGHTS]);
  });

  /**
   * A viewer with one rung left is better off frozen on it than left with no ladder at all.
   *
   * ⛔ Asserted on the call rather than on the outcome. hls.js refuses to remove the last level
   * itself, so a test that only checked the level survived would pass with no guard here at all, and
   * the recovery below would then run against a ladder nothing had been taken out of.
   */
  it('leaves the last rung alone, without asking hls.js to drop it', () => {
    // Every other rung has already been dropped, which is where a run of these leaves a player. The
    // poller still walks all four, so a living sibling is what makes the last one judged at all: a
    // ladder of one announces nothing, and this case would then pass with no guard here whatsoever.
    const player = makeLadderPlayer({ parsed: ['rung-1080p'] });
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-1080p');

    assert.deepEqual(player.removed, [], 'the last level was handed to removeLevel anyway');
    assert.deepEqual(player.heightsLeft(), [1080]);
  });

  /**
   * ⛔ hls.js clears the loading level when the removed one was playing and picks no replacement.
   * Left at -1 the player buffers out and stops, which is the freeze this whole change exists to end.
   */
  it('puts the viewer on a living rung when the one they were playing is removed', () => {
    const player = makeLadderPlayer();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-1080p');

    assert.equal(player.loadLevel(), -1, 'the double should reproduce hls.js clearing the loading level');
    assert.equal(player.nextLoadLevel(), 1, 'the viewer was left with no level to load, so the picture stops');
  });

  it('leaves the loading level alone when the dead rung was not the one playing', () => {
    const player = makeLadderPlayer();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-480p');

    assert.equal(player.nextLoadLevel(), -1, 'a viewer watching a healthy rung was steered off it');
  });

  /**
   * ⛔ The other reason `loadLevel` is -1. A player that has not chosen a level yet reads exactly like
   * one whose level was just removed, and steering the first forces a level while hls.js is still
   * settling the ladder. V6 removed a rung from a freshly restarted player on 2026-08-30 and that
   * viewer's playhead never left zero.
   */
  it('does not steer a player that had not chosen a level in the first place', () => {
    const player = makeLadderPlayer();
    player.setLoadLevel(-1);
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-480p');

    assert.deepEqual(player.heightsLeft(), [1080, 720, 360], 'the dead rung should still be dropped');
    assert.equal(player.nextLoadLevel(), -1, 'a player still settling its ladder was forced onto a level');
  });

  it('stops dropping rungs once the player is torn down', () => {
    const player = makeLadderPlayer();
    const detach = attachRungFailover(player.hls, player.feedHealth);

    detach();
    player.silence('rung-1080p');

    assert.deepEqual(player.heightsLeft(), [...HEIGHTS]);
  });
});

/**
 * ⛔⛔⛔ The overlay watches the group topic and nothing else, and a group's health is what its rungs
 * agree on. Three healthy rungs outvote the one the viewer can actually see, which is why a viewer
 * frozen for 87 seconds on a dead rung was told the stream was live for every one of them.
 */
describe('telling the feed health which rung this viewer is on', () => {
  it('names the rung the player switched to', () => {
    const player = makeLadderPlayer();
    attachWatchedRungReporter(player.hls, GROUP, player.feedHealth);

    player.switchTo(0);
    player.silence('rung-1080p');

    assert.equal(player.feedHealth.state(GROUP), FEED_STATE_STALLED);
  });

  it('follows the viewer onto a rung that is still publishing', () => {
    const player = makeLadderPlayer();
    attachWatchedRungReporter(player.hls, GROUP, player.feedHealth);

    player.switchTo(0);
    player.silence('rung-1080p');
    player.switchTo(3);

    assert.equal(player.feedHealth.state(GROUP), FEED_STATE_LIVE);
  });

  /** A level index hls.js no longer holds. Naming nothing is right: naming a wrong rung is not. */
  it('names no rung when the index is past the ladder', () => {
    const player = makeLadderPlayer();
    attachWatchedRungReporter(player.hls, GROUP, player.feedHealth);

    player.switchTo(0);
    player.switchTo(99);
    player.silence('rung-1080p');

    assert.equal(player.feedHealth.state(GROUP), FEED_STATE_LIVE, 'a rung out of range was still being watched');
  });

  it('lets go of the rung when the player is torn down', () => {
    const player = makeLadderPlayer();
    const detach = attachWatchedRungReporter(player.hls, GROUP, player.feedHealth);
    player.switchTo(0);

    detach();
    player.silence('rung-1080p');

    assert.equal(player.feedHealth.state(GROUP), FEED_STATE_LIVE, 'a destroyed player was still choosing the overlay');
  });
});
