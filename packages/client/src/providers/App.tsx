import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Topic } from '@ethersphere/bee-js';

import { manifestFetcher } from '@/components/SwarmHlsPlayer/CustomManifestLoader';
import { exposeFetchBackendForInstrumentation } from '@/components/SwarmHlsPlayer/fetchBackendTestHandle';
import { ManifestStateManager } from '@/components/SwarmHlsPlayer/ManifestManagement';
import { Stream } from '@/types/stream';
import { CatalogFeedReader } from '@/utils/catalogFeed';
import { config } from '@/utils/config';

import { CatalogRead, catalogUpdater, StreamCatalog } from './catalogState';
import { exposeGatewayForInstrumentation } from './gatewayTestHandle';

type AppContextState = {
  streamList: Stream[];
  /**
   * Whether the catalog has been read at least once, successfully or not.
   *
   * A stream's ABR ladder lives in the catalog, so a page opened directly on /watch knows nothing
   * about it until this flips. Mounting the player before then would start it as single-rendition
   * and rebuild it the moment the ladder arrived, losing playback position on every deep link.
   *
   * ⛔ Not reset by a gateway switch, and that is deliberate. The ladder belongs to the broadcast
   * rather than to the node serving it, and the watch page has no catalog poll of its own, so
   * clearing this there would unmount the player and leave nothing to bring it back.
   */
  isStreamListLoaded: boolean;
  /**
   * Whether {@link streamList} came from the gateway now selected.
   *
   * False from the moment a viewer switches node until that node's own answer lands. The browse page
   * then says it is still looking rather than showing another node's streams, and the watch page
   * keeps the ladder it has, which is a property of the broadcast and not of the gateway.
   */
  isStreamListFromCurrentGateway: boolean;
  setNewStreamList: (read: CatalogRead) => void;
  fetchAppState: () => Promise<CatalogRead>;
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
  const [catalog, setCatalog] = useState<StreamCatalog>({ streams: [], gateway: null });
  const [isStreamListLoaded, setIsStreamListLoaded] = useState(false);
  const [gatewayUrl, setGatewayUrlState] = useState<string>(() => {
    const url = loadGatewayUrl();
    manifestFetcher.beeUrl = url;
    return url;
  });

  const gatewayRef = useRef(gatewayUrl);

  /**
   * Point every subsequent read at another node.
   *
   * ⛔ **The stream list is not cleared here, and that is the fix rather than an omission.** What a
   * switch changes is whose answer the list is, which the gateway held beside it already records, so
   * the browse page stops showing it from this moment without anything being thrown away. Clearing
   * it would reach the watch page too, where a player is mounted on a ladder read out of it and
   * nothing polls the catalog to put one back: the viewer's own node would cost them the ladder, the
   * playback position, or the whole player. It would also break the instrumentation handle's one
   * promise, that a switch repoints every fetch without remounting anything.
   */
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
   * A read that landed, carrying a null body when nothing was newer than the last poll.
   *
   * The head is resolved once, on the first call, and every call after asks for the slot after the
   * one it holds. See `CatalogFeedReader` for why that is worth about a thousand times at the median.
   */
  const fetchAppState = useCallback(async (): Promise<CatalogRead> => {
    const gateway = gatewayRef.current;
    const body = await catalogReader.current.read(gateway);
    return { gateway, streams: body === null ? null : JSON.parse(body) };
  }, []);

  /**
   * Stable, and applied through the state it is updating rather than through a captured copy.
   *
   * ⛔ A new function on every render is what let a poll be applied twice: the browse page's effect
   * depends on this, so it re-ran on every render of this provider and handed the previous poll's
   * body back in, which would put a gateway's streams back on screen right after a switch cleared
   * them.
   */
  const setNewStreamList = useCallback((read: CatalogRead) => {
    setCatalog(catalogUpdater(read, gatewayRef));
  }, []);

  const initAppState = useCallback(async () => {
    try {
      setNewStreamList(await fetchAppState());
    } catch (error) {
      console.error('Failed to fetch app state:', error);
    } finally {
      // Also on failure: a catalog that cannot be read is not a reason to withhold the player
      // forever, and a stream deep-linked without its ladder still plays as a single rendition.
      setIsStreamListLoaded(true);
    }
  }, [fetchAppState, setNewStreamList]);

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
      value={{
        streamList: catalog.streams,
        isStreamListLoaded,
        isStreamListFromCurrentGateway: catalog.gateway === gatewayUrl,
        setNewStreamList,
        fetchAppState,
        gatewayUrl,
        setGatewayUrl,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
