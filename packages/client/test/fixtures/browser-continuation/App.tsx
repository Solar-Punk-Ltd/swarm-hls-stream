import { useSyncExternalStore } from 'react';

import type { Stream } from '../../../src/types/stream';
import type { ContinuationWatchTest } from './window';

type AppState = {
  isStreamListLoaded: boolean;
  streamList: Stream[];
};

let state: AppState = { isStreamListLoaded: false, streamList: [] };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setStreams(streamList: Stream[]): void {
  state = { isStreamListLoaded: true, streamList };
  notify();
}

window.__continuationWatchTest = { setStreams } satisfies ContinuationWatchTest;

export function useAppContext(): AppState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
