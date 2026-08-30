import { Topic } from '@ethersphere/bee-js';
import { SWARM_SCHEME } from '@swarm-hls-stream/shared';
import type Hls from 'hls.js';
import { Events } from 'hls.js';

import type { FeedHealthTracker } from './feedState';
import { parseSwarmUri } from './playlist';

/**
 * The player's side of a ladder's per-rung health: which rung this viewer is on, and what to do when
 * one of them stops being produced.
 *
 * ⛔⛔⛔ **A Swarm feed that stops advancing does not error.** hls.js changes level on a fragment load
 * error, and a feed that has simply stopped offering fragments raises none: the playlist still loads,
 * it just never grows. So a player waiting for a segment it was never offered has nothing to react
 * to. Measured live 2026-08-30 on both byte paths: one rung of four was silenced under a watching
 * viewer, the player stayed on it for the whole outage, the picture stopped for 87 and 103 seconds,
 * and three healthy rungs published beside it the entire time.
 *
 * The client already knew. `FeedHealthTracker` counts an unserved run per rung, and the poller
 * records one on every poll. Nothing read it.
 */

/** Below this a ladder has no spare rung, and hls.js refuses to remove the last level anyway. */
const MIN_LEVELS_TO_DROP_ONE = 2;

/**
 * The feed a parsed level reads from, or null when its URI is not one of ours.
 *
 * Null rather than a guess. `parseSwarmUri` splits any string it is handed, so a level pointing at an
 * ordinary URL would come back with a path segment as its topic and hash into a feed nobody is
 * walking, which reads exactly like a rung that has never been served.
 */
function rungTopicOfLevel(uri: string): string | null {
  if (!uri.startsWith(SWARM_SCHEME)) {
    return null;
  }
  const { topic } = parseSwarmUri(uri);
  if (!topic) {
    return null;
  }
  try {
    return Topic.fromString(topic).toString();
  } catch (error) {
    console.warn('A parsed level names a topic that is not usable:', uri, error);
    return null;
  }
}

/** Where a rung sits in the ladder hls.js currently holds, or -1 when it holds no such rung. */
function levelIndexOfRung(hls: Hls, rungTopicId: string): number {
  return hls.levels.findIndex((level) => rungTopicOfLevel(level.uri) === rungTopicId);
}

/**
 * Tell the feed health which rung this viewer is playing, so a fault on it reaches the overlay.
 *
 * ⛔ The overlay subscribes to the group topic, the only one a viewer's link carries, and a group's
 * health is what its rungs agree on. That is right for reaching the gateway and wrong for a feed that
 * has stopped: three healthy rungs outvote the one the viewer can actually see. See
 * `FeedHealthTracker.watchRung`.
 */
export function attachWatchedRungReporter(hls: Hls, groupHexTopic: string, feedHealth: FeedHealthTracker): () => void {
  const report = (_event: unknown, data: { level: number }): void => {
    const level = hls.levels[data.level];
    feedHealth.watchRung(groupHexTopic, level ? rungTopicOfLevel(level.uri) : null);
  };

  hls.on(Events.LEVEL_SWITCHED, report);

  return () => {
    hls.off(Events.LEVEL_SWITCHED, report);
    feedHealth.watchRung(groupHexTopic, null);
  };
}

/**
 * Take a rung out of the ladder once it has stopped being produced, so ABR stops choosing it.
 *
 * ⛔⛔ **Removing it is the only thing that lasts.** Reporting the dead rung's playlist as a load error
 * instead was tried on paper and does not hold: hls.js retries twice, switches away by setting
 * `nextAutoLevel`, and then clears that on the first fragment that loads, so ABR is free to pick the
 * dead rung again on the very next segment. On a link fast enough to afford it, that is a viewer
 * oscillating on a three second period for the rest of the broadcast. `removeLevel` is what hls.js
 * itself uses for a level it has decided is unusable, and unlike pinning a level it leaves ABR on.
 *
 * ⚠️ **A removed rung does not come back within the session.** hls.js has no API to put a level back,
 * so a rung that resumes publishing is available again only to viewers who join afterwards. The
 * alternative is rebuilding the player, which costs the viewer their place in a live stream to
 * recover a rung they are not watching.
 */
export function attachRungFailover(hls: Hls, feedHealth: FeedHealthTracker): () => void {
  return feedHealth.onRungStopped((rungTopicId) => {
    const index = levelIndexOfRung(hls, rungTopicId);
    if (index < 0) {
      return;
    }

    const level = hls.levels[index];
    if (hls.levels.length < MIN_LEVELS_TO_DROP_ONE) {
      console.warn(
        `Rung ${level.height}p has stopped being produced and is the only one left, so playback stays on it`,
      );
      return;
    }

    // ⛔ Read BEFORE the removal, because the removal is what sets `loadLevel` to -1 and the two
    // reasons it can be -1 must not be confused. A player that has not chosen a level yet is also at
    // -1, and steering that one forces a level while hls.js is still settling the ladder. Only a
    // viewer whose own rung was just taken away needs somewhere to go.
    const tookThePlayingLevel = hls.loadLevel === index;

    console.warn(`Rung ${level.height}p has stopped being produced, dropping it from the ladder`);
    hls.removeLevel(index);

    // hls.js clears the current level when the removed one was playing, and nothing else picks a
    // replacement. Left at -1 the player buffers out and stops, which is the freeze this exists to
    // end. `nextAutoLevel` is ABR's own choice among what is left, so the viewer lands on the best
    // rung they can carry rather than on the bottom of the ladder.
    if (tookThePlayingLevel) {
      hls.nextLoadLevel = hls.nextAutoLevel;
    }
  });
}
