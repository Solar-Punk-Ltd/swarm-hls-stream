import { Bee } from '@ethersphere/bee-js';

import {
  ANONYMOUS_CLAIMANT,
  HealthSignals,
  MediaType,
  PRESSURE_HIGH,
  PRESSURE_LOW,
  PRESSURE_MEDIUM,
  QueuePressure,
  REJECT_DRAINING,
  REJECT_QUEUE_FULL,
  REJECT_UNKNOWN_STREAM,
  REJECT_UNUSABLE_DURATION,
  SegmentResult,
  STOP_FAILURE_DRAIN_TIMEOUT,
  STOP_FAILURE_FINALIZE_FAILED,
  STREAM_LIFECYCLE_DRAINING,
  STREAM_LIFECYCLE_FAILED,
  STREAM_LIFECYCLE_FINALIZED,
  STREAM_LIFECYCLE_LIVE,
  STREAM_LIFECYCLE_UNKNOWN,
  StreamClaimant,
  StreamState,
  StreamStatusReport,
} from '../types.js';
import { getErrorMessage } from '../utils/common.js';
import { isUsableDuration, measureSegmentDuration } from '../utils/segmentDuration.js';

import { Clock, systemClock, Timer } from './Clock.js';
import { DrainTimeoutError } from './DrainTimeoutError.js';
import { ErrorHandler } from './ErrorHandler.js';
import { Logger } from './Logger.js';
import { RecentSegmentIndexes } from './RecentSegmentIndexes.js';
import { RecoveryStore } from './RecoveryStore.js';
import { MetricsSnapshot, ServiceMetrics } from './ServiceMetrics.js';
import { StreamCatalog } from './StreamCatalog.js';
import { StreamUploader } from './StreamUploader.js';

const DRAIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * How long a settled stop stays readable through `getStreamStatus`. Comfortably longer than
 * `DRAIN_TIMEOUT_MS`, so a caller polling a stop that ran to its own deadline still finds the verdict
 * waiting, and short enough that the map is bounded by the poll window rather than by uptime.
 */
const DEFAULT_STOP_OUTCOME_TTL_MS = 15 * 60 * 1000; // 15 minutes

export interface StreamOrchestratorConfig {
  streamKey: string;
  stamp: string;
  manifestBeeUrl: string;
  maxQueueSize: number;
  recoveryTimeout: number;
  /** How long a live stream may receive nothing before it is reaped as an orphan. See #86. */
  orphanReapMs: number;
  segmentStallMs: number;
  /** How many further segments an index stays remembered for, so a duplicate inside that is refused. */
  segmentDedupWindow: number;
  /** Defaults to the real clock. Injected so tests can step time rather than wait for it. */
  clock?: Clock;
  /**
   * How long a settled stop stays readable through `getStreamStatus`. Injectable only so the expiry
   * can be driven at all: at its default the record outlives any test worth writing.
   */
  stopOutcomeTtlMs?: number;
}

/**
 * A settled stop, kept until its window elapses.
 *
 * `recordedAt` and the report's own `settledAt` measure the same moment on different clocks, and both
 * are needed. `settledAt` is a wall-clock epoch because the caller reads it as a date. `recordedAt`
 * is the injected monotonic reading, because it is only ever used to compute an age, and an age taken
 * from a wall clock is wrong by however far that clock is adjusted.
 */
interface RetainedStopOutcome {
  report: StreamStatusReport;
  recordedAt: number;
}

/** How a claimant is named in a log line, so an announce that named nobody does not read as `null`. */
function describeClaimant(claimant: StreamClaimant): string {
  return claimant.address ?? 'an unnamed publisher';
}

/** The same for the session being protected, which may be one nothing ever recorded. See `reasonToRefuseTakeover`. */
function describeIncumbent(incumbent: StreamClaimant | undefined): string {
  if (incumbent === undefined) {
    return 'a session this process recovered, whose publisher it cannot name,';
  }
  return incumbent.address ?? 'a session that named no publisher';
}

/** Why an announce may not take a live stream id. Each spelling states only what its own branch established. */
type TakeoverRefusal = 'proven-incumbent' | 'still-publishing';

/**
 * The two refusals read very differently to whoever is holding the logs, which is why the wording is
 * chosen by the branch rather than written once beside the return. A single line crediting every
 * refusal to the stall window sent an operator looking for a publisher that had stopped feeding, when
 * the answer was that the id has an owner who proved it and going quiet will never free it.
 */
const TAKEOVER_REFUSALS: Record<TakeoverRefusal, (incumbent: string) => string> = {
  'proven-incumbent': (incumbent) =>
    `${incumbent} holds it with a proven publish key, so no amount of waiting will free it`,
  'still-publishing': (incumbent) =>
    `${incumbent} is publishing on it and something has fed it within the stall window`,
};

export class StreamOrchestrator {
  private activeStreams = new Map<string, StreamUploader>();
  /**
   * The drain running for a stream id, with the session it is draining. The uploader is what makes the
   * entry answerable: a reconnect registers a replacement under the same id while the outgoing drain is
   * still running, and a drain of the predecessor is not a stop of the successor. `undefined` for a
   * stop of a stream nothing had registered.
   */
  private drainPromises = new Map<string, { uploader: StreamUploader | undefined; promise: Promise<void> }>();
  private processedSegments = new Map<string, RecentSegmentIndexes>();
  private recoveryTimers = new Map<string, Timer>();
  /**
   * One watchdog per live stream, which finalizes it if its engine goes silent and stays silent.
   *
   * Kept separate from `recoveryTimers` rather than merged with them, even though both end in
   * `stopStream`, because they answer for different populations and must not both hold one stream:
   * a recovered stream is waiting for an engine that has never spoken to this process, and these
   * watch one that has. A stream moves from the first to the second exactly where its recovery timer
   * is cancelled.
   */
  private stallReapers = new Map<string, Timer>();
  /** Streams already reported as having unreadable segment durations, so the warning fires once each. */
  private unreadDurationReported = new Set<string>();
  /**
   * Per stream, the monotonic reading at which it last showed progress. Monotonic rather than wall
   * clock so a backwards NTP step cannot make an age negative and hide a stall. Registration counts
   * as progress, so a stream that announces and then sends nothing is measured from its announcement.
   */
  private streamActivityAt = new Map<string, number>();
  /**
   * Per stream, who announced the session currently holding it, so a later announce can be compared
   * against the incumbent.
   *
   * An entry means a live session. **Its absence does not mean the id is free**, which is what the
   * guard used to read it as: `recoverStream` registers a live stream and writes no claimant, and
   * both engines resume such a stream by delivering segments rather than by announcing, so nothing
   * ever fills it in. Absent means the owner is unknown. See `mayTakeOver`.
   */
  private streamClaimants = new Map<string, StreamClaimant>();
  /**
   * Per stream, the monotonic reading at which a segment last *arrived*, whatever verdict it got.
   *
   * Distinct from `streamActivityAt`, which records a segment accepted for upload and is what
   * `/health` reports on. This one answers "is a publisher still there", which stays true through a
   * full queue and through a window of duplicates, and the takeover guard needs that question rather
   * than the other. See `hasStalled`.
   */
  private streamIngestAt = new Map<string, number>();
  /** Per stream, the monotonic reading of the most recent segment the engine could not deliver. */
  private segmentLossAt = new Map<string, number>();
  /** What became of each recently stopped stream, so a caller answered 202 can find out. See OBS-3. */
  private stopOutcomes = new Map<string, RetainedStopOutcome>();
  /** Totals that outlive the streams they describe, which is what `/health` structurally cannot do. */
  private readonly metrics = new ServiceMetrics();
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  constructor(
    private bee: Bee,
    private streamCatalog: StreamCatalog,
    private recoveryStore: RecoveryStore,
    private config: StreamOrchestratorConfig,
  ) {
    this.clock = config.clock ?? systemClock;
    this.stopOutcomeTtlMs = config.stopOutcomeTtlMs ?? DEFAULT_STOP_OUTCOME_TTL_MS;
  }

