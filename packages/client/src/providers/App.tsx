import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Topic } from '@ethersphere/bee-js';

import { manifestFetcher } from '@/components/SwarmHlsPlayer/CustomManifestLoader';
import { ManifestStateManager } from '@/components/SwarmHlsPlayer/ManifestManagement';
import { Stream } from '@/types/stream';
import { CatalogFeedReader } from '@/utils/catalogFeed';
import { config } from '@/utils/config';

type AppContextState = {
  streamList: Stream[];
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

const GATEWAY_STORAGE_KEY = 'swarm-gateway-url';

function loadGatewayUrl(): string {
  try {
    return localStorage.getItem(GATEWAY_STORAGE_KEY) || config.beeUrl;
  } catch {
    return config.beeUrl;
  }
}

export const AppContextProvider = ({ children }: Props) => {
  const [streamList, setStreamList] = useState<Stream[]>([]);
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
    }
  }, [fetchAppState]);

  useEffect(() => {
    initAppState();
  }, [initAppState]);

  return (
    <AppContext.Provider value={{ streamList, setNewStreamList, fetchAppState, gatewayUrl, setGatewayUrl }}>
      {children}
    </AppContext.Provider>
  );
};
