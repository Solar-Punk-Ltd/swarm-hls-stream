import { BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import { catalogStateLost, ladderFinalized } from '@swarm-hls-stream/shared';
import PQueue from 'p-queue';

import { MediaType, Rendition, STREAM_STATUS_LIVE, STREAM_STATUS_VOD, StreamStatus } from '../types.js';
import { extractHttpStatus, getErrorMessage, isFeedAbsent, retryUntilDeadlineAsync } from '../utils/common.js';

import { BeePublisher, BeePublisherPool, safeUrl } from './BeePublisherPool.js';
import { CatalogIndexStore } from './CatalogIndexStore.js';
import { ErrorHandler } from './ErrorHandler.js';
import { hasRecording, isFinishedLadder, recordedRungs, recordingDuration } from './LadderCompletion.js';
import { advertisableRenditions, LadderLiveness } from './LadderLiveness.js';
import { LadderIdentity, LadderRegistry, RenditionAnnouncement } from './LadderRegistry.js';
import { Logger } from './Logger.js';
import { MasterFeedWriter, PublishedMaster } from './MasterFeedWriter.js';
import { ladderShape, MasterRewriteSchedule } from './MasterRewriteSchedule.js';
import { NodeUnreachableError } from './NodeUnreachableError.js';

const CATALOG_RETRY_WINDOW_MS = 10_000;

// Re-exported from where they are now declared, so nothing that named them here has to move. The
// rewrite schedule moved out because the admin-mode ladder registry runs the same one; the identity
// moved out because it describes a ladder rather than a catalog, and both registries are handed one.
export { MASTER_REWRITE_RETRY_MS } from './MasterRewriteSchedule.js';
export type { LadderIdentity } from './LadderRegistry.js';

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
   * makes the entry unique, because four rungs merge into one entry and each of them writes it.
   */
  group?: string;
  renditions?: Rendition[];
  /**
   * Rungs of this ladder whose session ended without a recording, by name, and absent while there are
   * none. See `LadderRegistry.recordRungUnfinished`.
   *
   * ⛔ Kept beside `renditions` rather than as a mark on a rendition, so that a finished entry's
   * `renditions` names only rungs that have a recording. A viewer built before this field existed reads
   * nothing but `renditions`, and every rung it finds there on a finished entry is one it can play.
   */
  unfinishedRungs?: string[];
}

/** What merging one rung into its ladder says about that rung, beyond its own record. */
interface RungMerge {
  /** The rung's session ended without a recording, so the ladder is not to wait for it. */
  unfinished?: boolean;
}

export class StreamCatalog implements LadderRegistry {
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

  /**
   * How far each ladder's rungs have got, one tracker per group.
   *
   * ⛔ Kept here rather than in {@link MasterFeedWriter} because the writer is handed a rendition
   * list and should stay that way: what a master is ALLOWED to say is a catalog decision, and the
   * writer's job is to write what it is given.
   */
  private readonly liveness = new Map<string, LadderLiveness>();

  /**
   * When a rung dying may rewrite this ladder's master, and what a rewrite that did not land costs.
   *
   * ⛔ Lifted into {@link MasterRewriteSchedule} rather than kept here, because the admin-mode ladder
   * registry has to run the same rules and every one of them is a fix for a measured live failure.
   * The rules and the reasons for them are stated there; nothing about them changed in the move.
   */
  private readonly rewrites: MasterRewriteSchedule;

  /** The identity each ladder last announced under, so a rung dying can be written as that owner. */
  private readonly lastIdentity = new Map<string, LadderIdentity>();

  /**
   * One segment of this rung reached Swarm.
   *
   * Called from the uploader's segment path beside the per-rung metric, because that is the one
   * place a delivery is known to have actually landed rather than been attempted.
   */
  public recordRungDelivered(group: string, rung: string): void {
    const liveness = this.livenessOf(group);
    liveness.recordDelivered(rung);
    this.republishIfLadderShapeChanged(group, liveness.liveRungs());
  }