  private readonly clock: Clock;
  private readonly stopOutcomeTtlMs: number;

  /**
   * @param claimant who is announcing, so a takeover of a live id can be judged. Defaults to naming
   * nobody, which fails open: an engine that does not pass one loses SEC-26's protection rather than
   * refusing its broadcasters.
   */
  public startStream(streamId: string, mediatype: MediaType, claimant: StreamClaimant = ANONYMOUS_CLAIMANT): boolean {
    // If recovering, cancel the recovery timeout and resume
    const recoveryTimer = this.recoveryTimers.get(streamId);
    if (recoveryTimer) {
      recoveryTimer.cancel();
      this.recoveryTimers.delete(streamId);
      // The re-announce is itself progress. Without this the stream rejoins the stall signal carrying
      // the age it accumulated while waiting, and a successful resume reports degraded until the first
      // segment lands.
      this.streamActivityAt.set(streamId, this.clock.now());
      // Not judged, and it cannot be: a recovered stream is one this process restored after its own
      // restart, so whoever announced the broadcast originally was never recorded here and there is
      // nothing to compare against. What this does is make the session that resumed it the incumbent,
      // so the announce after this one is judged against a real address instead of against the
      // unknown-owner rule in `mayTakeOver`. Reaching here at all is the uncommon case: an engine
      // that resumed the stream with segments never calls this method again.
      this.streamClaimants.set(streamId, claimant);
      // The recovery timer that was watching this stream has just been cancelled, so from here it is
      // an ordinary live stream and needs the ordinary watchdog. `handleSegment` arms it on the other
      // route out of recovery, which is the one both shipped engines take.
      this.armStallReaper(streamId);
      this.logger.info(`[StreamOrchestrator] Resumed recovering stream: ${streamId}`);
      return true;
    }

    const stale = this.activeStreams.get(streamId);
    if (stale) {
      const refusal = this.reasonToRefuseTakeover(streamId, claimant);
      if (refusal) {
        this.metrics.recordTakeoverRefused();
        this.logger.warn(
          `[StreamOrchestrator] Refused an announce for ${streamId} from ${describeClaimant(claimant)}: ` +
            TAKEOVER_REFUSALS[refusal](describeIncumbent(this.streamClaimants.get(streamId))),
        );
        return false;
      }

      // The engine re-announced a stream we still track — it restarted without sending on_unpublish
      // (e.g. the media engine was restarted). Finalize the stale session as a VOD, then start the
      // new one, so the broadcaster resumes instead of being rejected as "already active".
      //
      // The stale session leaves the live maps in this same synchronous turn, before anything can
      // deliver to it again. Finalizing it in the background and leaving it registered meanwhile
      // handed the new session's segments to the old uploader for the whole drain: indexes it had
      // already seen were absorbed by the duplicate filter and reported as accepted, and indexes
      // above its high-water were published into the outgoing session's manifest. Neither reached
      // `handleSegmentLoss`, and a draining stream is excluded from the stall signal, so the whole
      // window was silent. See CON-16.
      this.logger.info(`[StreamOrchestrator] Stream ${streamId} re-announced; finalizing stale session and restarting`);
      stale.retire();
      this.retireSession(streamId);
      this.spawnUploader(streamId, mediatype, claimant);
      void this.finalizeRetiredSession(streamId, stale);
      return true;
    }

    this.spawnUploader(streamId, mediatype, claimant);
    return true;
  }

  /**
   * Why `claimant` may not take a stream id that a live session already holds, or null to allow it.
   * See SEC-26.
   *
   * Refuses only what it can prove: two addresses, both known and different, over a stream that is
   * still being fed. Everything else is allowed, which is the same rule the OME closing path applies
   * in `isProvablyNotTheLiveSession`, and for the same reason. An announce that cannot be attributed
   * is ordinary, since not every engine reports a publisher address, and turning "we could not tell"
   * into a refusal would take a broadcaster off the air over a missing field.
   *
   * The stall window is the escape hatch, and it is what keeps a refusal from being permanent. A
   * broadcaster whose address changed between sessions is a stranger by the test above, and without
   * this they could never retake their own id.
   *
   * **No record at all is not the same as a record naming nobody**, and reading them alike left the
   * guard off for the whole life of every recovered stream. A stream this process restored after its
   * own restart has no claimant and cannot get one from an announce: both engines resume it by
   * delivering segments, OME because `resumeRecoveredStream` restarts the puller with no admission
   * behind it and SRS because its publish session never closed, so no `startStream` call ever
   * follows. Three lenses of the PR #65 gate reached this independently. So an absent record means
   * the owner is *unknown*, and an unknown owner is protected by the stall window rather than
   * yielded to anyone who asks. `POST /stream/start` is the other case and it is genuinely different:
   * it records `ANONYMOUS_CLAIMANT`, which is a positive statement that the caller named nobody.
   *
   * **A proven publish key settles who may _start_ on this id outright, and every rule above is the
   * fallback for when nobody proved anything.** Who may _stop_ one is screened too, but not here.
   * `stopStream` still takes a stream id and no claimant, because it does not need one: a configured
   * secret means every publish either engine accepted had proved a key, so each engine screens its
   * own close webhook against the value it is already holding. See SEC-29, and SEC-28 for the
   * derivation. That is what retires the two residuals
   * this used to end on. An attacker sharing the victim's address is no longer indistinguishable from
   * them, because the address is no longer what is being asked. And a squatter who claimed an id
   * first is evicted by the owner rather than by an operator, because the symmetry that protected
   * whoever arrived first only applies while neither can be identified.
   *
   * It also retires the stall window for the case that window cost the most. A recovered stream has
   * no claimant on record and cannot get one, so its real owner reconnecting was a stranger by every
   * test here and waited the window out. A key answers the question the record could not.
   *
   * What it still does not stop: an attacker holding the key. That is the credential's own security,
   * and the answer to a leak is to rotate the secret, since nothing here can revoke one stream on its
   * own. Nor does any of this apply when no secret is configured, where no announce is ever
   * authenticated, both branches below are dead and the behaviour is exactly SEC-26's.
   */
  private reasonToRefuseTakeover(streamId: string, claimant: StreamClaimant): TakeoverRefusal | null {
    if (claimant.isAuthenticated) {
      return null;
    }

    const incumbent = this.streamClaimants.get(streamId);
    if (incumbent === undefined) {
      return this.hasStalled(streamId) ? null : 'still-publishing';
    }
    // Not softened by the stall **window**, deliberately, where every other refusal here is. The
    // window exists so an owner nobody can identify is not locked out of their own id forever, and an
    // incumbent who proved the key has an owner who can be identified. Leaving the window in would
    // hand a proven stream to whoever waits `segmentStallMs` and asks, which is the whole attack.
    //
    // A **drain** is a different question and it does get through, because a drained session has
    // already stopped: `handleSegment` answers `draining` to anything it sends. `hasStalled`'s own
    // doc records that judging a takeover against a stopped session was a defect once already, and
    // returning here before consulting it reinstated exactly that contradiction one field along, for
    // up to `DRAIN_TIMEOUT_MS`. Proving a key is not a claim to hold the id after letting it go.
    if (incumbent.isAuthenticated) {
      return this.isDrainingId(streamId) ? null : 'proven-incumbent';
    }

    const provablyDifferent =
      incumbent.address !== null && claimant.address !== null && incumbent.address !== claimant.address;

    return !provablyDifferent || this.hasStalled(streamId) ? null : 'still-publishing';
  }

