import { Rendition } from '../types.js';
import { getErrorMessage } from '../utils/common.js';

import { ADMIN_STATE_VOD, AdminApiClient, RenditionReportResponse } from './AdminApiClient.js';
import { isFinishedLadder, recordedRungs, recordingDuration } from './LadderCompletion.js';
import { advertisableRenditions, LadderLivenessBook } from './LadderLiveness.js';
import { LadderIdentity, LadderRegistry, RenditionAnnouncement } from './LadderRegistry.js';
import { Logger } from './Logger.js';
import { MasterFeedWriter } from './MasterFeedWriter.js';
import { ladderShape, MasterRewriteSchedule } from './MasterRewriteSchedule.js';

interface AdminLadderRegistryOptions {
  client: AdminApiClient;
  masterWriter: MasterFeedWriter;
  /**
   * A monotonic reading in milliseconds, for the one thing here that measures a duration: how long a
   * failed master rewrite waits before a delivery may try it again. See {@link MasterRewriteSchedule}.
   */
  now?: () => number;
}

const NO_RUNGS: ReadonlySet<string> = new Set();

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
 * already holds as `vod`, each new recording opening with the one already at its feed's head, so the
 * entry names a recording of the whole broadcast. The admin ships that transition on its own branch;
 * this service simply reports what happened.
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
 *
 * ## Why a rung that will not finish is judged here and not by the admin
 *
 * The admin counts a ladder finished only when every rung it holds has an index, and its rendition
 * route refuses any field it does not know, so it cannot be told that a rung will not finish. On
 * 2026-09-23 that rung was 1080p, whose batch refused its recording, and the ladder never finished.
 * So this registry holds the mark itself, judges the ladder by `LadderCompletion`, and reports the flip
 * off that judgement and the status the admin holds. What outlives this process is the admin's `vod`:
 * once it holds one, a master names only rungs with a recording, whatever a later announce reports.
 */
export class AdminLadderRegistry implements LadderRegistry {
  private readonly logger = Logger.getInstance();
  private readonly client: AdminApiClient;
  private readonly masterWriter: MasterFeedWriter;
  private readonly rewrites: MasterRewriteSchedule;

  /** How far each ladder's rungs have got, one tracker per group. */
  private readonly liveness = new LadderLivenessBook();

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

  /** The stream's status in the answer {@link merged} came from, by group, or null when it did not say. */
  private readonly heldStatus = new Map<string, string | null>();

