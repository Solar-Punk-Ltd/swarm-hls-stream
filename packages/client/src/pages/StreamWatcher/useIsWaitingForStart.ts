import { useState } from 'react';

import { Stream } from '@/types/stream';
import { isWaitingForStart } from '@/utils/watchPageView';

/**
 * Whether the watch page is waiting for its stream to start, remembered through stream lists that no
 * longer carry the entry. See `isWaitingForStart` for why the list alone cannot say.
 *
 * Remembered per stream rather than per page, because React Router keeps the page mounted when only
 * the route's parameters change, and waiting on one stream must not show the next one as unavailable.
 * Set during render rather than in an effect, which is how React keeps information from previous
 * renders.
 *
 * @param streamKey Names the stream the page is showing, owner and topic.
 * @param listed The page's entry in the stream list, or undefined when the list does not have it.
 */
export function useIsWaitingForStart(streamKey: string, listed: Pick<Stream, 'state'> | undefined): boolean {
  const [waitingFor, setWaitingFor] = useState<string | null>(null);

  const isWaiting = isWaitingForStart(waitingFor === streamKey, listed);
  const nextWaitingFor = isWaiting ? streamKey : null;
  if (nextWaitingFor !== waitingFor) {
    setWaitingFor(nextWaitingFor);
  }

  return isWaiting;
}
