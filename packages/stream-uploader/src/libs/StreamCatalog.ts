import { Bee, BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import PQueue from 'p-queue';

import { MediaType, StreamStatus } from '../types.js';
import { retryUntilDeadlineAsync } from '../utils/common.js';

import { CatalogIndexStore } from './CatalogIndexStore.js';
import { ErrorHandler } from './ErrorHandler.js';
import { Logger } from './Logger.js';

const CATALOG_RETRY_WINDOW_MS = 10_000;

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
  private indexStore?: CatalogIndexStore;
  private feedIndex: FeedIndex | null = null;
  private queue = new PQueue({ concurrency: 1 });
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  constructor(bee: Bee, streamKey: string, feedTopic: string, stamp: string, indexStore?: CatalogIndexStore) {
    this.bee = bee;
    this.signer = new PrivateKey(streamKey);
    this.feedTopic = Topic.fromString(feedTopic);
    this.stamp = stamp;
    this.indexStore = indexStore;
    this.logger.debug(
      `[StreamCatalog] bee=${(bee as unknown as { url?: string }).url ?? '?'} owner=${this.signer
        .publicKey()
        .address()
        .toString()} topic="${feedTopic}" topicHex=${this.feedTopic.toString()} stamp=${stamp.slice(0, 12)}…`,
    );
  }

  public async init(): Promise<void> {
    const owner = this.signer.publicKey().address();
    // The lookup asks the local bee for the feed head, but a freshly restarted node without
    // warmed peers can answer with a stale (or missing) head. Never resume below the last
    // index this uploader wrote — writing into already-occupied indices forks the feed
    // invisibly for readers, who keep following the original chain.
    const persisted = this.indexStore?.load(owner.toString(), this.feedTopic.toString()) ?? null;

    try {
      const feedReader = this.bee.makeFeedReader(this.feedTopic, owner);
      const data = await feedReader.downloadPayload();

      if (persisted !== null && persisted.toBigInt() > data.feedIndex.toBigInt()) {
        this.feedIndex = persisted;
        this.logger.warn(
          `[StreamCatalog] Boot lookup returned stale index ${data.feedIndex.toString()}; resuming from persisted ${persisted.toString()}`,
        );
        return;
      }

      this.feedIndex = data.feedIndex;
      this.logger.info(`[StreamCatalog] Loaded feed at index ${data.feedIndex.toString()}`);
    } catch (error) {
      if (error instanceof BeeResponseError && (error.status === 404 || error.status === 503)) {
        // 404 = feed topic never used, 503 = feed exists but has no entries yet
        if (persisted !== null) {
          this.feedIndex = persisted;
          this.logger.warn(
            `[StreamCatalog] Boot lookup found no feed; resuming from persisted index ${persisted.toString()}`,
          );
          return;
        }
        this.feedIndex = null;
        this.logger.info('[StreamCatalog] No existing feed found, starting fresh');
        return;
      }
      this.errorHandler.handleError(error, 'StreamCatalog.init');
      throw error;
    }
  }

  public async addStream(entry: StreamEntry): Promise<void> {
    return this.queue.add(() => this.updateFeed(entry));
  }

  private async updateFeed(entry: StreamEntry): Promise<void> {
    let state: StreamEntry[] = [];

    if (this.feedIndex !== null) {
      state = await this.fetchCurrentState();
    }

    // Deduplicate by (owner, topic)
    state = state.filter((e) => e.owner !== entry.owner || e.topic !== entry.topic);
    state.push(entry);

    const nextIndex = this.feedIndex ? this.feedIndex.next() : FeedIndex.fromBigInt(BigInt(0));
    const feedWriter = this.bee.makeFeedWriter(this.feedTopic, this.signer);

    const payload = JSON.stringify(state);
    const result = await retryUntilDeadlineAsync(
      // deferred for the same reason as the manifest feed: a direct SOC write blocks on push-sync.
      () => feedWriter.uploadPayload(this.stamp, payload, { index: nextIndex, deferred: true }),
      CATALOG_RETRY_WINDOW_MS,
    );

    this.feedIndex = nextIndex;
    const ownerAddr = this.signer.publicKey().address().toString();
    this.indexStore?.save(ownerAddr, this.feedTopic.toString(), nextIndex);
    this.logger.debug(
      `[StreamCatalog] Feed updated index=${nextIndex.toString()} entries=${state.length} bytes=${payload.length} ref=${
        result?.reference?.toHex?.() ?? '?'
      } owner=${ownerAddr} topicHex=${this.feedTopic.toString()}`,
    );
  }

  private async fetchCurrentState(): Promise<StreamEntry[]> {
    const owner = this.signer.publicKey().address();
    const feedReader = this.bee.makeFeedReader(this.feedTopic, owner);
    const data = await retryUntilDeadlineAsync(
      () => feedReader.downloadPayload({ index: this.feedIndex! }),
      CATALOG_RETRY_WINDOW_MS,
    );
    return data.payload.toJSON() as StreamEntry[];
  }
}
