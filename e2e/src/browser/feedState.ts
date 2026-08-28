/**
 * What the shipped feed-state overlay was telling the viewer, read as a STATE rather than as prose.
 *
 * The client renders one sentence per situation and renders nothing at all while the feed is live.
 * A sample has always carried that sentence, which is the right thing for a report a person reads
 * and the wrong thing for a suite that has to pass or fail on it: the wording is a product decision,
 * so a copy edit would turn a green scenario red while a genuinely broken terminal state stayed green
 * for as long as the words survived.
 *
 * ⛔ An unknown message throws rather than reading as live. That is the rule `readOverlayMetrics`
 * already follows for a renamed label, and for the same reason: the honest answer to "I no longer
 * know what the overlay is saying" is to stop, not to report that it was saying nothing. A viewer
 * suite that read an unrecognised message as live would assert on a feed it could no longer see.
 *
 * The states are mirrored here rather than imported, exactly as `FETCH_BACKEND_HANDLE` is: `e2e` does
 * not depend on `client`, and these are the words the browser puts on screen rather than a value
 * either side computes. `packages/client/src/components/SwarmHlsPlayer/feedState.ts` holds the state
 * names and `overlays/feed/FeedStateOverlay.tsx` holds the messages.
 */

/** The gateway is answering and the overlay renders nothing. */
export const FEED_STATE_LIVE = 'live';
/** The gateway is not answering at all, and attempts are being held off between retries. */
export const FEED_STATE_RECONNECTING = 'reconnecting';
/** The gateway answers but has not served the slot the player waits on, for a long run. */
export const FEED_STATE_STALLED = 'stalled';
/** The gateway serves what it is asked for, more slowly than the player consumes it. */
export const FEED_STATE_DEGRADED = 'degraded';
/** The broadcaster ended the stream. The only terminal state: nothing is left to retry. */
export const FEED_STATE_ENDED = 'ended';

export type ViewerFeedState =
  | typeof FEED_STATE_LIVE
  | typeof FEED_STATE_RECONNECTING
  | typeof FEED_STATE_STALLED
  | typeof FEED_STATE_DEGRADED
  | typeof FEED_STATE_ENDED;

/**
 * The message the overlay renders per state, as `FeedStateOverlay.tsx` writes them.
 *
 * ⛔ Keep in step with that file. A message changed there and not here stops every viewer run at its
 * first sample, loudly, which is the direction this should fail in.
 */
export const FEED_STATE_MESSAGES: Readonly<Record<string, ViewerFeedState>> = {
  'Reconnecting to the stream': FEED_STATE_RECONNECTING,
  'Waiting for the broadcast to continue': FEED_STATE_STALLED,
  'The stream is struggling to keep up': FEED_STATE_DEGRADED,
  'This broadcast has ended': FEED_STATE_ENDED,
};

/**
 * The state behind an overlay reading.
 *
 * @param message The overlay's text, or null where the element was absent. Absent and empty both mean
 *   live: the component returns null for the live state, so there is no element to read.
 * @throws When the message is not one the client is known to render.
 */
export function readFeedState(message: string | null): ViewerFeedState {
  const text = message?.trim() ?? '';
  if (text === '') {
    return FEED_STATE_LIVE;
  }

  const state = FEED_STATE_MESSAGES[text];
  if (state === undefined) {
    throw new Error(
      `the feed-state overlay said ${JSON.stringify(text)}, which is not a message this harness knows. ` +
        'The overlay was reworded or gained a state, and every viewer verdict read out of it is now ' +
        'suspect. Update FEED_STATE_MESSAGES.',
    );
  }
  return state;
}

/** Each state the session passed through, once, in the order the viewer first met it. */
export function feedStatesSeen(states: readonly ViewerFeedState[]): ViewerFeedState[] {
  return [...new Set(states)];
}

/**
 * Every state a session can report, which is the live one plus the four the overlay renders.
 *
 * Derived from {@link FEED_STATE_MESSAGES} rather than listed again, so a state added there cannot be
 * missed here.
 */
const FEED_STATES: readonly ViewerFeedState[] = [FEED_STATE_LIVE, ...Object.values(FEED_STATE_MESSAGES)];

/**
 * Whether a value read back from a state file is one of the states.
 *
 * ⛔ For a reader parsing an artifact rather than a page. A run's states are written by whichever
 * driver produced the file, which may be a newer build than the reader, and a string accepted as a
 * state on trust is how a sixth state would arrive unnoticed in a pass/fail verdict.
 */
export function isViewerFeedState(value: unknown): value is ViewerFeedState {
  return typeof value === 'string' && (FEED_STATES as readonly string[]).includes(value);
}
