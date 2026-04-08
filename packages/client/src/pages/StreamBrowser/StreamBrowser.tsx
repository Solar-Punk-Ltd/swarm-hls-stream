import { useEffect } from 'react';
import useSWR from 'swr';

import { StreamList } from '@/components/StreamList/StreamList';
import { useAppContext } from '@/providers/App';

import './StreamBrowser.scss';

export function StreamBrowser() {
  const { fetchAppState, setNewStreamList } = useAppContext();
  const { data } = useSWR('app-state', fetchAppState, {
    revalidateOnFocus: true,
    refreshInterval: 5000,
    dedupingInterval: 5000,
    shouldRetryOnError: true,
  });

  useEffect(() => {
    if (data) setNewStreamList(data);
  }, [data, setNewStreamList]);

  return (
    <div className="stream-browser">
      <StreamList />
    </div>
  );
}
