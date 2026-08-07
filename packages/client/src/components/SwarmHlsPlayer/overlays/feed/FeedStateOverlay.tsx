import React from 'react';

import {
  FEED_STATE_ENDED,
  FEED_STATE_LIVE,
  FEED_STATE_RECONNECTING,
  FEED_STATE_STALLED,
  FeedState,
} from '../../feedState';

import './FeedStateOverlay.scss';

/**
 * What each state is called on screen. One message per situation rather than one for all of them,
 * because they ask different things of the viewer: a gateway that is not answering usually comes
 * back on its own, a feed that has stopped advancing while its gateway answers usually does not, and
 * a broadcast that has ended is never coming back.
 */
const MESSAGE: Record<Exclude<FeedState, typeof FEED_STATE_LIVE>, string> = {
  [FEED_STATE_RECONNECTING]: 'Reconnecting to the stream',
  [FEED_STATE_STALLED]: 'Waiting for the broadcast to continue',
  [FEED_STATE_ENDED]: 'This broadcast has ended',
};

interface FeedStateOverlayProps {
  state: FeedState;
}

/**
 * Says why the picture has stopped, while the player keeps retrying behind it.
 *
 * Deliberately not an error and not dismissable. The stream is not over and there is nothing for the
 * viewer to do: attempts continue on a backoff and the overlay goes away on its own when one
 * succeeds. Before this, the only thing a viewer saw was the picture freezing and then a decoder
 * error once the buffer ran dry, which points at the wrong thing entirely.
 */
export const FeedStateOverlay: React.FC<FeedStateOverlayProps> = ({ state }) => {
  if (state === FEED_STATE_LIVE) {
    return null;
  }

  return (
    <div className="swarm-hls-feed-state" role="status" aria-live="polite">
      {/* The pulsing dot means something is still being attempted, so an ended broadcast does not
          get one. It is the only state here that a viewer can act on by leaving. */}
      {state !== FEED_STATE_ENDED && <span className="swarm-hls-feed-state__dot" aria-hidden="true" />}
      {MESSAGE[state]}
    </div>
  );
};
