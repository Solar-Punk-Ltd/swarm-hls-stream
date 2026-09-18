import { Rendition } from '../types.js';
import { getErrorMessage } from '../utils/common.js';

import { ADMIN_STATE_VOD, AdminApiClient, RenditionReportResponse } from './AdminApiClient.js';
import { advertisableRenditions, LadderLiveness } from './LadderLiveness.js';
import { LadderIdentity, LadderRegistry, RenditionAnnouncement } from './LadderRegistry.js';
import { Logger } from './Logger.js';
import { MasterFeedWriter } from './MasterFeedWriter.js';
import { ladderShape, MasterRewriteSchedule } from './MasterRewriteSchedule.js';

export interface AdminLadderRegistryOptions {
  client: AdminApiClient;
  masterWriter: MasterFeedWriter;
  /**
   * A monotonic reading in milliseconds, for the one thing here that measures a duration: how long a
   * failed master rewrite waits before a delivery may try it again. See {@link MasterRewriteSchedule}.
   */
  now?: () => number;
}

/**
 * The ladder registry admin mode uses: the admin holds the merge state, and this writes the master.
 *
 * ## What moves, and what does not
 *
 * Standalone, `StreamCatalog` holds one entry per ladder on the stream list feed, merges each rung's
 * record into it, and writes the master from the merged result. Admin mode moves the merge into the
 * admin's database — each rung posts its own record, the admin merges it by the rule
 * `StreamCatalog.keepingWhatFinished` states (a rung that has already finished stays finished when
 * it reports again without an index), stores it, writes `renditions` into its own catalog entry, and
 * answers with the merged ladder. The admin's rule additionally requires the report to name the same
 * feed, which the rule here deliberately does not compare — see `keepingWhatFinished` for why the
 * uploader has no reason to. What does NOT move is the master: the ladder's
 * multivariant playlist is still a Swarm feed this service signs and writes, and the feed's topic is
 * the **declared** topic, because that is where the admin's catalog entry already points a viewer.
 *
 * ⛔ **It holds no catalog and no catalog feed writer, and that is structural rather than a
 * convention.** The one rule admin mode has never been allowed to break is that this service writes
 * no stream catalog entry; a registry that could reach one is a registry a later change can make
 * write one.
 * The only feed it can address at all is the master's.
 *
 * ⛔ **The admin has to accept `live` after `vod`, and a rung's stable feed is why.** A declared
 * stream is one ladder for the life of the declaration, and its rungs' feeds outlive their sessions:
 * a broadcaster who stops and comes back is a ladder going `live` again under a stream the admin
 * already holds as `vod`, with its recordings sitting back to back on the same feeds and the entry
 * naming the latest. The admin ships that transition on its own branch; this service simply reports
 * what happened.
 *
 * ## Why `recordRungDelivered` never asks the admin
 *
 * A rung dying is not an announce — nothing reports it, and that is the whole of the ⛔⛔⛔ note on
 * `StreamCatalog.republishIfLadderShapeChanged`. The correction is a master rewritten from renditions
 * that are already known, so it needs no merge and no round trip: the merged ladder is held from the
 * last report and the rewrite is a single feed write. Asking the admin per delivery would put a
 * request per segment per rung onto it for the length of every broadcast.
 *
 * ## Why the flip is read off the stream's status as well as off `flippedToFinished`
 *
 * The admin flips `flippedToFinished` once, on the report that completed the merge, and
 * {@link upsertRendition} throws if the master write behind that report does not land. The merge has
 * already been committed by then — the master is built from what the merge returns, so it cannot be
 * the other way round — and the retry that follows is answered with a ladder that is already finished
 * and no flip. Handed back as-is, that is a broadcast that stays `live` in the admin's list for good.
 * So a finished ladder whose stream the admin does not yet hold as `vod` is reported as a flip too:
 * the admin accepts `vod -> vod`, so saying it twice costs a round trip, and saying it never costs the
 * recording its listing.
 */
