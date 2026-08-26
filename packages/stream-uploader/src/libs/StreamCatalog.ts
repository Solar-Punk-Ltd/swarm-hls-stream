import { BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import PQueue from 'p-queue';

import { MediaType, Rendition, STREAM_STATUS_LIVE, STREAM_STATUS_VOD, StreamStatus } from '../types.js';
import { getErrorMessage, retryUntilDeadlineAsync } from '../utils/common.js';

import { BeePublisher, BeePublisherPool } from './BeePublisherPool.js';
import { CatalogIndexStore } from './CatalogIndexStore.js';
import { ErrorHandler } from './ErrorHandler.js';
import { Logger } from './Logger.js';
import { MasterFeedWriter, PublishedMaster } from './MasterFeedWriter.js';

const CATALOG_RETRY_WINDOW_MS = 10_000;

/**
 * How many consecutive failures to read the resumed state it takes before the entries there are
 * treated as gone. Each attempt spends its own retry window and belongs to a different segment, so
 * this is tens of seconds of trying rather than an instant.
 */
export const TREAT_STATE_AS_LOST_AFTER = 3;

/**
 * Node's error codes for a request that reached bee and then lost the transfer, as opposed to one
 * that never arrived. bee-js is built on axios and passes its `code` through as `statusText`,
 * leaving `status` unset when no response completed — which is what separates these from an HTTP
 * error that came back with a status of its own.
 *
 * ECONNREFUSED, ENOTFOUND and the rest deliberately stay out: those say the node was never there.
 */
const TRANSFER_LOST_CODES = new Set(['ECONNABORTED', 'ECONNRESET']);

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
  private indexStore?: CatalogIndexStore;
  private feedIndex: FeedIndex | null = null;
  private queue = new PQueue({ concurrency: 1 });
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  /**
   * Set when boot resumed to an index whose state it never read — the head was below the persisted
   * floor, or absent, or unreadable — and cleared by the first read or write that succeeds.
   *
   * Only inside this window may a failed read of that state be taken for the state being gone. A
   * read that fails outside it stays fatal to the write: continuing from an empty list would drop
   * every other stream's entry from the catalog, which is far worse than losing one update.
   */
  private resumedToUnreadState = false;

  /** Consecutive failures to read that unread state. See {@link TREAT_STATE_AS_LOST_AFTER}. */
  private unreadableStateReads = 0;

  /**
   * Writes each ladder's master playlist. Absent, ladder entries fall back to pointing at their
   * lowest rung, which is what a client without master support reads.
   */
  private masterWriter?: MasterFeedWriter;

  constructor(
    publishers: BeePublisherPool,
    streamKey: string,
    feedTopic: string,
    indexStore?: CatalogIndexStore,
    masterWriter?: MasterFeedWriter,
  ) {
    this.publishers = publishers;
    this.signer = new PrivateKey(streamKey);
    this.feedTopic = Topic.fromString(feedTopic);
    this.indexStore = indexStore;
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
   * How long the persisted feed index has been failing to update, or null when the last save landed
   * and when no index is persisted at all. See `CatalogIndexStore.getMsSinceSaveFailed`.
   */
  public getMsSinceIndexSaveFailed(): number | null {
    return this.indexStore?.getMsSinceSaveFailed() ?? null;
  }

  /**
   * The node the catalog is written through. Coordination rides the lowest rung's publisher — see
   * {@link BeePublisherPool.coordinator} for why that one.
   */
  private get publisher(): BeePublisher {
    return this.publishers.coordinator();
  }

  public async init(): Promise<void> {
    const owner = this.signer.publicKey().address();
    // The lookup asks the local bee for the feed head, but a freshly restarted node without
    // warmed peers can answer with a stale (or missing) head. Never resume below the last
    // index this uploader wrote — writing into already-occupied indices forks the feed
    // invisibly for readers, who keep following the original chain.
    const persisted = this.indexStore?.load(owner.toString(), this.feedTopic.toString()) ?? null;

    try {
      const feedReader = this.publisher.bee.makeFeedReader(this.feedTopic, owner);
      const data = await feedReader.downloadPayload();

      if (persisted !== null && persisted.toBigInt() > data.feedIndex.toBigInt()) {
        this.resumeFromPersisted(persisted, `Boot lookup returned stale index ${data.feedIndex.toString()}`);
        return;
      }

      this.feedIndex = data.feedIndex;
      this.logger.info(`[StreamCatalog] Loaded feed at index ${data.feedIndex.toString()}`);
    } catch (error) {
      if (isFeedAbsent(error)) {
        if (persisted !== null) {
          this.resumeFromPersisted(persisted, 'Boot lookup found no feed');
          return;
        }
        this.feedIndex = null;
        this.logger.info('[StreamCatalog] No existing feed found, starting fresh');
        return;
      }

      // The head resolved and its payload did not arrive: bee answers a retrieval it cannot finish
      // with the headers and then a dropped body, which carries no HTTP status to match on. The
      // usual cause is the postage batch that paid for the catalog having expired, so the chunks
      // are gone from every reserve except the node that wrote them — a different node as soon as
      // the catalog moves onto a publisher pool's coordinator. That must not take the uploader off
      // the air over a catalog no reader can load either, so continue above the last index this
      // uploader wrote and let the writes discover whether the entries are still there.
      if (persisted !== null && (await this.payloadUnreadableOnLiveNode(error))) {
        this.resumeFromPersisted(persisted, `Boot lookup could not read the feed head (${getErrorMessage(error)})`);
        return;
      }

      // Everything else stays as loud as it was. A request that never reached the node — a wrong
      // url, a wrong port, a node that is down — must fail the boot rather than start an uploader
      // that cannot publish, and without a persisted index there is no floor to continue above:
      // the head's index is unknown, and beginning at 0 would write into occupied indices and fork
      // the feed invisibly for every reader that keeps following the original chain.
      this.errorHandler.handleError(error, 'StreamCatalog.init');
      throw error;
    }
  }

  /**
   * Continue the feed from the last index this uploader wrote, without having read the state there.
   *
   * Every caller arrives here without a payload in hand, so the entries at `persisted` are unproven
   * and the writes are allowed to find them gone — see {@link resumedToUnreadState}. Never resume
   * *below* that index: writing into already-occupied indices forks the feed invisibly for readers,
   * who keep following the original chain.
   */
  private resumeFromPersisted(persisted: FeedIndex, reason: string): void {
    this.feedIndex = persisted;
    this.resumedToUnreadState = true;
    this.unreadableStateReads = 0;
    this.logger.warn(`[StreamCatalog] ${reason}; resuming from persisted index ${persisted.toString()}`);
  }

  /**
   * Whether the node is up and it was only the head's payload that failed to arrive.
   *
   * The error codes for a transfer that broke on the way back cover a request that timed out as
   * well as one whose body was dropped, so the code alone cannot say which happened. A node that
   * answers a liveness check immediately afterwards is the evidence that the payload was the
   * problem; one that does not answer keeps the boot failing, which is what a wrong url or a node
   * that is down deserves.
   */
  private async payloadUnreadableOnLiveNode(error: unknown): Promise<boolean> {
    if (!isTransferLost(error)) {
      return false;
    }

    if (await this.publisher.bee.isConnected()) {
      return true;
    }

    this.logger.error(
      `[StreamCatalog] ${this.publisher.url} did not answer a liveness check — the boot lookup failed on the node, not on the catalog`,
    );
    return false;
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
      previous = await this.readPreviousState();
    }

    const state = await update(previous);

    const nextIndex = this.feedIndex ? this.feedIndex.next() : FeedIndex.fromBigInt(BigInt(0));
    const publisher = this.publisher;
    const feedWriter = publisher.bee.makeFeedWriter(this.feedTopic, this.signer);

    const payload = JSON.stringify(state);
    const result = await retryUntilDeadlineAsync(
      // deferred for the same reason as the manifest feed: a direct SOC write blocks on push-sync.
      () => feedWriter.uploadPayload(publisher.stamp, payload, { index: nextIndex, deferred: true }),
      CATALOG_RETRY_WINDOW_MS,
    );

    this.feedIndex = nextIndex;
    // Whatever boot could not read, this index can be: it is what was just written, through the
    // same node, so a later read failure here is a real one again.
    this.resumedToUnreadState = false;
    this.unreadableStateReads = 0;
    const ownerAddr = this.signer.publicKey().address().toString();
    this.indexStore?.save(ownerAddr, this.feedTopic.toString(), nextIndex);
    this.logger.debug(
      `[StreamCatalog] Feed updated index=${nextIndex.toString()} entries=${state.length} bytes=${payload.length} ref=${
        result?.reference?.toHex?.() ?? '?'
      } owner=${ownerAddr} topicHex=${this.feedTopic.toString()}`,
    );
  }

  /**
   * The entries the next update is appended to.
   *
   * Tolerant only inside the window {@link resumedToUnreadState} opens, and even there only once
   * the state has failed to read {@link TREAT_STATE_AS_LOST_AFTER} times over. Retrievability on
   * Swarm flaps — the same index has been watched going unreadable, readable and unreadable again
   * within an hour — so giving up on the first failure would throw away a catalog that a later
   * attempt would have loaded, and that loss cannot be undone. Failing the write instead costs one
   * update, is logged, and is retried by the next segment.
   */
  private async readPreviousState(): Promise<StreamEntry[]> {
    const index = this.feedIndex!.toString();

    try {
      const state = await this.fetchCurrentState();
      this.resumedToUnreadState = false;
      this.unreadableStateReads = 0;
      return state;
    } catch (error) {
      if (!this.resumedToUnreadState) {
        throw error;
      }

      this.unreadableStateReads++;
      if (this.unreadableStateReads < TREAT_STATE_AS_LOST_AFTER) {
        this.logger.warn(
          `[StreamCatalog] State at index ${index} did not read (${getErrorMessage(error)}); ` +
            `attempt ${this.unreadableStateReads} of ${TREAT_STATE_AS_LOST_AFTER} before it counts as gone`,
        );
        throw error;
      }

      this.logger.error(
        `[StreamCatalog] State at index ${index} failed to read ${this.unreadableStateReads} times; ` +
          'continuing with an empty catalog — earlier entries are lost',
      );
      return [];
    }
  }

  private async fetchCurrentState(): Promise<StreamEntry[]> {
    const owner = this.signer.publicKey().address();
    const feedReader = this.publisher.bee.makeFeedReader(this.feedTopic, owner);
    const data = await retryUntilDeadlineAsync(
      () => feedReader.downloadPayload({ index: this.feedIndex! }),
      CATALOG_RETRY_WINDOW_MS,
    );
    return data.payload.toJSON() as StreamEntry[];
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

/** Bee's two answers for a feed with nothing to read: 404 topic never used, 503 no entries yet. */
function isFeedAbsent(error: unknown): boolean {
  return error instanceof BeeResponseError && (error.status === 404 || error.status === 503);
}

/** A request that reached the node and lost the response on the way back. */
function isTransferLost(error: unknown): boolean {
  return (
    error instanceof BeeResponseError && error.status === undefined && TRANSFER_LOST_CODES.has(error.statusText ?? '')
  );
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
