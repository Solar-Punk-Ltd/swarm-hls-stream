import { Bee, BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import PQueue from 'p-queue';

import { Rendition } from '../types.js';
import { retryAwaitableAsync } from '../utils/common.js';

import { Logger } from './Logger.js';
import { buildMasterPlaylist } from './MasterPlaylist.js';

/** Where a published master lives, and which of its indices holds the version just written. */
export interface PublishedMaster {
  topic: string;
  index: number;
}

/**
 * Publishes each ladder's multivariant playlist to a feed of its own.
 *
 * The feed's topic *is* the ladder's group id. That is deliberate rather than convenient: the
 * group is the one identifier every rung already agrees on and the catalog already carries, so a
 * viewer holding a catalog entry needs nothing further to find the master, and a rung that
 * restarts mid-ladder republishes to the same place instead of stranding a second master.
 *
 * The rung topics, by contrast, are fresh UUIDs per uploader and must stay that way — a rung that
 * stopped and restarted while its siblings kept the ladder alive would otherwise be handed the
 * topic it just finished writing and start overwriting it at index 0.
 */
export class MasterFeedWriter {
  private indices = new Map<string, FeedIndex | null>();
  private queue = new PQueue({ concurrency: 1 });
  private logger = Logger.getInstance();

  constructor(
    private readonly bee: Bee,
    private readonly signer: PrivateKey,
    private readonly stamp: string,
  ) {}

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

      const writer = this.bee.makeFeedWriter(topic, this.signer);
      await retryAwaitableAsync(() => writer.uploadPayload(this.stamp, playlist, { index }));

      this.indices.set(group, index);
      this.logger.debug(
        `[MasterFeedWriter] Master for ladder ${group} written at index ${index.toString()} with ` +
          `${renditions.length} rung(s): ${renditions.map((r) => r.name).join(', ')}`,
      );

      return { topic: group, index: Number(index.toBigInt()) };
    });

    return published ?? null;
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
      const reader = this.bee.makeFeedReader(topic, this.signer.publicKey().address());
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
