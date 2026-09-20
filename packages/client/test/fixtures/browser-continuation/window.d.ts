export interface ContinuationWatchTest<TStream> {
  setStreams(streams: TStream[]): void;
}

export interface ContinuationPlayerTest {
  created: number;
  destroyed: number;
}
