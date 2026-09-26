import { useEffect } from 'react';
import useSWR from 'swr';

import { useAppContext } from '@/providers/App';

/** How the latest read of the catalog went, for a page that says so. */
interface CatalogPollState {
  error: unknown;
  isLoading: boolean;
}

/**
 * Reads the catalog again every `pollMs` and hands each answer to the app's stream list.
 *
 * Both pages that poll the catalog come through here, the browse page always and the watch page while
 * its stream has not started or was unpublished while it waited, so they share one SWR key and one
 * poll rather than running two against the gateway. The gateway is part of the key so that a switch
 * starts a fresh fetch rather than inheriting the previous node's answer: `isLoading` is then true
 * again while the new node is being asked, and an `error` belongs to the node now selected instead of
 * the one the viewer has left.
 *
 * @param pollMs How often to read, or null not to read at all, which is SWR's null key.
 */
export function useCatalogPoll(pollMs: number | null): CatalogPollState {
  const { fetchAppState, setNewStreamList, gatewayUrl } = useAppContext();
  const { data, error, isLoading } = useSWR(pollMs === null ? null : ['app-state', gatewayUrl], fetchAppState, {
    revalidateOnFocus: true,
    refreshInterval: pollMs ?? 0,
    dedupingInterval: pollMs ?? 0,
    shouldRetryOnError: true,
  });

  useEffect(() => {
    if (data) setNewStreamList(data);
  }, [data, setNewStreamList]);

  return { error, isLoading };
}
