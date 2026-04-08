import { Bee, BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import PQueue from 'p-queue';

import { MediaType, StreamStatus } from '../types.js';
import { retryAwaitableAsync } from '../utils/common.js';

import { ErrorHandler } from './ErrorHandler.js';
import { Logger } from './Logger.js';

interface StreamEntry {
  title: string;
  owner: string;
  topic: string;
  state: StreamStatus;
  mediatype: MediaType;
  timestamp: number;
  index?: number;
  duration?: number;
}

export class StreamCatalog {
  private bee: Bee;
  private signer: PrivateKey;
  private feedTopic: Topic;
  private stamp: string;
  private feedIndex: FeedIndex | null = null;
  private queue = new PQueue({ concurrency: 1 });
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  constructor(bee: Bee, streamKey: string, feedTopic: string, stamp: string) {
    this.bee = bee;
    this.signer = new PrivateKey(streamKey);
    this.feedTopic = Topic.fromString(feedTopic);
    this.stamp = stamp;
  }

  public async init(): Promise<void> {
    try {
      const owner = this.signer.publicKey().address();
      const feedReader = this.bee.makeFeedReader(this.feedTopic, owner);
      const data = await feedReader.downloadPayload();
      this.feedIndex = data.feedIndex;

      this.logger.info(`[StreamCatalog] Loaded feed at index ${data.feedIndex.toString()}`);
    } catch (error) {
      if (error instanceof BeeResponseError && (error.status === 404 || error.status === 503)) {
        // 404 = feed topic never used, 503 = feed exists but has no entries yet
        this.feedIndex = null;
        this.logger.info('[StreamCatalog] No existing feed found, starting fresh');
      } else {
        this.errorHandler.handleError(error, 'StreamCatalog.init');
      }
    }
  }

  public async addStream(entry: StreamEntry): Promise<void> {
    return this.queue.add(() => this.updateFeed(entry));
  }

  private async updateFeed(entry: StreamEntry): Promise<void> {
    let state: StreamEntry[] = [];

    if (this.feedIndex !== null) {
      const previous = await this.fetchCurrentState();
      if (previous) {
        state = previous;
      }
    }

    // Deduplicate by (owner, topic)
    state = state.filter(e => e.owner !== entry.owner || e.topic !== entry.topic);
    state.push(entry);

    const nextIndex = this.feedIndex ? this.feedIndex.next() : FeedIndex.fromBigInt(BigInt(0));
    const feedWriter = this.bee.makeFeedWriter(this.feedTopic, this.signer);

    await retryAwaitableAsync(() => feedWriter.uploadPayload(this.stamp, JSON.stringify(state), { index: nextIndex }));

    this.feedIndex = nextIndex;
    this.logger.info(`[StreamCatalog] Feed updated at index ${nextIndex.toString()}, entries: ${state.length}`);
  }

  private async fetchCurrentState(): Promise<StreamEntry[] | null> {
    try {
      const owner = this.signer.publicKey().address();
      const feedReader = this.bee.makeFeedReader(this.feedTopic, owner);
      const data = await feedReader.downloadPayload({ index: this.feedIndex! });
      return data.payload.toJSON() as StreamEntry[];
    } catch (error) {
      this.errorHandler.handleError(error, 'StreamCatalog.fetchCurrentState');
      return null;
    }
  }
}