  /** One segment of this rung was dropped. See {@link LadderRegistry.recordRungUploadFailed}. */
  public recordRungUploadFailed(group: string, rung: string): void {
    const liveness = this.livenessOf(group);
    liveness.recordUploadFailed(rung);
    this.republishIfLadderShapeChanged(group, liveness.liveRungs());
  }

  /**
   * Rewrite the master when the set of producing rungs changes, and only then.
   *
   * ⛔⛔⛔ **Without this the filter never runs at the moment it matters.** `upsertRendition` is the
   * only path that writes a master, and it fires on a rendition announce: at startup and on bitrate
   * drift. A rung dying is neither. Measured live 2026-09-01 over a clean two minute outage with
   * `activeStreams 3` throughout, the master was not rewritten once, so a viewer joining was offered
   * the dead rung for the whole outage even with the filter deployed and correct.
   *
   * Fire and forget, deliberately: the caller is the segment path and a master write is a feed write
   * behind a queue. A burst of deliveries across one transition still queues a single rewrite,
   * because {@link MasterRewriteSchedule.beginRewrite} marks the shape being written as in flight
   * until that write settles.
   *
   * ⛔ **A rewrite that did not reach the feed is not a shape anyone is being offered, and this used
   * to record it as one.** `advertised` was stamped before the write ran, so a master the writer
   * could not publish was remembered as published: `republishMaster` rejects when the master feed
   * exhausts its own retry window, the catch only logged, and nothing ever tried again. The reasoning
   * written here leaned on the next transition or the next announce to put it right, and a steady
   * broadcast produces neither, so one failed write left a viewer joining that broadcast offered a
   * dead rung for the rest of it. Now `advertised`, kept in {@link MasterRewriteSchedule} since #235,
   * records only what the feed took, and a failure holds the group off for
   * {@link MASTER_REWRITE_RETRY_MS} rather than for good.
   */
  private republishIfLadderShapeChanged(group: string, liveRungs: readonly string[]): void {
    if (this.masterWriter === undefined) {
      // No master exists to correct: the entry points a viewer straight at a rung. See `upsertRendition`.
      return;
    }

    const identity = this.lastIdentity.get(group);
    if (identity === undefined) {
      // Nothing has announced this ladder yet, so there is no master to correct and no owner to
      // write as. The first announce publishes the right shape anyway.
      return;
    }

    const shape = ladderShape(liveRungs);
    if (!this.rewrites.beginRewrite(group, shape)) {
      return;
    }

    void this.rewriteMaster(group, shape, identity);
  }

  /** Runs one rewrite and records what it actually achieved. Never rejects: its caller is a segment. */
  private async rewriteMaster(group: string, shape: string, identity: LadderIdentity): Promise<void> {
    try {
      if (await this.republishMaster(identity)) {
        this.rewrites.rewriteLanded(group, shape);
        return;
      }
      // Resolved without writing, which is the ladder having no entry to rewrite or no rendition left
      // to name. Held off like a failure: both are conditions that persist, and asking again on the
      // next segment would ask several times a second for the rest of the broadcast.
      this.rewrites.holdOff(group);
    } catch (error) {
      this.rewrites.holdOff(group);
      this.logger.error(`[StreamCatalog] Could not rewrite the master for ${group} after its rungs changed:`, error);
    } finally {
      this.rewrites.endRewrite(group, shape);
    }
  }

  private livenessOf(group: string): LadderLiveness {
    const existing = this.liveness.get(group);
    if (existing) {
      return existing;
    }
    const created = new LadderLiveness();
    this.liveness.set(group, created);
    return created;
  }

