import React from 'react';

import { FEED_STATE_LIVE, FEED_STATE_RECONNECTING, FEED_STATE_STALLED, FeedState } from '../../feedState';

import './FeedStateOverlay.scss';

/**
 * What each state is called on screen. Two messages rather than one, because the two situations ask
 * different things of the viewer: a gateway that is not answering usually comes back on its own, and
 * a feed that has stopped advancing while its gateway answers usually does not.
 */
const MESSAGE: Record<Exclude<FeedState, typeof FEED_STATE_LIVE>, string> = {
  [FEED_STATE_RECONNECTING]: 'Reconnecting to the stream',
  [FEED_STATE_STALLED]: 'Waiting for the broadcast to continue',
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
      <span className="swarm-hls-feed-state__dot" aria-hidden="true" />
      {MESSAGE[state]}
    </div>
  );
};