  /**
   * Rungs this process knows will not finish, by group. See {@link recordRungUnfinished}.
   *
   * ⚠️ In memory only, which is enough for the one decision it serves: whether the broadcast that rung
   * belonged to has finished. Cleared once the admin holds the stream as `vod`, because a declared
   * stream is one ladder for many broadcasts, and a mark kept into the next one would list it as a
   * recording before its own rungs finished.
   */
  private readonly unfinished = new Map<string, Set<string>>();

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
    return this.reportAndPublish(identity, rendition);
  }

  /**
   * Record that this rung ended without a recording, report the rung to the admin as it stands, and
   * write the master from the ladder that comes back. See {@link LadderRegistry.recordRungUnfinished}.
   *
   * Reported rather than judged off the ladder held here, so it also works in a process that holds
   * nothing: a rung whose recovery entry is retried at the next boot and fails again is marked by a
   * process that never saw the rest of its ladder. The report carries no index, and the admin keeps
   * the index it holds for a rung that reports on the same feed without one, so it cannot change what
   * the admin says this rung recorded.
   *
   * The mark goes on first and stays even when the report fails, because it is this process's own
   * knowledge: a sibling that finishes afterwards still finds it and finishes the ladder.
   */
  public async recordRungUnfinished(identity: LadderIdentity, rendition: Rendition): Promise<RenditionAnnouncement> {
    this.markUnfinished(identity.group, rendition.name);
    return this.reportAndPublish(identity, rendition);
  }

  private async reportAndPublish(identity: LadderIdentity, rendition: Rendition): Promise<RenditionAnnouncement> {
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

    const { group } = identity;
    if (rendition.index !== undefined) {
      this.unfinished.get(group)?.delete(rendition.name);
    }
    this.adopt(group, rendition.name, report);
    if (report.streamStatus === ADMIN_STATE_VOD) {
      this.unfinished.delete(group);
    }

    const advertised = advertisableRenditions(this.offeredRungs(group), this.liveness.of(group));
    const published = await this.masterWriter.publish(group, advertised);
    if (published) {
      // Only what the feed took, for the reason {@link MasterRewriteSchedule} states: a shape recorded
      // here that never landed is a correction a later rung death will never attempt.
      this.rewrites.recordAdvertised(group, ladderShape(advertised.map((r) => r.name)));
    }

    return { masterIndex: published?.index ?? null, ...this.recordingOf(report, group) };
  }

  /**
   * Whether this answer is the moment the ladder became a recording, and how long the recording plays.
   *
   * The admin raises `flippedToFinished` on the report that completed ITS merge, where every rung has an
   * index, and it cannot see a rung that will not finish. So the flip is read off `LadderCompletion`'s
   * judgement of the ladder in this answer and the status the admin holds: finished and not yet held as
   * `vod` is a flip to report, and held as `vod` is not. That includes the report on which the admin's
   * own merge first finishes because the rung left out finished after all, which adds that rung to the
   * master and is not a second ending. Judged on this answer's own ladder, the way the admin's flag is.
   */
  private recordingOf(
    report: RenditionReportResponse,
    group: string,
  ): Pick<RenditionAnnouncement, 'flippedToFinished' | 'duration'> {
    const heldAsRecording = report.streamStatus === ADMIN_STATE_VOD;
    const finished = isFinishedLadder(report.renditions, this.markedUnfinished(group));
    // A finished ladder not yet `vod` at the admin is owed a report whether or not this is the announce
    // that finished it, as the class doc says. Null status is a body that did not say, and then only the
    // admin's own flip decides, which cannot see a rung that will not finish.
    const finishedButUnreported = finished && report.streamStatus !== null && !heldAsRecording;
    return {
      flippedToFinished: (report.ladder.flippedToFinished && !heldAsRecording) || finishedButUnreported,
      duration:
        finished && !report.ladder.finished
          ? recordingDuration(recordedRungs(report.renditions))
          : report.ladder.duration,
    };
  }

  /**
   * The rungs a master for this ladder may name before the liveness filter: every rung while the ladder
   * is live, and only those with a recording once it is one. A viewer of a recording must never be
   * offered a rung whose feed holds nothing but a live playlist that will not end.
   */
  private offeredRungs(group: string): Rendition[] {
    const ladder = this.merged.get(group) ?? [];
    const isRecording =
      this.heldStatus.get(group) === ADMIN_STATE_VOD || isFinishedLadder(ladder, this.markedUnfinished(group));
    return isRecording ? recordedRungs(ladder) : ladder;
  }

  private markedUnfinished(group: string): ReadonlySet<string> {
    return this.unfinished.get(group) ?? NO_RUNGS;
  }

  private markUnfinished(group: string, rung: string): void {
    const marked = this.unfinished.get(group) ?? new Set<string>();
    marked.add(rung);
    this.unfinished.set(group, marked);
  }

  /**
   * Take an answer as the ladder this process holds for a group, unless a newer one has already been
   * taken. The master is written from whichever ladder that leaves held.
   *
   * ⛔ Ordered by the admin's catalog write index and never by arrival. Four rungs report concurrently,
   * the admin merges them in one order, and their answers can land here in another. Writing each master
   * from its own answer let an older merge arriving last publish a master missing a rung a newer answer
   * had already named — a quality gone from the ladder until the next announce, which a steady
   * broadcast can go its whole length without producing. An answer carrying no index is taken as it
   * comes, which is what every answer was before the index was read.
   */
  private adopt(group: string, rung: string, report: RenditionReportResponse): void {
    const newest = this.newestFeedIndex.get(group);
    if (report.feedIndex !== null && newest !== undefined && report.feedIndex < newest) {
      if (this.merged.has(group)) {
        this.logger.log(
          `[AdminLadderRegistry] The answer to ${rung} of ladder ${group} is an older merge (catalog index ` +
            `${report.feedIndex}) than one already applied (${newest}); the master is written from the newer ladder`,
        );
        return;
      }
    }
    this.merged.set(group, report.renditions);
    this.heldStatus.set(group, report.streamStatus);
    if (report.feedIndex !== null) {
      this.newestFeedIndex.set(group, report.feedIndex);
    }
  }

  public recordRungDelivered(group: string, rung: string): void {
    this.republishIfLadderShapeChanged(group, this.liveness.recordDelivered(group, rung));
  }

  /** One segment of this rung was dropped. See {@link LadderRegistry.recordRungUploadFailed}. */
  public recordRungUploadFailed(group: string, rung: string): void {
    this.republishIfLadderShapeChanged(group, this.liveness.recordUploadFailed(group, rung));
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
      const advertised = advertisableRenditions(this.offeredRungs(group), this.liveness.of(group));
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
}
