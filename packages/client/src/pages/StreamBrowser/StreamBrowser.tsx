import { StreamList } from '@/components/StreamList/StreamList';
import { useAppContext } from '@/providers/App';
import { CATALOG_POLL_INTERVAL_MS } from '@/providers/catalogPoll';
import { useCatalogPoll } from '@/providers/useCatalogPoll';

import { CATALOG_VIEW_MESSAGE, catalogViewFrom } from './catalogView';

import './StreamBrowser.scss';

export function StreamBrowser() {
  const { streamList, isStreamListFromCurrentGateway } = useAppContext();
  // `error` and `isLoading` used to be dropped here, which is why a gateway nobody could reach looked
  // exactly like a gateway with nothing on it.
  const { error, isLoading } = useCatalogPoll(CATALOG_POLL_INTERVAL_MS);

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