export class AdminLadderRegistry implements LadderRegistry {
  private readonly logger = Logger.getInstance();
  private readonly client: AdminApiClient;
  private readonly masterWriter: MasterFeedWriter;
  private readonly rewrites: MasterRewriteSchedule;

  /** How far each ladder's rungs have got, one tracker per group. */
  private readonly liveness = new Map<string, LadderLiveness>();

  /**
   * The ladder the admin last merged, by group.
   *
   * ⛔ The admin's merge and never this process's own accumulation. Four rungs report concurrently and
   * each is answered with the whole ladder as it stood after its own report, so the newest merge is
   * the closest thing to the truth any of them can hold — and a rung rewriting the master from a
   * ladder it assembled itself would name only the rungs that happen to share its process.
   *
   * ⛔ Newest by the admin's own write index, never by arrival. See {@link adopt}.
   */
  private readonly merged = new Map<string, Rendition[]>();

  /** The catalog write index behind {@link merged}, by group, and absent while no answer carried one. */
  private readonly newestFeedIndex = new Map<string, number>();

  constructor(options: AdminLadderRegistryOptions) {
    this.client = options.client;
    this.masterWriter = options.masterWriter;
    this.rewrites = new MasterRewriteSchedule(options.now ?? (() => performance.now()));
  }

  /**
   * Report this rung to the admin, write the ladder's master from what comes back, and say what that
   * achieved.
   *
   * ⛔ **Throws when either half fails, because the caller has to treat it exactly as a failed catalog
   * announce.** `StreamUploader.announceToCatalog` catches, records the age `/health` reports as an
   * unlisted stream, and re-attempts on the announce cadence; `completeFinalize` lets it propagate so
   * the drain records a failure and the recovery entry stays on disk for the next boot. Both are the
   * behaviour a ladder announce has always had, and neither survives this answering quietly.
   *
   * The report goes first and the master second, which is the one ordering available: the master names
   * every rung of the ladder and only the merge knows what they are. The admin's entry already points
   * a viewer at this feed — it is the declared topic — so no entry is ever repointed, and there is no
   * window in which one resolves somewhere else.
   */
  public async upsertRendition(identity: LadderIdentity, rendition: Rendition): Promise<RenditionAnnouncement> {
    const adminStreamId = identity.adminStreamId;
    if (adminStreamId === undefined) {
      // Unreachable from the live path: the engine resolves the declaration before anything starts and
      // the orchestrator refuses an announce without one. Said rather than assumed, because the
      // alternative is a report addressed to `undefined` and a 404 that reads like a deleted stream.
      throw new Error(
        `Ladder ${identity.group} has no admin stream id, so its rung ${rendition.name} has nothing to report to`,
      );
    }

    const report = await this.client.reportRendition(adminStreamId, rendition);
    if (report === null) {
      throw new Error(
        `Could not report rendition ${rendition.name} of ladder ${identity.group} to the admin API, so the ` +
          'ladder it holds is missing this rung and no master can be written from it',
      );
    }

    const ladder = this.adopt(identity.group, rendition.name, report);

    const advertised = advertisableRenditions(ladder, this.livenessOf(identity.group));
    const published = await this.masterWriter.publish(identity.group, advertised);
    if (published) {
      // Only what the feed took, for the reason {@link MasterRewriteSchedule} states: a shape recorded
      // here that never landed is a correction a later rung death will never attempt.
      this.rewrites.recordAdvertised(identity.group, ladderShape(advertised.map((r) => r.name)));
    }

    // A ladder that is finished and not yet `vod` at the admin is owed a report whether or not this
    // is the announce that finished it — see the class doc. Null status is a body that did not say,
    // and then only the flip decides, which is what the contract guarantees on its own.
    const finishedButUnreported =
      report.ladder.finished && report.streamStatus !== null && report.streamStatus !== ADMIN_STATE_VOD;

    return {
      masterIndex: published?.index ?? null,
      flippedToFinished: report.ladder.flippedToFinished || finishedButUnreported,
      duration: report.ladder.duration,
    };
  }

