import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Topic } from '@ethersphere/bee-js';

import { manifestFetcher } from '@/components/SwarmHlsPlayer/CustomManifestLoader';
import { exposeFetchBackendForInstrumentation } from '@/components/SwarmHlsPlayer/fetchBackendTestHandle';
import { ManifestStateManager } from '@/components/SwarmHlsPlayer/ManifestManagement';
import { Stream } from '@/types/stream';
import { CatalogFeedReader } from '@/utils/catalogFeed';
import { config } from '@/utils/config';

import { exposeGatewayForInstrumentation } from './gatewayTestHandle';

type AppContextState = {
  streamList: Stream[];
  /**
   * Whether the catalog has been read at least once, successfully or not.
   *
   * A stream's ABR ladder lives in the catalog, so a page opened directly on /watch knows nothing
   * about it until this flips. Mounting the player before then would start it as single-rendition
   * and rebuild it the moment the ladder arrived, losing playback position on every deep link.
   */
  isStreamListLoaded: boolean;
  setNewStreamList: (data: any) => void;
  fetchAppState: () => Promise<any>;
  gatewayUrl: string;
  setGatewayUrl: (url: string) => void;
};

const AppContext = createContext<AppContextState | undefined>(undefined);

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within AppContextProvider');
  }
  return context;
};

type Props = {
  children: ReactNode;
};

/**
 * Where a viewer's chosen gateway survives a reload.
 *
 * Exported because the arm harness seeds it before the app runs, which is the only way an arm can be
 * on its own gateway for the join rather than from the first render onwards. `e2e` mirrors the string
 * and `e2e/test/gatewaySweep.test.ts` reads this line to prove the two still agree.
 */
export const GATEWAY_STORAGE_KEY = 'swarm-gateway-url';

function loadGatewayUrl(): string {
  try {
    return localStorage.getItem(GATEWAY_STORAGE_KEY) || config.beeUrl;
  } catch {
    return config.beeUrl;
  }
}

export const AppContextProvider = ({ children }: Props) => {
  const [streamList, setStreamList] = useState<Stream[]>([]);
  const [isStreamListLoaded, setIsStreamListLoaded] = useState(false);
  const [gatewayUrl, setGatewayUrlState] = useState<string>(() => {
    const url = loadGatewayUrl();
    manifestFetcher.beeUrl = url;
    return url;
  });

  const gatewayRef = useRef(gatewayUrl);

  const setGatewayUrl = useCallback((url: string) => {
    const trimmed = url.replace(/\/+$/, '');
    gatewayRef.current = trimmed;
    setGatewayUrlState(trimmed);
    manifestFetcher.beeUrl = trimmed;
    // The new node has its own view of the feed, so a position established against the old one would
    // ask it for slots it may not hold, which reads as a catalog that stopped rather than one being
    // followed from the wrong place.
    catalogReader.current.reset();
    ManifestStateManager.getInstance().markAllDirty();
    try {
      localStorage.setItem(GATEWAY_STORAGE_KEY, trimmed);
    } catch {
      // localStorage unavailable
    }
  }, []);

  /**
   * Kept in a ref rather than rebuilt per call, because its whole value is the position it remembers
   * between polls. A reader recreated on each render would resolve the head every time, which is the
   * cost this replaces.
   */
  const catalogReader = useRef(new CatalogFeedReader(config.appOwner, Topic.fromString(config.rawAppTopic)));

  /**
   * Null when nothing is newer than the last poll, which both callers already treat as no change.
   *
   * The head is resolved once, on the first call, and every call after asks for the slot after the
   * one it holds. See `CatalogFeedReader` for why that is worth about a thousand times at the median.
   */
  const fetchAppState = useCallback(async () => {
    const body = await catalogReader.current.read(gatewayRef.current);
    return body === null ? null : JSON.parse(body);
  }, []);

  const setNewStreamList = (data: any) => {
    if (!Array.isArray(data) || data.length === 0) {
      return;
    }

    const latestFetched = data[data.length - 1];
    const latestExisting = streamList?.[streamList.length - 1];

    if (!latestExisting || latestFetched.timestamp > latestExisting.timestamp) {
      setStreamList(data);
    }
  };

  const initAppState = useCallback(async () => {
    try {
      const data = await fetchAppState();
      if (Array.isArray(data)) {
        setStreamList(data);
      }
    } catch (error) {
      console.error('Failed to fetch app state:', error);
    } finally {
      // Also on failure: a catalog that cannot be read is not a reason to withhold the player
      // forever, and a stream deep-linked without its ladder still plays as a single rendition.
      setIsStreamListLoaded(true);
    }
  }, [fetchAppState]);

  useEffect(() => {
    initAppState();
  }, [initAppState]);

  // Only present in a build made with VITE_EXPOSE_PLAYER, which no shipping build is. `setGatewayUrl`
  // holds no dependencies, so this publishes once per mount rather than on every render.
  useEffect(
    () =>
      exposeGatewayForInstrumentation({
        current: () => gatewayRef.current,
        select: setGatewayUrl,
      }) ?? undefined,
    [setGatewayUrl],
  );

  // The byte-source switch, beside the gateway one and behind the same flag. It holds no React state
  // of its own, so it publishes once per mount and depends on nothing.
  useEffect(() => exposeFetchBackendForInstrumentation() ?? undefined, []);

  return (
    <AppContext.Provider
      value={{ streamList, isStreamListLoaded, setNewStreamList, fetchAppState, gatewayUrl, setGatewayUrl }}
    >
      {children}
    </AppContext.Provider>
  );
};
