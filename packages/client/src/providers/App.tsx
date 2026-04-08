import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Topic } from '@ethersphere/bee-js';

import { manifestFetcher } from '@/components/SwarmHlsPlayer/CustomManifestLoader';
import { ManifestStateManager } from '@/components/SwarmHlsPlayer/ManifestManagement';
import { Stream } from '@/types/stream';
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

  const initAppState = async () => {
    try {
      const data = await fetchAppState();
      if (Array.isArray(data)) {
        setStreamList(data);
      }
    } catch (error) {
      console.error('Failed to fetch app state:', error);
    }
  };

  useEffect(() => {
    initAppState();
  }, []);

  return (
    <AppContext.Provider value={{ streamList, setNewStreamList, fetchAppState, gatewayUrl, setGatewayUrl }}>
      {children}
    </AppContext.Provider>
  );
};