  /**
   * Take an answer as the ladder this process holds for a group, unless a newer one has already been
   * taken, and say which ladder the master is to be written from.
   *
   * ⛔ Ordered by the admin's catalog write index and never by arrival. Four rungs report concurrently,
   * the admin merges them in one order, and their answers can land here in another. Writing each master
   * from its own answer let an older merge arriving last publish a master missing a rung a newer answer
   * had already named — a quality gone from the ladder until the next announce, which a steady
   * broadcast can go its whole length without producing. An answer carrying no index is taken as it
   * comes, which is what every answer was before the index was read.
   */
  private adopt(group: string, rung: string, report: RenditionReportResponse): Rendition[] {
    const newest = this.newestFeedIndex.get(group);
    if (report.feedIndex !== null && newest !== undefined && report.feedIndex < newest) {
      const held = this.merged.get(group);
      if (held !== undefined) {
        this.logger.log(
          `[AdminLadderRegistry] The answer to ${rung} of ladder ${group} is an older merge (catalog index ` +
            `${report.feedIndex}) than one already applied (${newest}); the master is written from the newer ladder`,
        );
        return held;
      }
    }
    this.merged.set(group, report.renditions);
    if (report.feedIndex !== null) {
      this.newestFeedIndex.set(group, report.feedIndex);
    }
    return report.renditions;
  }

  public recordRungDelivered(group: string, rung: string): void {
    const liveness = this.livenessOf(group);
    liveness.recordDelivered(rung);
    this.republishIfLadderShapeChanged(group, liveness.liveRungs());
  }

  /**
   * Rewrite the master when the set of producing rungs changes, and only then.
   *
   * Fire and forget, deliberately: the caller is the segment path and a master write is a feed write
   * behind a queue. The whole of the ⛔⛔⛔ account of why this exists at all — a rung dying is not an
   * announce, so the announce path never asks — is on `StreamCatalog.republishIfLadderShapeChanged`.
   */
  private republishIfLadderShapeChanged(group: string, liveRungs: readonly string[]): void {
    if (!this.merged.has(group)) {
      // Nothing has announced this ladder yet, so there is no master to correct and no ladder to write
      // one from. The first announce publishes the right shape anyway.
      return;
    }

    const shape = ladderShape(liveRungs);
    if (!this.rewrites.beginRewrite(group, shape)) {
      return;
    }

    void this.rewriteMaster(group, shape);
  }

  /** Runs one rewrite and records what it actually achieved. Never rejects: its caller is a segment. */
  private async rewriteMaster(group: string, shape: string): Promise<void> {
    try {
      // ⛔ The ladder as it stands when the write runs, never the one it stood at when this rewrite was
      // scheduled. A rewrite is queued from a segment and settles turns later, so a sibling rung's
      // announce can land a newer merge in between — and writing the older one over the master that
      // announce just published would take a rung back off the ladder until something else moved.
      // `StreamCatalog` gets the same freshness by reading its catalog entry inside its own write.
      const advertised = advertisableRenditions(this.merged.get(group) ?? [], this.livenessOf(group));
      const published = await this.masterWriter.publish(group, advertised);
      if (published) {
        this.logger.log(
          `[AdminLadderRegistry] Ladder ${group} now produces ${advertised.length} rung(s), master rewritten`,
        );
        this.rewrites.rewriteLanded(group, shape);
        return;
      }
      // Resolved without writing, which is a ladder with no rendition left to name. Held off like a
      // failure: it is a condition that persists, and asking again on the next segment would ask
      // several times a second for the rest of the broadcast.
      this.rewrites.holdOff(group);
    } catch (error) {
      this.rewrites.holdOff(group);
      this.logger.error(
        `[AdminLadderRegistry] Could not rewrite the master for ${group} after its rungs changed: ${getErrorMessage(
          error,
        )}`,
      );
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
}