  /**
   * Whether nothing has been publishing into this stream for longer than the stall window.
   *
   * Deliberately **not** `streamActivityAt`, which is what `/health` reads and which this used to
   * read too. That one records a segment *accepted for upload*, and it sits below the duplicate and
   * queue-full returns in `handleSegment`, so it stops advancing while the publisher is still
   * connected and still sending: a backlogged queue, or a replaced puller re-serving the origin's
   * window, both freeze it for as long as they last. Under the old reading a stranger who simply
   * retried was admitted at exactly the moment the incumbent's upload path was degraded, which is
   * the worst moment for it. The two questions differ in the other direction too, since
   * `getMsSinceStreamActivity` excludes draining streams and this must not.
   *
   * A draining session has already stopped, so it is not holding the id whatever its timestamps say.
   * `handleSegment` answers `draining` one method away, and the refusal used to contradict it.
   */
  private hasStalled(streamId: string): boolean {
    if (this.isDrainingId(streamId)) {
      return true;
    }
    const ingestAt = this.streamIngestAt.get(streamId);
    // No reading means nothing has arrived since the session was registered, and `spawnUploader`
    // writes one for every session it starts, so this is unreachable for a stream that has one.
    return ingestAt === undefined || this.clock.now() - ingestAt > this.config.segmentStallMs;
  }

  /**
   * Whether the session currently registered under this id is draining.
   *
   * Matched by uploader identity through {@link isDraining}, not by id, which is the distinction that
   * keeps a live replacement from being read as draining while its predecessor's drain is still in
   * flight under the same id. Both callers need exactly that reading, so it is one helper rather than
   * the same two lines twice.
   */
  private isDrainingId(streamId: string): boolean {
    const uploader = this.activeStreams.get(streamId);
    return uploader !== undefined && this.isDraining(streamId, uploader);
  }

  /**
   * Detach a stream from the live maps so nothing can reach it by id any more, without waiting for
   * it to finish. The caller keeps the uploader and is responsible for finalizing it.
   */
  private retireSession(streamId: string): void {
    this.activeStreams.delete(streamId);
    this.processedSegments.delete(streamId);
    this.streamActivityAt.delete(streamId);
    this.streamIngestAt.delete(streamId);
    this.streamClaimants.delete(streamId);
    // OBS-19. Written on a loss and deleted nowhere, so it survived its own session. Invisible while
    // the id was gone, because `getMsSinceSegmentLoss` only reads ids in `activeStreams`, and back
    // the moment a broadcaster reconnected under the same id: `/health` then answered `degraded` with
    // `segment_loss` for a broadcast that had lost nothing.
    this.segmentLossAt.delete(streamId);
    // Cleared with the session rather than kept for the id, so that a later broadcast on the same id
    // says it again. Whether an engine's segments are readable is a fact about the session producing
    // them, and the id can be handed to a different engine entirely.
    this.unreadDurationReported.delete(streamId);
    // Nothing can reach this session by id any more, so a pending reap would either find no ingest
    // reading and do nothing, or find its replacement's and finalize a live broadcast.
    this.stallReapers.get(streamId)?.cancel();
    this.stallReapers.delete(streamId);
  }

  /**
   * Finalize a session that a newer one has already replaced under the same id.
   *
   * Takes the uploader by reference rather than looking it up, because by now the id belongs to the
   * replacement: a lookup would VOD-finalize the live session instead. For the same reason it does
   * not register in `drainPromises`, which excludes a stream from the stall signal, and the stream
   * under that id is now live and has to stay answerable to it.
   */
  private async finalizeRetiredSession(streamId: string, uploader: StreamUploader): Promise<void> {
    try {
      const outcome = await this.drainUploader(streamId, uploader);
      if (outcome.state === STREAM_LIFECYCLE_FAILED) {
        // Not recorded as this id's stop outcome, because the id belongs to the replacement and its
        // own stop will answer for itself. This is the only place the loss can be said at all, and it
        // has to be said: the log line below used to run unconditionally, so once `drainUploader`
        // stopped throwing it would have announced a finalize that never published.
        this.logger.error(
          `[StreamOrchestrator] The session replaced under ${streamId} was not finalized, so its broadcast has no VOD: ${outcome.reason}`,
        );
        // Counted here rather than through `recordStopOutcome`, whose map is keyed by stream id and
        // belongs to the replacement. A total is the only place this loss can survive, since the id
        // it happened under is live again.
        this.metrics.recordStreamFailed();
        return;
      }
      this.logger.info(`[StreamOrchestrator] Finalized the replaced session for ${streamId}`);
    } catch (error) {
      // A backstop rather than the drain's error path, which answers instead of throwing. Nothing
      // awaits this call, so an unexpected rejection here would be an unhandled one.
      this.errorHandler.handleError(error, `StreamOrchestrator.finalizeRetiredSession - ${streamId}`);
    }
  }

