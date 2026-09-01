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
  /** Rungs currently believed dead, by topic. Held here so a second death composes with the first. */
  const dead = new Set<string>();

  const detachStopped = feedHealth.onRungStopped((rungTopicId) => {
    if (levelIndexOfRung(hls, rungTopicId) < 0) {
      return;
    }
    dead.add(rungTopicId);
    // ⛔ The arithmetic that condemned it, in the line that announces it. A warning saying only that
    // a rung stopped cannot be checked against the broadcast afterwards, and on 2026-08-31 that cost
    // two sittings: the client dropped three healthy rungs, said so four times, and nothing it said
    // could distinguish a wrong count from a wrong rule.
    reconcileLadder(hls, dead, `${feedHealth.ladderLagOf(rungTopicId)} segments behind the ladder`);
  });

  const detachResumed = feedHealth.onRungResumed((rungTopicId) => {
    if (!dead.delete(rungTopicId)) {
      return;
    }
    reconcileLadder(hls, dead, 'publishing again');
  });

  return () => {
    detachStopped();
    detachResumed();
  };
}

/** `autoLevelCapping`'s own value for "ABR may pick anything". */
const NO_CAP = -1;

/**
 * Put the ladder into the shape the dead set implies, and say what changed.
 *
 * ⛔⛔⛔ **Capping is preferred over removing because removing cannot be undone.** hls.js has
 * `removeLevel` and no way to put a level back, so a viewer who sat through one outage used to be
 * held below their bandwidth for the rest of the session while the rung published happily beside
 * them. `autoLevelCapping` is one number, ABR obeys it, and setting it back to {@link NO_CAP} restores
 * the rung the moment it publishes again.
 *
 * ⚠️ **A cap excludes everything ABOVE it too, so it only fits a dead run at the TOP of the ladder.**
 * That is the case that actually happens: rungs are announced in bitrate order and the tallest is the
 * one that starves first. A dead rung with a live one above it cannot be expressed as a cap, and
 * falls back to `removeLevel` with the loss stated in the log rather than being papered over.
 */
function reconcileLadder(hls: Hls, dead: ReadonlySet<string>, why: string): void {
  const indices = deadLevelIndices(hls, dead);

  if (indices.length === 0) {
    if (hls.autoLevelCapping !== NO_CAP) {
      hls.autoLevelCapping = NO_CAP;
      console.warn(`Every rung is producing again (${why}), so the whole ladder is available`);
    }
    return;
  }

  if (indices.length >= hls.levels.length || hls.levels.length < MIN_LEVELS_TO_DROP_ONE) {
    console.warn(`Rung ${heightAt(hls, indices[0])}p has stopped being produced (${why}) and there is nowhere to move`);
    return;
  }

  if (isTopOfLadder(indices, hls.levels.length)) {
    const cap = indices[0] - 1;
    const heights = indices.map((index) => `${heightAt(hls, index)}p`).join(', ');
    console.warn(`Rung ${heights} has stopped being produced (${why}), capping the ladder at ${heightAt(hls, cap)}p`);
    hls.autoLevelCapping = cap;
    // Capping steers what ABR picks NEXT and does not move a player already loading an excluded
    // level, which is the dead one. Left there it buffers out and stops, which is the freeze this
    // exists to end. `nextAutoLevel` is ABR's own choice under the cap just set.
    if (hls.loadLevel > cap) {
      hls.nextLoadLevel = hls.nextAutoLevel;
    }
    return;
  }

  // A dead rung with a live one above it. Not expressible as a cap, so it goes the old way and the
  // log says the cost out loud, because this viewer will not get that rung back without a reload.
  const index = indices[0];
  const tookThePlayingLevel = hls.loadLevel === index;
  console.warn(
    `Rung ${heightAt(hls, index)}p has stopped being produced (${why}) with a taller rung still live, ` +
      `so it is dropped rather than capped and will not return to this viewer`,
  );
  hls.removeLevel(index);
  if (tookThePlayingLevel) {
    hls.nextLoadLevel = hls.nextAutoLevel;
  }

  // ⛔ Every level above the removed one has shifted down, so a cap set against the old indices now
  // points at a different rung. Run again on the shortened ladder: any rung still dead is re-resolved
  // and the cap recomputed. Terminates because each pass through here removes exactly one level.
  reconcileLadder(hls, dead, why);
}

/** Ascending indices of levels the ladder still holds whose rung is in the dead set. */
function deadLevelIndices(hls: Hls, dead: ReadonlySet<string>): number[] {
  const indices: number[] = [];
  hls.levels.forEach((level, index) => {
    const topic = rungTopicOfLevel(level.uri);
    if (topic !== null && dead.has(topic)) {
      indices.push(index);
    }
  });
  return indices;
}

/** Whether these indices are an unbroken run reaching the top level, which is what a cap can express. */
function isTopOfLadder(indices: readonly number[], levelCount: number): boolean {
  return indices[indices.length - 1] === levelCount - 1 && indices[0] + indices.length === levelCount;
}

function heightAt(hls: Hls, index: number): number | undefined {
  return hls.levels[index]?.height;
}
