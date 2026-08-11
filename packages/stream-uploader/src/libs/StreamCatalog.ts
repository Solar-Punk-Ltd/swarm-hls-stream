import { BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import PQueue from 'p-queue';

import { MediaType, Rendition, STREAM_STATUS_LIVE, STREAM_STATUS_VOD, StreamStatus } from '../types.js';
import { retryAwaitableAsync } from '../utils/common.js';

import { BeePublisher, BeePublisherPool } from './BeePublisherPool.js';
import { ErrorHandler } from './ErrorHandler.js';
import { Logger } from './Logger.js';
import { MasterFeedWriter, PublishedMaster } from './MasterFeedWriter.js';

export interface StreamEntry {
  title: string;
  owner: string;
  /**
   * The feed a viewer opens. For a ladder this is the master playlist's feed, so one URL yields
   * every rung; for a single-rendition stream it is the media playlist's feed, as it always was.
   */
  topic: string;
  state: StreamStatus;
  mediatype: MediaType;
  timestamp: number;
  index?: number;
  duration?: number;
  /**
   * Ladder identity, absent on single-rendition streams. Present, it — not `topic` — is what
   * makes the entry unique, because four rungs fold into one entry and each of them writes it.
   */
  group?: string;
  renditions?: Rendition[];
}

/** Everything about a ladder that is the same for all of its rungs. */
export interface LadderIdentity {
  title: string;
  owner: string;
  group: string;
  mediatype: MediaType;
}

export class StreamCatalog {
  private publishers: BeePublisherPool;
  private signer: PrivateKey;
  private feedTopic: Topic;
  private feedIndex: FeedIndex | null = null;
  private queue = new PQueue({ concurrency: 1 });
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  /**
   * Writes each ladder's master playlist. Absent, ladder entries fall back to pointing at their
   * lowest rung, which is what a client without master support reads.
   */
  private masterWriter?: MasterFeedWriter;

  constructor(publishers: BeePublisherPool, streamKey: string, feedTopic: string, masterWriter?: MasterFeedWriter) {
    this.publishers = publishers;
    this.signer = new PrivateKey(streamKey);
    this.feedTopic = Topic.fromString(feedTopic);
    this.masterWriter = masterWriter;

    const publisher = this.publisher;
    this.logger.debug(
      `[StreamCatalog] bee=${publisher.url} owner=${this.signer
        .publicKey()
        .address()
        .toString()} topic="${feedTopic}" topicHex=${this.feedTopic.toString()} stamp=${publisher.stamp.slice(0, 12)}…`,
    );
  }

  /**
   * The node the catalog is written through. Coordination rides the lowest rung's publisher — see
   * {@link BeePublisherPool.coordinator} for why that one.
   */
  private get publisher(): BeePublisher {
    return this.publishers.coordinator();
  }

  public async init(): Promise<void> {
    try {
      const owner = this.signer.publicKey().address();
      const feedReader = this.publisher.bee.makeFeedReader(this.feedTopic, owner);
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
    return this.queue.add(() =>
      this.writeFeed((previous) => [...withoutTopic(previous, entry.owner, entry.topic), entry]),
    );
  }

  /**
   * Folds one rung into its ladder's single catalog entry, creating the entry if this is the
   * first rung up, and republishes the ladder's master playlist to match.
   *
   * Four uploaders call this concurrently for the same ladder, each holding only its own rung.
   * The read-merge-write that reconciles them is only safe because the catalog's queue serialises
   * every write to this feed, so the merge always sees the previous rung's result — and it is also
   * the only point at which the *whole* ladder is known, which is why the master is written here
   * rather than from the uploader that happens to hold a rung.
   *
   * The master goes out before the catalog entry that points at it. The other order would publish
   * an entry whose `topic` resolves to nothing for as long as the two writes are apart, and a
   * viewer reading the catalog in that window sees a stream it cannot open.
   */
  public async upsertRendition(identity: LadderIdentity, rendition: Rendition): Promise<void> {
    return this.queue.add(() =>
      this.writeFeed(async (previous) => {
        const entry = buildLadderEntry(identity, previous, rendition);
        const published = await this.masterWriter?.publish(identity.group, entry.renditions ?? []);

        return [
          ...withoutGroup(previous, identity.owner, identity.group),
          published ? withMaster(entry, published) : entry,
        ];
      }),
    );
  }

  private async writeFeed(update: (previous: StreamEntry[]) => StreamEntry[] | Promise<StreamEntry[]>): Promise<void> {
    let previous: StreamEntry[] = [];

    if (this.feedIndex !== null) {
      const fetched = await this.fetchCurrentState();
      if (fetched) {
        previous = fetched;
      }
    }

    const state = await update(previous);

    const nextIndex = this.feedIndex ? this.feedIndex.next() : FeedIndex.fromBigInt(BigInt(0));
    const publisher = this.publisher;
    const feedWriter = publisher.bee.makeFeedWriter(this.feedTopic, this.signer);

    const payload = JSON.stringify(state);
    const result = await retryAwaitableAsync(() =>
      feedWriter.uploadPayload(publisher.stamp, payload, { index: nextIndex }),
    );

    this.feedIndex = nextIndex;
    const ownerAddr = this.signer.publicKey().address().toString();
    this.logger.debug(
      `[StreamCatalog] Feed updated index=${nextIndex.toString()} entries=${state.length} bytes=${payload.length} ref=${
        result?.reference?.toHex?.() ?? '?'
      } owner=${ownerAddr} topicHex=${this.feedTopic.toString()}`,
    );
  }

  private async fetchCurrentState(): Promise<StreamEntry[] | null> {
    try {
      const owner = this.signer.publicKey().address();
      const feedReader = this.publisher.bee.makeFeedReader(this.feedTopic, owner);
      const data = await feedReader.downloadPayload({ index: this.feedIndex! });
      return data.payload.toJSON() as StreamEntry[];
    } catch (error) {
      this.errorHandler.handleError(error, 'StreamCatalog.fetchCurrentState');
      return null;
    }
  }
}

/**
 * The ladder's entry after folding one rung's latest state into it.
 *
 * A ladder goes to VOD only once every rung it has announced has finalized. Doing it per rung
 * would flip the whole entry to VOD on the first one to drain, and the other three are still live.
 */
export function buildLadderEntry(identity: LadderIdentity, previous: StreamEntry[], rendition: Rendition): StreamEntry {
  const existing = previous.find((e) => e.owner === identity.owner && e.group === identity.group);
  const renditions = mergeRendition(existing?.renditions ?? [], rendition);

  // Lowest rung first: it is the cheapest to bootstrap, and it is what a client that knows
  // nothing about `renditions` will play when it follows `topic`.
  const primary = renditions[0];
  const finished = renditions.every((r) => r.index !== undefined);

  const entry: StreamEntry = {
    title: identity.title,
    owner: identity.owner,
    topic: primary.topic,
    state: finished ? STREAM_STATUS_VOD : STREAM_STATUS_LIVE,
    mediatype: identity.mediatype,
    timestamp: Date.now(),
    group: identity.group,
    renditions,
  };

  if (finished) {
    entry.index = primary.index;
    entry.duration = Math.max(...renditions.map((r) => r.duration ?? 0));
  }

  return entry;
}

/**
 * Repoints a ladder entry at its published master playlist.
 *
 * `topic` moves off the lowest rung and onto the master, so one URL yields the whole ladder — and
 * `index`, which on a finalized stream is where a viewer finds the last playlist written, has to
 * move with it or it would name an index in the wrong feed. `renditions` stays: it is what lets a
 * client show the ladder before fetching anything, and what the fallback path builds a master from
 * when an entry predates masters being published at all.
 */
export function withMaster(entry: StreamEntry, master: PublishedMaster): StreamEntry {
  const repointed: StreamEntry = { ...entry, topic: master.topic };

  if (entry.index !== undefined) {
    repointed.index = master.index;
  }

  return repointed;
}

function withoutTopic(entries: StreamEntry[], owner: string, topic: string): StreamEntry[] {
  return entries.filter((e) => e.owner !== owner || e.topic !== topic);
}

function withoutGroup(entries: StreamEntry[], owner: string, group: string): StreamEntry[] {
  return entries.filter((e) => e.owner !== owner || e.group !== group);
}

function mergeRendition(existing: Rendition[], incoming: Rendition): Rendition[] {
  const merged = existing.filter((r) => r.name !== incoming.name);
  merged.push(incoming);
  return merged.sort((a, b) => a.height - b.height);
}