  /**
   * Registers the stream before returning, which is the whole of CON-1's fix.
   *
   * This used to defer its body into a concurrency-1 `PQueue`, and the race that opened is not the one
   * CON-1 describes. p-queue 8 runs a synchronous job inside `add()` when a slot is free, so a first
   * announce did register before returning and a second one did see it. What it could not do is run a
   * *second* job synchronously: the slot is only released a microtask later. So the window opened on
   * the re-announce path, which retires the live session and then queues its replacement. Between
   * those two, `activeStreams` held nothing for a stream mid-broadcast, and the measured consequences
   * were a segment from a reconnecting broadcaster refused as `unknown_stream`, and a third announce
   * in that same window finding the id free and starting a session over the top of the pending one,
   * which was then never retired and never finalized.
   *
   * The queue bought nothing to lose. It had one producer, this method, and its job body was entirely
   * synchronous, as is `StreamUploader`'s constructor: field assignments, a signer, a manifest manager
   * and a uuid.
   */
  private spawnUploader(streamId: string, mediatype: MediaType, claimant: StreamClaimant): void {
    const uploader = new StreamUploader(
      this.bee,
      this.config.manifestBeeUrl,
      this.streamCatalog,
      this.recoveryStore,
      this.config.streamKey,
      this.config.stamp,
      streamId,
      mediatype,
      { metrics: this.metrics },
    );

    this.activeStreams.set(streamId, uploader);
    this.processedSegments.set(streamId, this.newDuplicateFilter());
    this.streamActivityAt.set(streamId, this.clock.now());
    this.streamIngestAt.set(streamId, this.clock.now());
    this.streamClaimants.set(streamId, claimant);
    this.armStallReaper(streamId);
    this.logger.info(`[StreamOrchestrator] Started stream: ${streamId}`);
  }

  /**
   * Whether this uploader's own drain is running, so nothing it is handed can still be published.
   *
   * `notifyStop` waits on `segmentQueue.onIdle()` and then commits the VOD manifest, and it stays
   * registered in `activeStreams` for the whole of that. Anything enqueued after the barrier resolves
   * is uploaded and paid for into a manifest that is already built, so it reaches no player. The
   * publish it triggers is worse than the loss: it commits a live manifest at a SOC index above the
   * VOD's, which leaves the feed's newest entry a live playlist for a finished broadcast, and the
   * state it persists on the way through restores the recovery entry `notifyStop` just deleted, so
   * the next boot recovers a stream that is over and finalizes it a second time.
   *
   * Matched on the uploader, not the id, for the reason `stopStream` matches on it: a reconnect
   * registers a replacement under the id the outgoing drain is still keyed by, and that replacement is
   * live. Refusing by id alone would silence a broadcaster who is already back, for as long as the
   * finalize takes, which is up to `DRAIN_TIMEOUT_MS`.
   */
  private isDraining(streamId: string, uploader: StreamUploader): boolean {
    return this.drainPromises.get(streamId)?.uploader === uploader;
  }

  public handleSegment(
    streamId: string,
    segmentIndex: number,
    duration: number,
    data: Buffer,
    /** The origin declared a break immediately before this segment. Applied only if the segment is taken. */
    discontinuity = false,
  ): SegmentResult {
    const uploader = this.activeStreams.get(streamId);
    if (!uploader) {
      return { accepted: false, reason: REJECT_UNKNOWN_STREAM };
    }

    // Recorded before every rejection below, because a segment arriving is evidence about the
    // publisher and the rejections below are verdicts about the payload. See `hasStalled`.
    this.streamIngestAt.set(streamId, this.clock.now());

    if (this.isDraining(streamId, uploader)) {
      return { accepted: false, reason: REJECT_DRAINING };
    }

    // Checked here because this is where the HTTP route, the SRS webhook and the OME puller converge,
    // and only the puller screened it. A non-finite duration reaches `#EXTINF` verbatim, so it buys
    // an unplayable playlist with postage, and it destroys the queue's backlog total: the total adds
    // on enqueue and subtracts when the job ends, `Infinity - Infinity` is `NaN`, and `Math.max`
    // then spreads that `NaN` across every stream in the process, permanently, with `/health` and
    // `/metrics` both reporting nothing wrong.
    if (!isUsableDuration(duration)) {
      return { accepted: false, reason: REJECT_UNUSABLE_DURATION };
    }

    // Segments arriving mean the engine is feeding this stream again. If it was just recovered after
    // a crash, cancel the pending finalize timer: an engine does not re-announce a session that
    // stayed open across the crash, so startStream never fires to clear the timer, and the stream
    // would otherwise be finalized as VOD mid-broadcast when it expires.
    const recoveryTimer = this.recoveryTimers.get(streamId);
    if (recoveryTimer) {
      recoveryTimer.cancel();
      this.recoveryTimers.delete(streamId);
      // Cancelling the timer makes this stream eligible for the stall signal again, so it needs a
      // fresh reading here and not only on the accept path below. A post-recovery puller re-pulls
      // from the start, so its first segments are duplicates, and the stream would otherwise rejoin
      // the signal carrying the reading it was given when recovery registered it.
      this.streamActivityAt.set(streamId, this.clock.now());
      // The stream is ordinary and live from here, and this is the path production actually takes to
      // get there: neither engine re-announces a session that stayed open across the crash, so
      // `startStream` never fires. Without arming the watchdog here, surviving one crash would remove
      // the #86 protection for the rest of the broadcast.
      this.armStallReaper(streamId);
      this.logger.info(`[StreamOrchestrator] Segments resumed for ${streamId}; cancelled recovery finalize timer`);
    }

    // Deduplication
    const processed = this.processedSegments.get(streamId);
    if (processed?.has(segmentIndex)) {
      // Deliberately not counted as activity. A replayed index does no upload work and advances no
      // manifest, so a sender stuck on one index would otherwise look alive to the stall signal.
      return { accepted: true }; // silently accept duplicate
    }

    // Backpressure check
    if (uploader.segmentQueue.size >= this.config.maxQueueSize) {
      return { accepted: false, reason: REJECT_QUEUE_FULL };
    }

    processed?.add(segmentIndex);
    this.streamActivityAt.set(streamId, this.clock.now());
    // Carried on the segment rather than issued ahead of it, which is what the puller used to do. Every
    // path above returns without taking the segment, and a marker issued before them outlived its
    // segment and attached to the next one that was taken. A recovered stream reaches that constantly:
    // its duplicate filter is rebuilt from the restored manifest while its puller restarts at the top
    // of the origin's window, so the whole window comes back as duplicates. The marker also queued with
    // no regard for `maxQueueSize`, one job per poll for as long as the origin kept serving the segment
    // a full queue was refusing.
    if (discontinuity) {
      uploader.markDiscontinuity();
    }
    uploader.handleSegment(segmentIndex, this.mediaDuration(streamId, segmentIndex, duration, data), data);
    return { accepted: true };
  }

