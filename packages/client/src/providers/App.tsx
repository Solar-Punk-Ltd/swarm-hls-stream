import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Topic } from '@ethersphere/bee-js';

import { manifestFetcher } from '@/components/SwarmHlsPlayer/CustomManifestLoader';
import { ManifestStateManager } from '@/components/SwarmHlsPlayer/ManifestState';
import { Stream } from '@/types/stream';
import { config } from '@/utils/config';

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
    ManifestStateManager.getInstance().markAllDirty();
    try {
      localStorage.setItem(GATEWAY_STORAGE_KEY, trimmed);
    } catch {
      // localStorage unavailable
    }
  }, []);

  const fetchAppState = useCallback(async () => {
    const topic = Topic.fromString(config.rawAppTopic);
    const response = await fetch(`${gatewayRef.current}/feeds/${config.appOwner}/${topic.toString()}`);
    return response.json();
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

  return (
    <AppContext.Provider
      value={{ streamList, isStreamListLoaded, setNewStreamList, fetchAppState, gatewayUrl, setGatewayUrl }}
    >
      {children}
    </AppContext.Provider>
  );
};
