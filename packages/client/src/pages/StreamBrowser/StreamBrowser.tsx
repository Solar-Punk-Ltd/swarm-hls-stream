import { useEffect } from 'react';
import useSWR from 'swr';

import { StreamList } from '@/components/StreamList/StreamList';
import { useAppContext } from '@/providers/App';

import { CATALOG_VIEW_MESSAGE, catalogViewFrom } from './catalogView';

import './StreamBrowser.scss';

export function StreamBrowser() {
  const { fetchAppState, setNewStreamList, streamList } = useAppContext();
  // `error` and `isLoading` used to be dropped here, which is why a gateway nobody could reach looked
  // exactly like a gateway with nothing on it.
  const { data, error, isLoading } = useSWR('app-state', fetchAppState, {
    revalidateOnFocus: true,
    refreshInterval: 5000,
    dedupingInterval: 5000,
    shouldRetryOnError: true,
  });

  useEffect(() => {
    if (data) setNewStreamList(data);
  }, [data, setNewStreamList]);

  const view = catalogViewFrom({ isLoading, hasError: Boolean(error), streamCount: streamList.length });

  return (
    <div className="stream-browser">
      {view === 'streams' ? <StreamList /> : <div className="stream-browser-notice">{CATALOG_VIEW_MESSAGE[view]}</div>}
    </div>
  );
}