  /**
   * How much media this segment holds, preferring the segment over whatever the engine said about it.
   *
   * Substituted here rather than in either engine, because this is where the HTTP route, the SRS
   * webhook and the OME puller converge, and the engine that was measured lying about it is not
   * special: what a manifest promises a viewer should come from the media in every case.
   *
   * @see measureSegmentDuration for the measurement, and what SRS declares instead
   */
  private mediaDuration(streamId: string, segmentIndex: number, declared: number, data: Buffer): number {
    const reading = measureSegmentDuration(data, declared);
    if (reading.fellBackBecause === null) {
      return reading.seconds;
    }

    this.metrics.recordSegmentDurationUnread();
    // Once per stream, not once per segment. At the shipping profile this path runs four times a
    // second for the length of a broadcast, and an engine whose segments are never readable is one
    // fact about that engine rather than thousands about its segments.
    if (!this.unreadDurationReported.has(streamId)) {
      this.unreadDurationReported.add(streamId);
      this.logger.warn(
        `[StreamOrchestrator] Cannot read how much media segment ${segmentIndex} of ${streamId} holds, so ` +
          `${declared}s is being published on the engine's word: ${reading.fellBackBecause}. ` +
          'Reported once per stream; see the segment_durations_unread_total counter for the rate',
      );
    }
    return reading.seconds;
  }

  /**
   * Segments the engine could not fetch from its origin, `firstIndex` through `firstIndex + count - 1`,
   * so they never reached `handleSegment` and no upload was ever attempted.
   *
   * Deliberately not recorded as stream activity. A stream that only loses segments is not making
   * progress, and refreshing the clock here would hide a stall behind the very losses causing it.
   */
  public handleSegmentLoss(streamId: string, firstIndex: number, count: number): boolean {
    const uploader = this.activeStreams.get(streamId);
    if (!uploader) {
      // Answered rather than swallowed, so the caller can hold its position instead of stepping over
      // indexes nobody recorded. A stream can leave `activeStreams` between a puller's fetch and its
      // report, through a drain, a recovery timeout or a re-announce.
      return false;
    }

    // Same window and same answer as `handleSegment`. A discontinuity queued behind a resolved
    // `segmentQueue.onIdle()` marks a manifest that is already committed, and the state it persists
    // on the way through restores a recovery entry the drain has deleted.
    if (this.isDraining(streamId, uploader)) {
      return false;
    }

    this.segmentLossAt.set(streamId, this.clock.now());
    this.metrics.recordSegmentsLost(count);
    uploader.handleSegmentLoss(firstIndex, count);
    return true;
  }

  /**
   * Push the pending recovery finalize back, because the engine is still working on this stream.
   * Answers whether there was one to push, so a caller cannot mistake a no-op for a deferral.
   *
   * The timer's only other input is a segment arriving, and after a crash the engine that would send
   * one is being waited on too. A pull-based engine restarts its puller immediately and then retries a
   * silent origin for its own patience window, 60s by default, which is the same 60s this timer runs
   * on. An OME restart slower than that finalized a broadcast whose publisher never went away, with
   * the puller mid-retry when it happened. See CON-10.
   *
   * Each call buys one more `recoveryTimeout`, and nothing renews it but the engine, so the total
   * deferral is bounded by how long the engine keeps trying. When it gives up it stops the stream
   * itself, and if it dies instead the timer arrives on its own one timeout later.
   *
   * Deliberately not recorded as stream activity, which is a choice rather than a guarantee: a stream
   * holding a recovery timer is excluded from `getMsSinceStreamActivity` anyway, and both paths that
   * end recovery set a fresh reading, so recording it here would be unobservable. It stays this way
   * because a puller polling an origin that answers nothing is not progress, but no test guards it,
   * because none can.
   */
  public keepAlive(streamId: string): boolean {
    const pending = this.recoveryTimers.get(streamId);
    if (!pending) {
      return false;
    }

    pending.cancel();
    this.recoveryTimers.set(streamId, this.scheduleRecoveryFinalize(streamId));
    return true;
  }

  public async stopStream(streamId: string): Promise<void> {
    // Cancel recovery timer if stopping a recovering stream
    const recoveryTimer = this.recoveryTimers.get(streamId);
    if (recoveryTimer) {
      recoveryTimer.cancel();
      this.recoveryTimers.delete(streamId);
    }

    // The broadcast is ending on this path, so the watchdog for it ending on no path has nothing left
    // to do. A reap that fired afterwards would commit a second VOD manifest over the one this stop
    // published, which is the same waste CON-22 describes for a doubled drain.
    this.stallReapers.get(streamId)?.cancel();
    this.stallReapers.delete(streamId);

    // A stop already running is the answer to this one, but only when it is draining the same session.
    // Every caller in the engines fires and forgets, and two of them sit next to each other: a puller
    // that halts calls this, and the closing that follows calls it again. A second drain of one
    // uploader finalizes it twice, committing a second VOD manifest and rewriting the feed entry the
    // first one published, which is postage spent for nothing. See CON-22.
    //
    // Matched on the uploader rather than the id, because those stop being the same thing the moment a
    // reconnect registers a replacement under that id, and stay different for as long as the outgoing
    // drain runs, up to DRAIN_TIMEOUT_MS. Answering the replacement's own stop with its predecessor's
    // drain never finalizes the replacement at all: its catalog entry stays live for a broadcast that
    // ended, it holds the id in `activeStreams` with no puller, and the stall signal reports it for the
    // life of the process. That is a lost VOD where the duplicate above is only a wasted one.
    const uploader = this.activeStreams.get(streamId);
    const inFlight = this.drainPromises.get(streamId);
    if (inFlight && inFlight.uploader === uploader) {
      return inFlight.promise;
    }

    const drainPromise = this.performDrain(streamId);
    this.drainPromises.set(streamId, { uploader, promise: drainPromise });

    try {
      await drainPromise;
    } finally {
      // Only if this drain still owns the entry. A replacement's drain overwrites it while this one is
      // still running, and clearing that would hide a live drain from the stall signal.
      if (this.drainPromises.get(streamId)?.promise === drainPromise) {
        this.drainPromises.delete(streamId);
      }
    }
  }

  public async recoverStreams(): Promise<string[]> {
    const activeIds = this.recoveryStore.listActive();

    if (activeIds.length === 0) {
      this.logger.info('[StreamOrchestrator] No streams to recover');
      return [];
    }

    this.logger.info(`[StreamOrchestrator] Recovering ${activeIds.length} stream(s)...`);

    const recovered: string[] = [];

    for (const fileId of activeIds) {
      const state = this.recoveryStore.load(fileId);
      if (!state) {
        this.recoveryStore.remove(fileId);
        continue;
      }

      if (!state.streamId) {
        // Parseable JSON but not a stream state — the state dir can hold other files
        // (e.g. the catalog feed index). Skip it; never delete what recovery does not own.
        this.logger.warn(`[StreamOrchestrator] Skipping non-stream state file: ${fileId}`);
        continue;
      }

      // One entry that cannot be rebuilt costs one broadcast, not every broadcast behind it in the
      // list. Anything thrown here used to escape the loop, so the remaining entries were never
      // read at all while staying on disk still reporting as active.
      try {
        recovered.push(this.recoverStream(state));
      } catch (error) {
        this.errorHandler.handleError(error, `StreamOrchestrator.recoverStreams - ${state.streamId}`);
      }
    }

    return recovered;
  }

