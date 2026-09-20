import { BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import { feedSlotReference } from '@swarm-hls-stream/shared';
import PQueue from 'p-queue';

import { Rendition } from '../types.js';
import { retryUntilDeadlineAsync } from '../utils/common.js';

import { BeePublisherPool } from './BeePublisherPool.js';
import { Logger } from './Logger.js';
import {
  ManagedMasterBinding,
  ManagedMasterIntent,
  ManagedMasterPersistence,
} from './ManagedMasterStore.js';
import { buildMasterPlaylist } from './MasterPlaylist.js';

const MASTER_RETRY_WINDOW_MS = 10_000;

/** Where a published master lives, and which of its indices holds the version just written. */
export interface PublishedMaster {
  topic: string;
  index: number;
  reference: string;
}

/**
 * Publishes each ladder's multivariant playlist to a feed of its own.
 *
 * The feed's topic *is* the ladder's group id. That is deliberate rather than convenient: the
 * group is the one identifier every rung already agrees on and the catalog already carries, so a
 * viewer holding a catalog entry needs nothing further to find the master, and a rung that
 * restarts mid-ladder republishes to the same place instead of stranding a second master.
 *
 * The rung topics are derived the same way, from the group and the rung name (`rungTopicFor`), so a
 * rung that stopped and restarted while its siblings kept the ladder alive comes back onto the feed
 * it was already writing rather than stranding what it published there. What pays for that is
 * `StreamUploader.resumeFeedIndex`: a session whose topic outlived it reads the head before it
 * writes anything, so it appends above the previous session instead of overwriting it at index 0.
 */
export class MasterFeedWriter {
  private indices = new Map<string, FeedIndex | null>();
  private queue = new PQueue({ concurrency: 1 });
  private logger = Logger.getInstance();

  constructor(private readonly publishers: BeePublisherPool, private readonly signer: PrivateKey) {}

  public get owner(): string {
    return this.signer.publicKey().address().toHex();
  }

  /**
   * Writes the ladder's current master and reports where it landed.
   *
   * Serialised on a queue of its own. The caller today is the stream catalog, whose writes are
   * already serialised, but a master feed is per ladder rather than per process and nothing about
   * that guarantee is this class's to assume — two ladders publishing at once must not race on the
   * index map.
   */
  public async publish(group: string, renditions: Rendition[]): Promise<PublishedMaster | null> {
    if (renditions.length === 0) {
      return null;
    }

    // `?? null` because p-queue types `add` as resolving to `T | void`: a task dropped by
    // `queue.clear()` never runs and yields nothing. Nothing clears this queue, but a silent
    // `undefined` reaching the catalog would repoint an entry at `topic: undefined`.
    const published = await this.queue.add(async () => {
      const topic = Topic.fromString(group);
      const index = await this.nextIndex(group, topic);
      const playlist = buildMasterPlaylist(this.owner, renditions);
      const publisher = this.publishers.coordinator();

      const writer = publisher.bee.makeFeedWriter(topic, this.signer);
      const result = await retryUntilDeadlineAsync(
        () => writer.uploadPayload(publisher.stamp, playlist, { index, deferred: true }),
        MASTER_RETRY_WINDOW_MS,
      );

      this.indices.set(group, index);
      this.logger.debug(
        `[MasterFeedWriter] Master for ladder ${group} written at index ${index.toString()} via ` +
          `${publisher.rung} with ${renditions.length} rung(s): ${renditions.map((r) => r.name).join(', ')}`,
      );

      return { topic: group, index: Number(index.toBigInt()), reference: result.reference.toHex() };
    });

    return published ?? null;
  }

  /** Publish one lifecycle-v1 master event from a durable fixed-index intent. */
  public async publishManaged(
    group: string,
    renditions: Rendition[],
    eventId: string,
    binding: ManagedMasterBinding,
    store: ManagedMasterPersistence,
  ): Promise<PublishedMaster | null> {
    if (renditions.length === 0) {
      return null;
    }
    if (binding.group !== group) {
      throw new Error(`Managed master binding ${binding.group} does not match ladder ${group}`);
    }
    const published = await this.queue.add(async () => {
      const topic = Topic.fromString(group);
      const playlist = buildMasterPlaylist(this.owner, renditions);
      const previous = store.read(binding);
      if (previous?.eventId === eventId) {
        if (previous.playlist !== playlist) {
          throw new Error(`Managed master event ${eventId} rebuilt with another playlist`);
        }
        return this.settleManagedIntent(topic, previous, store);
      }
      let previousIndex = previous?.index;
      if (previous?.status === 'pending') {
        previousIndex = (await this.settleManagedIntent(topic, previous, store)).index;
      }
      let index: FeedIndex;
      if (previousIndex !== undefined) {
        index = FeedIndex.fromBigInt(BigInt(previousIndex)).next();
      } else {
        const probed = await this.nextIndex(group, topic);
        const durableFloor = store.latestCommittedIndex(group);
        index = durableFloor !== null && probed.toBigInt() <= BigInt(durableFloor)
          ? FeedIndex.fromBigInt(BigInt(durableFloor)).next()
          : probed;
      }
      const intent = store.prepare({
        ...binding,
        eventId,
        index: Number(index.toBigInt()),
        playlist,
      });
      return this.settleManagedIntent(topic, intent, store);
    });
    return published ?? null;
  }

  private async settleManagedIntent(
    topic: Topic,
    intent: ManagedMasterIntent,
    store: ManagedMasterPersistence,
  ): Promise<PublishedMaster> {
    if (intent.status === 'committed') {
      this.indices.set(intent.group, FeedIndex.fromBigInt(BigInt(intent.index)));
      return { topic: intent.group, index: intent.index, reference: intent.reference! };
    }

    const index = FeedIndex.fromBigInt(BigInt(intent.index));
    const publisher = this.publishers.coordinator();
    const reader = publisher.bee.makeFeedReader(topic, this.signer.publicKey().address());
    try {
      const update = await reader.downloadPayload({ index });
      if (update.payload.toUtf8() !== intent.playlist) {
        throw new Error(`Managed master index ${intent.index} already contains another playlist`);
      }
      const reference = feedSlotReference(this.owner, topic, index).toHex();
      const committed = store.commit(intent, reference);
      this.indices.set(intent.group, index);
      return { topic: intent.group, index: intent.index, reference: committed.reference! };
    } catch (error) {
      if (!(error instanceof BeeResponseError) || (error.status !== 404 && error.status !== 503)) {
        throw error;
      }
    }

    const writer = publisher.bee.makeFeedWriter(topic, this.signer);
    const result = await retryUntilDeadlineAsync(
      () => writer.uploadPayload(publisher.stamp, intent.playlist, { index, deferred: true }),
      MASTER_RETRY_WINDOW_MS,
    );
    const committed = store.commit(intent, result.reference.toHex());
    this.indices.set(intent.group, index);
    return { topic: intent.group, index: intent.index, reference: committed.reference! };
  }

  /**
   * Where the next write goes.
   *
   * The first write of a process probes the feed rather than assuming index 0, because the group id
   * survives a restart: an uploader recovering a ladder mid-stream would otherwise overwrite the
   * master a viewer is already reading, and a feed cannot be rewound.
   */
  private async nextIndex(group: string, topic: Topic): Promise<FeedIndex> {
    if (this.indices.has(group)) {
      const current = this.indices.get(group)!;
      return current === null ? FeedIndex.fromBigInt(BigInt(0)) : current.next();
    }

    const existing = await this.readIndex(topic);
    this.indices.set(group, existing);
    return existing === null ? FeedIndex.fromBigInt(BigInt(0)) : existing.next();
  }

  private async readIndex(topic: Topic): Promise<FeedIndex | null> {
    try {
      const reader = this.publishers.coordinator().bee.makeFeedReader(topic, this.signer.publicKey().address());
      const data = await reader.downloadPayload();
      return data.feedIndex;
    } catch (error) {
      // 404 = topic never used, 503 = topic exists with no entries yet. Either way this ladder's
      // master starts at index 0. Anything else is rethrown: publishing over an unknown state is
      // how a viewer ends up reading a master that describes a different ladder.
      if (error instanceof BeeResponseError && (error.status === 404 || error.status === 503)) {
        return null;
      }
      throw error;
    }
  }
}
