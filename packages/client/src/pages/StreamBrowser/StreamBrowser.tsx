import { useEffect } from 'react';
import useSWR from 'swr';

import { StreamList } from '@/components/StreamList/StreamList';
import { useAppContext } from '@/providers/App';
import { CATALOG_POLL_INTERVAL_MS } from '@/providers/catalogPoll';

import { CATALOG_VIEW_MESSAGE, catalogViewFrom } from './catalogView';

import './StreamBrowser.scss';

export function StreamBrowser() {
  const { fetchAppState, setNewStreamList, streamList, isStreamListFromCurrentGateway, gatewayUrl } = useAppContext();
  // `error` and `isLoading` used to be dropped here, which is why a gateway nobody could reach looked
  // exactly like a gateway with nothing on it.
  //
  // The gateway is part of the key so that a switch starts a fresh fetch rather than inheriting the
  // previous node's answer: `isLoading` is then true again while the new node is being asked, and an
  // `error` belongs to the node now selected instead of the one the viewer has left.
  const { data, error, isLoading } = useSWR(['app-state', gatewayUrl], fetchAppState, {
    revalidateOnFocus: true,
    refreshInterval: CATALOG_POLL_INTERVAL_MS,
    dedupingInterval: CATALOG_POLL_INTERVAL_MS,
    shouldRetryOnError: true,
  });

  useEffect(() => {
    if (data) setNewStreamList(data);
  }, [data, setNewStreamList]);

  const view = catalogViewFrom({
    isLoading,
    hasError: Boolean(error),
    streamCount: streamList.length,
    isFromCurrentGateway: isStreamListFromCurrentGateway,
  });

  return (
    <div className="stream-browser">
      {view === 'streams' ? <StreamList /> : <div className="stream-browser-notice">{CATALOG_VIEW_MESSAGE[view]}</div>}
    </div>
  );
}