  /** Rebuild one stream from its persisted state, register it as live, and return its id. */
  private recoverStream(state: StreamState): string {
    // RecoveryStore names files by a slash-sanitized id (live/stream → live_stream); the real
    // streamId lives inside the state. Key the live maps by the real id so incoming segments
    // (handleSegment looks up the real id) actually match this recovered stream — otherwise the
    // recovery timer can never be cancelled and the stream is always VOD-ed at the timeout.
    const streamId = state.streamId;

    const uploader = new StreamUploader(
      this.bee,
      this.config.manifestBeeUrl,
      this.streamCatalog,
      this.recoveryStore,
      this.config.streamKey,
      this.config.stamp,
      state.streamId,
      state.mediatype,
      {
        restoreState: {
          streamRawTopic: state.streamRawTopic,
          socIndex: state.socIndex,
          segments: state.segments,
          hlsHeaders: state.hlsHeaders,
          isFirstSegmentReady: state.isFirstSegmentReady,
          isFirstManifestReady: state.isFirstManifestReady,
          pendingDiscontinuity: state.pendingDiscontinuity,
        },
        metrics: this.metrics,
      },
    );

    this.activeStreams.set(streamId, uploader);
    this.streamActivityAt.set(streamId, this.clock.now());
    this.streamIngestAt.set(streamId, this.clock.now());

    // Rebuilt from the restored manifest, and bounded the same way a live stream's is. The oldest
    // indexes of a long broadcast are dropped, which costs nothing: what a resumed puller can
    // re-deliver is whatever the origin still has in its playlist window, never the whole stream.
    const processed = this.newDuplicateFilter();
    for (const segment of state.segments) {
      processed.add(segment.index);
    }
    this.processedSegments.set(streamId, processed);

    this.recoveryTimers.set(streamId, this.scheduleRecoveryFinalize(streamId));

    this.logger.info(
      `[StreamOrchestrator] Recovered stream ${streamId} with ${state.segments.length} segments, ` +
        `waiting ${this.config.recoveryTimeout}ms for engine reconnect`,
    );

    return streamId;
  }

  /**
   * Watch a live stream for an engine that stops feeding it and never comes back. Task #86.
   *
   * An engine that dies does not send `on_unpublish`, so nothing tells this process the broadcast is
   * over. Before this, such a stream was held in `activeStreams` for the life of the process:
   * `/health` answered `degraded` with `segment_stall` forever, its catalog entry stayed live for a
   * broadcast that had ended, and no VOD was ever published. Detection was already right and there
   * was no way out of it but a restart by hand.
   *
   * **The window is `recoveryTimeout`, deliberately, and not `segmentStallMs`.** That one is a health
   * *reporting* threshold at half this value, and ending a broadcast on it would kill streams that
   * recover: a twenty second write outage is survivable and measured, and a pull engine retries a
   * silent origin for its own patience window, 60s by default, which is what `recoveryTimeout` was
   * already chosen against in CON-10. Reusing it keeps one number governing "how long do we wait for
   * an engine that might come back" instead of two that can drift apart.
   *
   * Rearms itself rather than being reset per segment, so a stream feeding at four segments a second
   * costs one timer rather than four cancellations a second, and a healthy stream is only looked at
   * once per window.
   */
  private armStallReaper(streamId: string): void {
    this.stallReapers.get(streamId)?.cancel();
    this.stallReapers.set(streamId, this.scheduleStallReap(streamId, this.config.orphanReapMs));
  }

  private scheduleStallReap(streamId: string, delayMs: number): Timer {
    return this.clock.setTimer(() => {
      this.stallReapers.delete(streamId);

      const ingestAt = this.streamIngestAt.get(streamId);
      // The stream left the live maps while this was pending, so there is nothing to reap. Retiring
      // and stopping both cancel the timer, so reaching here means the entry went without either.
      if (ingestAt === undefined) {
        return;
      }

      // A stream holding a recovery timer is that timer's business, not this one's. The two never
      // arm together today, and this keeps a future path that armed both from finalizing twice.
      if (this.recoveryTimers.has(streamId)) {
        return;
      }

      const idleMs = this.clock.now() - ingestAt;
      if (idleMs < this.config.orphanReapMs) {
        // Fed since this was armed, so the window restarts from the last segment rather than from
        // now. Sleeping exactly the remainder is what keeps the check off the per-segment path.
        this.stallReapers.set(streamId, this.scheduleStallReap(streamId, this.config.orphanReapMs - idleMs));
        return;
      }

      this.logger.warn(
        `[StreamOrchestrator] No segments for ${streamId} in ${Math.round(idleMs)}ms and no stop was ever sent; ` +
          'finalizing it as a VOD. Its engine most likely died without sending on_unpublish',
      );
      this.metrics.recordStreamReaped();
      void this.stopStream(streamId).catch((error) =>
        this.errorHandler.handleError(error, `StreamOrchestrator.stallReap - ${streamId}`),
      );
    }, delayMs);
  }

  /** If the engine never reconnects, finalize the recovered stream as a VOD rather than hold it live. */
  private scheduleRecoveryFinalize(streamId: string): Timer {
    return this.clock.setTimer(() => {
      this.recoveryTimers.delete(streamId);
      this.logger.info(`[StreamOrchestrator] Recovery timeout for ${streamId}, finalizing as VOD`);
      void this.stopStream(streamId).catch((error) =>
        this.errorHandler.handleError(error, `StreamOrchestrator.recoveryTimeout - ${streamId}`),
      );
    }, this.config.recoveryTimeout);
  }

  private newDuplicateFilter(): RecentSegmentIndexes {
    return new RecentSegmentIndexes(this.config.segmentDedupWindow);
  }

  public getQueuePressure(streamId: string): QueuePressure {
    const uploader = this.activeStreams.get(streamId);
    if (!uploader) {
      return PRESSURE_LOW;
    }

    const ratio = uploader.segmentQueue.size / this.config.maxQueueSize;
    if (ratio > 0.8) {
      return PRESSURE_HIGH;
    }
    if (ratio > 0.5) {
      return PRESSURE_MEDIUM;
    }
    return PRESSURE_LOW;
  }

  public getOverallQueuePressure(): QueuePressure {
    let worst: QueuePressure = PRESSURE_LOW;
    for (const streamId of this.activeStreams.keys()) {
      const pressure = this.getQueuePressure(streamId);
      if (pressure === PRESSURE_HIGH) {
        return PRESSURE_HIGH;
      }
      if (pressure === PRESSURE_MEDIUM) {
        worst = PRESSURE_MEDIUM;
      }
    }
    return worst;
  }

  public getActiveStreamCount(): number {
    return this.activeStreams.size;
  }

  public getStaleManifestStreamCount(): number {
    let count = 0;
    for (const uploader of this.activeStreams.values()) {
      if (uploader.hasStaleLiveManifest()) {
        count += 1;
      }
    }
    return count;
  }