  /**
   * @param now a monotonic reading in milliseconds, for the one thing here that measures a duration:
   * how long a failed master rewrite waits before it may be tried again. Monotonic rather than a
   * date so a clock adjustment cannot move the deadline, and injected so a test can step it rather
   * than wait out {@link MASTER_REWRITE_RETRY_MS}.
   */
  constructor(
    publishers: BeePublisherPool,
    streamKey: string,
    feedTopic: string,
    indexStore?: CatalogIndexStore,
    masterWriter?: MasterFeedWriter,
    now: () => number = () => performance.now(),
  ) {
    this.publishers = publishers;
    this.signer = new PrivateKey(streamKey);
    this.feedTopic = Topic.fromString(feedTopic);
    this.indexStore = indexStore;
    this.masterWriter = masterWriter;
    this.rewrites = new MasterRewriteSchedule(now);

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
      // ⚠️ An absent feed is an answer here and is no answer at all on the uploader's
      // recovered-finalize read, which retries both of these statuses instead. The asymmetry is not
      // an oversight: boot has no prior knowledge of this feed, so "topic exists, no update yet"
      // really is an empty catalog, while that read runs only over a feed the stream has already
      // written to. Answering "empty" to either status there republishes a recording.
      if (isFeedAbsent(error)) {
        if (persisted !== null) {
          this.resumeFromPersisted(persisted, 'Boot lookup found no feed');
          return;
        }

        // ⛔⛔⛔ Only when the node said so. Beginning at index 0 is the one answer here that cannot
        // be taken back: every reader following the original chain keeps following it, and the
        // entries this process writes are invisible to all of them.
        if (!(await this.absenceIsAnAnswer(error))) {
          throw new NodeUnreachableError(
            `[StreamCatalog] ${safeUrl(this.publisher.url)} answered ${extractHttpStatus(error)} for the catalog ` +
              'feed head and does not report itself ready, so whether this feed exists is unknown. Refusing to ' +
              'begin at index 0, which would fork the feed for every reader that keeps following the original chain.',
          );
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

      // Everything else stays as loud as it was. A request that never reached the node, a wrong url,
      // a wrong port, a node that is down, is rethrown here so the wait around the boot retries it
      // rather than starting an uploader that cannot publish, and without a persisted index there is
      // no floor to continue above: the head's index is unknown, and beginning at 0 would write into
      // occupied indices and fork the feed invisibly for every reader that keeps following the
      // original chain.
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
   * Whether "there is no feed here" is something the node actually said.
   *
   * ⛔ `isFeedAbsent` accepts 404 and 503, and the two are not the same evidence. Only a serving node
   * answers 404, so that one settles it. bee answers 503 both for a feed with no update yet and for a
   * node that cannot serve the request at all, and an intermediary in front of a node that is not
   * there answers it too, so a 503 on its own says nothing about the feed.
   *
   * Before D16 this could not be reached with a node that was down, because `ChequebookGate` threw on
   * the same node first. That shield was removed on purpose, so the question is asked here instead.
   */
  private async absenceIsAnAnswer(error: unknown): Promise<boolean> {
    if (extractHttpStatus(error) === 404) {
      return true;
    }

    try {
      await this.publisher.bee.getReadiness();
      return true;
    } catch (readinessError) {
      this.logger.error(
        `[StreamCatalog] ${safeUrl(this.publisher.url)} answered 503 for the boot lookup and its readiness ` +
          `check did not answer either (${getErrorMessage(readinessError)})`,
      );
      return false;
    }
  }

  /**
   * Whether the node is up and it was only the head's payload that failed to arrive.
   *
   * The error codes for a transfer that broke on the way back cover a request that timed out as
   * well as one whose body was dropped, so the code alone cannot say which happened. A node that
   * answers a liveness check immediately afterwards is the evidence that the payload was the
   * problem. One that does not answer makes this false, so `init` rethrows instead of resuming from
   * the persisted index.
   *
   * That rethrow is waited on like any other. Until 2026-09-17 this one was not: a dropped body
   * arrives as `ECONNABORTED` on `statusText` with the message "response stream aborted", and the
   * wait read neither of those, so the boot ended here while every other rethrow was retried. See
   * `transportCodeOf` in `NodeWait.ts` for what bee-js does with a transport code and why a fixture
   * of our own hid it for so long.
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

  /**
   * Publish one single-rendition stream's entry, replacing whatever this owner last wrote for the
   * same topic.
   *
   * @returns whether this write is the moment the entry became a recording, meaning it carries
   * `vod` and what the catalog held did not. The caller announces the flip off this rather than off
   * its own intent, for the reason {@link upsertRendition} records on the ladder's side of the same
   * question: a resumed finalize rewrites an entry that already says `vod`, and a session announcing
   * a flip it did not cause reports one broadcast ending twice. False is also the honest answer for
   * the live announce, which flips nothing.
   */
  public async addStream(entry: StreamEntry): Promise<boolean> {
    let flippedToVod = false;

    await this.queue.add(() =>
      this.writeFeed((previous) => {
        const held = previous.find((e) => e.owner === entry.owner && e.topic === entry.topic);
        flippedToVod = entry.state === STREAM_STATUS_VOD && held?.state !== STREAM_STATUS_VOD;
        return [...withoutTopic(previous, entry.owner, entry.topic), entry];
      }),
    );

    return flippedToVod;
  }

  /**
   * Merges one rung into its ladder's single catalog entry, creating the entry if this is the
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
   *
   * @returns what this announce achieved for the whole ladder. See {@link RenditionAnnouncement}: the
   * flip is read off the entry the catalog held rather than off the caller's intent, for the reason
   * the `ladderFinalized` line below is written after the write and only when it really flipped.
   */
  public async upsertRendition(identity: LadderIdentity, rendition: Rendition): Promise<RenditionAnnouncement> {
    return this.mergeIntoLadder(identity, rendition, {});
  }

  /**
   * Record that this rung ended without a recording, so its ladder no longer waits for it. See
   * {@link LadderRegistry.recordRungUnfinished}.
   *
   * The same merge and the same two writes as {@link upsertRendition}, master first, so the
   * `ladderFinalized` line keeps its one meaning: said once, after the write that made the entry a
   * recording, whichever path that write came from. On 2026-09-23 it would have been a sibling's
   * announce, because 1080p stopped two seconds before the last three rungs finalized. Stopping after
   * them, this is the write that finishes the ladder.
   */
  public async recordRungUnfinished(identity: LadderIdentity, rendition: Rendition): Promise<RenditionAnnouncement> {
    return this.mergeIntoLadder(identity, rendition, { unfinished: true });
  }

  private async mergeIntoLadder(
    identity: LadderIdentity,
    rendition: Rendition,
    merge: RungMerge,
  ): Promise<RenditionAnnouncement> {
    let flippedToVod = false;
    let shapeThatLanded: string | null = null;
    let masterIndex: number | null = null;
    let duration: number | null = null;

    await this.queue.add(async () => {
      await this.writeFeed(async (previous) => {
        const held = previous.find((e) => e.owner === identity.owner && e.group === identity.group);
        if (merge.unfinished && held === undefined) {
          // No rung of this ladder was ever listed, so nothing waits for this one and no viewer can
          // find the ladder. An entry written now would list a broadcast that was never announced.
          return null;
        }
        const wasVod = held?.state === STREAM_STATUS_VOD;
        const entry = buildLadderEntry(identity, previous, rendition, merge);
        // ⛔ The guard's own input, which has never been recorded and is why scenario H has cost
        // three sittings. Every round has been able to see the DECISION (`Ladder … finalized to VOD`)
        // and never the STATE it was made from, so each explanation had to be reasoned rather than
        // read, and three of them were wrong. Debug rather than log: it fires on every announce.
        this.logger.debug(
          `[StreamCatalog] Ladder ${identity.group}: the catalog held ` +
            `${held === undefined ? 'no entry' : `state=${held.state} renditions=${held.renditions?.length ?? 0}`}` +
            `, this announce carries ${rendition.name}` +
            `${rendition.index === undefined ? ' with no index' : ` at index ${rendition.index}`}` +
            `${merge.unfinished ? ' that will not finish' : ''}` +
            `, so the entry becomes ${entry.state}`,
        );
        flippedToVod = entry.state === STREAM_STATUS_VOD && !wasVod;
        duration = entry.duration ?? null;
        // ⛔ A master naming a rung nothing is producing offers a viewer a quality with nothing
        // behind it. The player moves them off within about seven seconds, so this is the last few
        // seconds of that harm rather than all of it, and it is harm a stream need not cause.
        const advertised = advertisableRenditions(entry.renditions ?? [], this.livenessOf(identity.group));
        // Remembered here because this is the path that always runs: a ladder that never announces
        // has no master for a rung death to correct, and no owner to write it as.
        this.lastIdentity.set(identity.group, identity);
        const published = await this.masterWriter?.publish(identity.group, advertised);
        if (published) {
          shapeThatLanded = ladderShape(advertised.map((rendition) => rendition.name));
          masterIndex = published.index;
        }

        return [
          ...withoutGroup(previous, identity.owner, identity.group),
          published ? withMaster(entry, published) : entry,
        ];
      });

      // ⛔ After the write and only when the master went out, for the reason the line below is after
      // it too. `advertised` is what a later rung death compares itself against, so a shape recorded
      // here that the feed did not take is a correction that will never be attempted. This announce
      // can fail at the master write or at the catalog write that names it, and neither leaves a
      // viewer resolving the new shape.
      if (shapeThatLanded !== null) {
        this.rewrites.recordAdvertised(identity.group, shapeThatLanded);
      }

      // ⛔⛔⛔ After the write, never inside the update. The one externally visible moment a ladder
      // ends, and the line scenario H arms its kill on, so written from inside the callback it
      // announced a flip the feed had not taken yet: the master write and the catalog write both
      // still lay ahead of it. A crash there left the log claiming a finished ladder over an entry
      // that honestly still said `live`, and the reboot then flipped it for real and said so again.
      // Two lines, one flip, and no process wrong about itself. Here it means the entry IS vod.
      if (flippedToVod) {
        this.logger.log(ladderFinalized(identity.group));
      }
    });

    return { masterIndex, flippedToFinished: flippedToVod, duration };
  }

  /**
   * Rewrite one ladder's master from the entry the catalog already holds, and answer whether the new
   * shape reached the feed.
   *
   * Shares `writeFeed` with {@link upsertRendition} rather than reaching for the master writer
   * directly, because the entry carries the master's index and a master written without updating it
   * leaves the catalog pointing a viewer at the previous version.
   *
   * That is also why the answer is taken from inside the update and returned only once the whole
   * write has settled: a master on its own feed that no catalog entry names yet is one no viewer
   * resolves, so it is not a shape this ladder is advertising. Two ways to reach here having written
   * nothing, and neither throws: the group has no catalog entry, and the master writer had no
   * rendition to name.
   */
  private async republishMaster(identity: LadderIdentity): Promise<boolean> {
    let rewritten = false;

    await this.queue.add(() =>
      this.writeFeed(async (previous) => {
        const entry = previous.find((e) => e.owner === identity.owner && e.group === identity.group);
        if (!entry) {
          return previous;
        }

        const advertised = advertisableRenditions(entry.renditions ?? [], this.livenessOf(identity.group));
        const published = await this.masterWriter?.publish(identity.group, advertised);
        if (!published) {
          return previous;
        }

        this.logger.log(
          `[StreamCatalog] Ladder ${identity.group} now produces ${advertised.length} rung(s), master rewritten`,
        );
        rewritten = true;
        return [...withoutGroup(previous, identity.owner, identity.group), withMaster(entry, published)];
      }),
    );

    return rewritten;
  }

  /** @param update the entries to write, or null when it found nothing to change, which writes nothing. */
  private async writeFeed(
    update: (previous: StreamEntry[]) => StreamEntry[] | null | Promise<StreamEntry[] | null>,
  ): Promise<void> {
    let previous: StreamEntry[] = [];

    if (this.feedIndex !== null) {
      previous = await this.readPreviousState();
    }

    const state = await update(previous);
    if (state === null) {
      return;
    }

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

      this.logger.error(catalogStateLost(index, this.unreadableStateReads));
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
 * The ladder's entry after merging one rung's latest state into it.
 *
 * A ladder goes to VOD once every rung it has announced has finalized or is known not to finish, and
 * at least one of them finalized. See `LadderCompletion`. Doing it per rung would flip the whole entry
 * to VOD on the first one to drain, and the other three are still live.
 *
 * ⛔ A finished entry's `renditions` names only rungs that have a recording, and `topic`, `index` and
 * `duration` are all read off those, so nothing in it or built from it offers a viewer a rung with
 * nothing to play. A rung that did not finish is named in `unfinishedRungs` instead.
 */
export function buildLadderEntry(
  identity: LadderIdentity,
  previous: StreamEntry[],
  rendition: Rendition,
  merge: RungMerge = {},
): StreamEntry {
  const existing = previous.find((e) => e.owner === identity.owner && e.group === identity.group);
  const merged = mergeRendition(existing?.renditions ?? [], rendition);
  const unfinishedRungs = unfinishedAfter(existing?.unfinishedRungs ?? [], merged, rendition.name, merge);
  const finished = isFinishedLadder(merged, new Set(unfinishedRungs));
  const renditions = finished ? recordedRungs(merged) : merged;

  // Lowest rung first: it is the cheapest to bootstrap, and it is what a client that knows
  // nothing about `renditions` will play when it follows `topic`.
  const primary = renditions[0];

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

  if (unfinishedRungs.length > 0) {
    entry.unfinishedRungs = unfinishedRungs;
  }

  if (finished) {
    entry.index = primary.index;
    entry.duration = recordingDuration(renditions);
  }

  return entry;
}

/**
 * The rungs still known not to finish once this merge is in.
 *
 * ⛔ The mark survives every later merge of its rung that carries no index, because that is what a rung
 * recovered at the next boot sends before it finalizes, and dropping the mark there would turn a
 * finished recording back into a live broadcast. It goes only once the rung has a recording to point
 * at. A rung that already has one is never marked, since the ladder can offer that recording.
 */
function unfinishedAfter(
  held: readonly string[],
  merged: readonly Rendition[],
  rung: string,
  merge: RungMerge,
): string[] {
  const record = merged.find((rendition) => rendition.name === rung);
  if (record !== undefined && hasRecording(record)) {
    return held.filter((name) => name !== rung);
  }
  return merge.unfinished && !held.includes(rung) ? [...held, rung] : [...held];
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
  const previous = existing.find((r) => r.name === incoming.name);
  const merged = existing.filter((r) => r.name !== incoming.name);
  merged.push(keepingWhatFinished(previous, incoming));
  return merged.sort((a, b) => a.height - b.height);
}

/**
 * A rung that has already finished stays finished when it announces itself again.
 *
 * ⛔⛔⛔ Scenario H, caused 2026-09-01 after being an open red since 2026-08-31. A rung recovered
 * from a crash announces itself before it finalizes, and that announcement carries no `index`
 * because it has not published its recording yet. The merge replaced the finished rendition
 * wholesale, so the index recorded when the rung DID finalize was thrown away,
 * `renditions.every(r => r.index !== undefined)` went false, and **the whole finished ladder went
 * back to `live` in the catalog**. Read off the host log: ladder `fdbd7167` finalized at 05:58:04,
 * was killed, rebooted with a clean catalog read, and finalized again at 05:59:08 when the recovery
 * timer fired. For that minute a recording that had ended was advertised as a live broadcast, and
 * the second flip paid for another catalog write.
 *
 * `index`, `duration` and `topic` move together or not at all: the index names a position inside the
 * feed the topic addresses, so keeping one without the other would point at a place in the wrong
 * feed. Everything the re-announce genuinely knows better — the measured bitrates — is taken from it.
 *
 * ⛔ **A rung's topic is stable, and this rule is written for that and NOT against it.** Since a
 * rung's feed topic is derived from its ladder group and its rung name, the re-announce carries the
 * same topic the finished record already holds, and a rung that stopped and started again is live
 * again on the same feed. That is not a reason to compare topics here. The question this answers is
 * whether a recording that has been published is still the one to point at, and until the returning
 * session finalizes there is nothing else to point at: its own recording does not exist yet, and the
 * previous one is whole at the index kept here. The next finalize arrives WITH an index and replaces
 * the record wholesale, which is the first branch below and which is how the entry comes to name the
 * latest of however many recordings that feed holds.
 */
function keepingWhatFinished(previous: Rendition | undefined, incoming: Rendition): Rendition {
  if (previous?.index === undefined || incoming.index !== undefined) {
    return incoming;
  }
  return { ...incoming, topic: previous.topic, index: previous.index, duration: previous.duration };
}
