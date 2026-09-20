import type { Stream } from '../../../src/types/stream';

export interface ContinuationWatchTest {
  setStreams(streams: Stream[]): void;
}

export interface ContinuationPlayerTest {
  created: number;
  destroyed: number;
}

declare global {
  interface Window {
    __continuationWatchTest?: ContinuationWatchTest;
    __continuationPlayerTest?: ContinuationPlayerTest;
  }
}

export {};