  public getMaxConsecutiveManifestFailures(): number {
    let worst = 0;
    for (const uploader of this.activeStreams.values()) {
      worst = Math.max(worst, uploader.getConsecutiveManifestFailures());
    }
    return worst;
  }

  public getMaxConsecutiveSegmentFailures(): number {
    let worst = 0;
    for (const uploader of this.activeStreams.values()) {
      worst = Math.max(worst, uploader.getConsecutiveSegmentFailures());
    }
    return worst;
  }

  /**
   * How long this service has been unable to write the state it needs to survive a restart, from the
   * oldest unresolved failure across both stores. `null` while every write is landing.
   *
   * One signal for two stores because it is one fact: they write into the same `STATE_DIR`, so a full
   * disk, a read-only mount or a permissions change takes out both, and the operator's next move is
   * the same either way. What follows a restart differs, a stream resuming from stale segments versus
   * a catalog feed forked at an occupied index, and neither is visible until the restart happens.
   */
  public getMsSinceStatePersistFailed(): number | null {
    let oldest = this.streamCatalog.getMsSinceIndexSaveFailed();
    for (const uploader of this.activeStreams.values()) {
      const age = uploader.getMsSinceStatePersistFailed();
      if (age !== null && (oldest === null || age > oldest)) {
        oldest = age;
      }
    }
    return oldest;
  }

  /**
   * How long the longest-waiting live stream has been absent from the catalog, so the worst stream
   * sets the number. `null` while every one of them is listed.
   *
   * On the wall clock rather than `this.clock`, because the instant belongs to the uploader and the
   * uploader has no clock seam. Nothing compares it against a faked time.
   */
  public getMsSinceCatalogAnnounceFailed(): number | null {
    let oldest: number | null = null;
    for (const uploader of this.activeStreams.values()) {
      const age = uploader.getMsSinceCatalogAnnounceFailed();
      if (age !== null && (oldest === null || age > oldest)) {
        oldest = age;
      }
    }
    return oldest;
  }

  /**
   * Age of the least recently active stream that is expected to be producing segments right now, so
   * one busy stream cannot mask a dead sibling. `null` when no stream qualifies.
   *
   * A draining stream is excluded because a drain legitimately accepts no segments for up to
   * `DRAIN_TIMEOUT_MS`, and a stream awaiting a post-crash reconnect is excluded because its
   * recovery timer is already the control for never coming back.
   */
  public getMsSinceStreamActivity(): number | null {
    const now = this.clock.now();
    let oldest: number | null = null;

    for (const [streamId, uploader] of this.activeStreams) {
      // Matched on the uploader for the reason `isDraining` is: a reconnect registers a replacement
      // under the id its predecessor's drain is still keyed by, and that replacement is live and has
      // to stay answerable. Excluding by id alone hid a broadcasting stream from this signal for as
      // long as the outgoing finalize took, which is up to `DRAIN_TIMEOUT_MS`.
      if (this.isDraining(streamId, uploader) || this.recoveryTimers.has(streamId)) {
        continue;
      }
      const activityAt = this.streamActivityAt.get(streamId);
      if (activityAt === undefined) {
        continue;
      }
      const age = now - activityAt;
      if (oldest === null || age > oldest) {
        oldest = age;
      }
    }

    return oldest;
  }

  public getSegmentStallMs(): number {
    return this.config.segmentStallMs;
  }

  /**
   * What became of a stream, for the caller `POST /stream/stop` answered `202` to.
   *
   * A stop is answered before the drain runs, because a drain has `DRAIN_TIMEOUT_MS` to finish and no
   * media server's webhook will wait five minutes for one. That is why the outcome has to be readable
   * afterwards: until it was, a finalize that never published and one that did were the same event at
   * every layer, since `drainUploader` caught its own failure and returned normally.
   */
  public getStreamStatus(streamId: string): StreamStatusReport {
    const live = this.activeStreams.get(streamId);
    // Matched on the uploader, not the id, for the reason `isDraining` and `getMsSinceStreamActivity`
    // both are: a reconnect registers a replacement under the id its predecessor's drain is still
    // keyed by, and a drain of the predecessor is not a stop of the successor. Matching on the id
    // alone answered `draining` for up to DRAIN_TIMEOUT_MS about a stream that was broadcasting, while
    // `/stream/segment` accepted its segments instead of returning the 409 a draining stream gets.
    if (live && this.isDraining(streamId, live)) {
      return { streamId, state: STREAM_LIFECYCLE_DRAINING };
    }
    if (live) {
      return { streamId, state: STREAM_LIFECYCLE_LIVE };
    }
    // No live session under this id, so a drain still running here is the only session there is.
    if (this.drainPromises.has(streamId)) {
      return { streamId, state: STREAM_LIFECYCLE_DRAINING };
    }

    this.sweepStopOutcomes();
    return this.stopOutcomes.get(streamId)?.report ?? { streamId, state: STREAM_LIFECYCLE_UNKNOWN };
  }

  private recordStopOutcome(outcome: StreamStatusReport): void {
    this.sweepStopOutcomes();
    this.stopOutcomes.set(outcome.streamId, { report: outcome, recordedAt: this.clock.now() });
    if (outcome.state === STREAM_LIFECYCLE_FAILED) {
      this.metrics.recordStreamFailed();
    }
    // A finalize is counted by the uploader that published it, where `notifyStop`'s memoization makes
    // it exactly once. Counting it here as well would count a replaced session twice, and would count
    // a stop that published nothing as a VOD.
  }

  /**
   * Everything `/metrics` reports. The counters outlive their streams, and the three gauges below are
   * readings taken here, at scrape time, because they can go down and a counter never does.
   */
  public getMetricsSnapshot(): MetricsSnapshot {
    let queueDepth = 0;
    let queueBacklogSeconds = 0;
    for (const uploader of this.activeStreams.values()) {
      queueDepth += uploader.segmentQueue.size;
      queueBacklogSeconds = Math.max(queueBacklogSeconds, uploader.getQueuedSeconds());
    }

    return {
      ...this.metrics.getCounters(),
      activeStreams: this.activeStreams.size,
      queueDepth,
      queueBacklogSeconds,
    };
  }

  /**
   * Swept on every write and on every read, because the ordinary end of a broadcast is a stream that
   * stops and is never asked about again. Expiring lazily on read alone would therefore expire nothing
   * on exactly the path that creates entries, leaving one per stream id ever stopped.
   */
  private sweepStopOutcomes(): void {
    const now = this.clock.now();
    for (const [streamId, retained] of this.stopOutcomes) {
      if (now - retained.recordedAt > this.stopOutcomeTtlMs) {
        this.stopOutcomes.delete(streamId);
      }
    }
  }

