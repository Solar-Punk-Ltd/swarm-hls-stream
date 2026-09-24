import type { FeedHealthTracker } from './feedState';

/**
 * The player's side of a broadcast that comes back after it ended: when to rejoin it.
 *
 * ⛔⛔ **Rejoining costs a viewer their place, so it waits for them to have nothing left to lose.** A
 * broadcast that comes back is joined through the player's existing restart, which bootstraps every
 * feed at the live edge. That is exactly right for the viewer of 2026-09-24, who watched the end and
 * was left paused on it, and exactly wrong for a viewer still watching the recording further back,
 * whom it would pull away from what they are watching. So the restart happens only once the viewer
 * has reached the end of what they were playing, which is the one place both viewers meet.
 */

/**
 * How near the end of what it holds a paused player has to be to count as having watched all of it.
 *
 * Half of the one second segment the stage has published since 2026-09-01. A viewer paused inside it
 * has seen everything but part of one segment, so moving them to the live edge takes nothing from
 * them. A player that simply ran out of media stops within a frame or two of the end of its buffer,
 * far inside this. A viewer paused anywhere earlier still holds half a second or more they have not
 * watched, and that viewer is the one this exists not to move.
 */
export const END_OF_PLAYBACK_MARGIN_S = 0.5;

/** What the rule reads off a media element, so that it can be decided without one. */
export interface PlaybackPosition {
  readonly isEnded: boolean;
  readonly isPaused: boolean;
  /** Seconds held ahead of the playhead in the buffered range it sits in, or null when it sits in none. */
  readonly bufferedAheadS: number | null;
}

/**
 * Whether this viewer has reached the end of what they were playing, and so loses nothing to a
 * restart at the live edge.
 *
 * `ended` is the ordinary way there. hls.js 1.6.15 ends the media source once a finished playlist's
 * last fragment is appended (`_streamEnded`, then `BUFFER_EOS`), so a viewer who watched the broadcast
 * finish is left on an element that has ended and paused, which fits the viewer of 2026-09-24. Paused
 * at the end of what is held is the other way, for a viewer who stopped there themselves.
 *
 * ⚠️ Still playing is never the end, however little is held. A player waiting on a fragment of the
 * recording it is watching looks exactly like one that has run out, and moving it would be the one
 * mistake this rule is here to avoid.
 */
export function hasReachedEndOfPlayback(position: PlaybackPosition): boolean {
  if (position.isEnded) {
    return true;
  }
  return position.isPaused && position.bufferedAheadS !== null && position.bufferedAheadS <= END_OF_PLAYBACK_MARGIN_S;
}

/** Seconds buffered ahead of `at` in the range that holds it, or null when no range does. */
export function bufferedAheadOf(buffered: TimeRanges, at: number): number | null {
  for (let index = 0; index < buffered.length; index++) {
    if (at >= buffered.start(index) && at <= buffered.end(index)) {
      return buffered.end(index) - at;
    }
  }
  return null;
}

function playbackPositionOf(media: HTMLMediaElement): PlaybackPosition {
  return {
    isEnded: media.ended,
    isPaused: media.paused,
    bufferedAheadS: bufferedAheadOf(media.buffered, media.currentTime),
  };
}

/**
 * The element events after which a viewer may have reached the end, which is when a return that
 * arrived earlier is looked at again. `pause` comes before `ended` at the end of media, and `seeked`
 * is a paused viewer moving to the end by hand.
 */
const END_OF_PLAYBACK_EVENTS = ['ended', 'pause', 'seeked'] as const;

/**
 * Rejoin the live broadcast once it has come back and this viewer has reached the end of what they
 * were playing, whichever of the two happens last.
 *
 * Listens for {@link FeedHealthTracker.onFeedResumed} rather than for the feed state leaving `ended`,
 * because an eviction leaves it too. A rejoin on that would restart the viewer into the finished
 * recording from its first second, which is the one change a broadcast that never comes back must not
 * see.
 *
 * @param topicId The topic this player's link names, which is the one a ladder's return is announced
 *   on as well as a single rendition's.
 * @param rejoin Called at most once. The player restarts itself through it, which tears this down.
 */
export function attachReturningBroadcastRejoin(
  media: HTMLMediaElement,
  feedHealth: FeedHealthTracker,
  topicId: string,
  rejoin: () => void,
): () => void {
  let hasReturned = false;
  let hasRejoined = false;

  const rejoinAtTheEnd = (): void => {
    if (!hasReturned || hasRejoined || !hasReachedEndOfPlayback(playbackPositionOf(media))) {
      return;
    }
    hasRejoined = true;
    rejoin();
  };

  const stopListening = feedHealth.onFeedResumed((resumedTopicId) => {
    if (resumedTopicId !== topicId) {
      return;
    }
    hasReturned = true;
    rejoinAtTheEnd();
  });
  for (const event of END_OF_PLAYBACK_EVENTS) {
    media.addEventListener(event, rejoinAtTheEnd);
  }

  return () => {
    stopListening();
    for (const event of END_OF_PLAYBACK_EVENTS) {
      media.removeEventListener(event, rejoinAtTheEnd);
    }
  };
}