  /**
   * Age of the most recent reported loss across registered streams, so the freshest one sets the
   * number. `null` when none has been reported.
   */
  public getMsSinceSegmentLoss(): number | null {
    const now = this.clock.now();
    let freshest: number | null = null;

    for (const streamId of this.activeStreams.keys()) {
      const lossAt = this.segmentLossAt.get(streamId);
      if (lossAt === undefined) {
        continue;
      }
      const age = now - lossAt;
      if (freshest === null || age < freshest) {
        freshest = age;
      }
    }

    return freshest;
  }

  /**
   * A segment the OME handover floor discarded on purpose, counted once per playlist index by the
   * puller. Not routed through `handleSegmentLoss`: nothing was lost, and a stream that has already
   * left `activeStreams` still skipped what it skipped. See OBS-16.
   */
  public recordSegmentsSkipped(count: number): void {
    this.metrics.recordSegmentsSkipped(count);
  }

  /** A request a credential gate refused. On the wall clock, since the gates have no clock seam. */
  public recordAuthRejection(): void {
    this.metrics.recordAuthRejection(Date.now());
  }

  public getHealthSignals(): HealthSignals {
    const counters = this.metrics.getCounters();
    const lastAuthRejectionAt = this.metrics.getLastAuthRejectionAt();

    return {
      activeStreams: this.activeStreams.size,
      staleManifestStreams: this.getStaleManifestStreamCount(),
      maxConsecutiveManifestFailures: this.getMaxConsecutiveManifestFailures(),
      maxConsecutiveSegmentFailures: this.getMaxConsecutiveSegmentFailures(),
      queuePressure: this.getOverallQueuePressure(),
      msSinceStreamActivity: this.getMsSinceStreamActivity(),
      msSinceSegmentLoss: this.getMsSinceSegmentLoss(),
      msSinceCatalogAnnounceFailed: this.getMsSinceCatalogAnnounceFailed(),
      msSinceStatePersistFailed: this.getMsSinceStatePersistFailed(),
      queueBacklogSeconds: this.getMetricsSnapshot().queueBacklogSeconds,
      msSinceAuthRejection: lastAuthRejectionAt === null ? null : Date.now() - lastAuthRejectionAt,
      hasIngestedMedia: counters.segmentsUploadedTotal > 0,
      segmentsSkipped: counters.segmentsSkippedTotal,
      segmentsNeverNamed: counters.segmentsNeverNamedTotal,
    };
  }

  public async cleanup(): Promise<void> {
    // Clear all recovery timers
    for (const timer of this.recoveryTimers.values()) {
      timer.cancel();
    }
    this.recoveryTimers.clear();

    // Stop all active streams
    const streamIds = Array.from(this.activeStreams.keys());
    await Promise.all(
      streamIds.map(async (streamId) => {
        try {
          await this.stopStream(streamId);
        } catch (error) {
          this.errorHandler.handleError(error, `StreamOrchestrator.cleanup - ${streamId}`);
        }
      }),
    );

    this.logger.info('[StreamOrchestrator] Cleanup complete');
  }

  private async performDrain(streamId: string): Promise<void> {
    const uploader = this.activeStreams.get(streamId);
    if (!uploader) {
      this.logger.warn(`[StreamOrchestrator] No uploader found for ${streamId}`);
      this.recoveryStore.remove(streamId);
      return;
    }

    const outcome = await this.drainUploader(streamId, uploader);

    // A re-announce during this drain registers a replacement under the same id, so detaching by id
    // now would unregister a live session that this drain never touched. Every segment after that
    // comes back as an unknown stream, permanently, and the stall signal cannot see it either
    // because the id is no longer in `activeStreams` at all.
    //
    // The outcome is recorded below this check rather than above it, and that is the whole point.
    // Above it, a predecessor settling late wrote its own verdict onto an id that belongs to another
    // broadcast: a caller told `failed` for a session that published nothing was then told
    // `finalized`, describing a VOD under the predecessor's feed topic. That is the exact confusion
    // the 202-then-poll protocol exists to remove, reintroduced at the one endpoint whose job is
    // answering whether the recording exists. It also counted one finalize twice, because
    // `finalizeRetiredSession` awaits the same memoized `notifyStop` and counts it too.
    if (this.activeStreams.get(streamId) !== uploader) {
      this.logger.info(`[StreamOrchestrator] Drained a replaced session for ${streamId}, its successor stays live`);
      return;
    }

    this.recordStopOutcome(outcome);
    this.retireSession(streamId);

    this.logger.info(`[StreamOrchestrator] Stopped stream: ${streamId}`);
  }

  /**
   * Let an uploader finish what it has in hand and publish its VOD, under a deadline, and answer
   * whether it managed to.
   *
   * Answers rather than throws, deliberately. A stop that fails still has to leave the live maps, and
   * rethrowing would skip `retireSession`, leaving the id in `activeStreams` with nothing feeding it
   * and the stall signal reporting a stream that had already ended for the life of the process. The
   * drain really does complete here. It just completes unsuccessfully, and that is a result rather
   * than an exception.
   */
  private async drainUploader(streamId: string, uploader: StreamUploader): Promise<StreamStatusReport> {
    let drainTimer: Timer | undefined;
    const drainTimeout = new Promise<void>((_, reject) => {
      drainTimer = this.clock.setTimer(
        () => reject(new DrainTimeoutError(DRAIN_TIMEOUT_MS)),
        DRAIN_TIMEOUT_MS,
        // A pending drain deadline is not a reason to keep the process alive.
        { unref: true },
      );
    });

    try {
      await Promise.race([uploader.notifyStop(), drainTimeout]);
      return { streamId, state: STREAM_LIFECYCLE_FINALIZED, settledAt: Date.now() };
    } catch (error) {
      const msg = getErrorMessage(error);
      this.logger.error(`[StreamOrchestrator] Force-stopping stream ${streamId}: ${msg}`);
      // The finalize is still running and we have stopped waiting for it, so from here this is a
      // session nobody tracks, under an id that is about to be free. Left owning the recovery entry,
      // it wrote its own state over the broadcast that took the id next and then deleted it, so a
      // crash lost a live stream outright. Measured: four saves carrying the abandoned session's feed
      // topic under the live session's id, then a remove.
      //
      // The cost is one duplicate VOD when nothing takes the id, since the entry now survives and the
      // next boot recovers a stream that may already be finalized. A wasted VOD is postage. The other
      // way round is a live broadcast with no recovery at all.
      uploader.retire();
      // `msg` is logged above and deliberately not returned. It is whatever Bee, the filesystem or a
      // timer produced, and this value is served verbatim by `GET /stream/status`. See S1.7.
      const reason = error instanceof DrainTimeoutError ? STOP_FAILURE_DRAIN_TIMEOUT : STOP_FAILURE_FINALIZE_FAILED;
      return { streamId, state: STREAM_LIFECYCLE_FAILED, reason, settledAt: Date.now() };
    } finally {
      // Losing the race does not cancel the timer, so without this every stop leaves a five minute
      // timer holding the event loop open, one per stopped stream.
      drainTimer?.cancel();
    }
  }
}
