import { Bee } from '@ethersphere/bee-js';

import {
  HealthSignals,
  MediaType,
  PRESSURE_HIGH,
  PRESSURE_LOW,
  PRESSURE_MEDIUM,
  QueuePressure,
  REJECT_DRAINING,
  REJECT_QUEUE_FULL,
  REJECT_UNKNOWN_STREAM,
  SegmentResult,
} from '../types.js';
import { getErrorMessage } from '../utils/common.js';

import { Clock, systemClock, Timer } from './Clock.js';
import { ErrorHandler } from './ErrorHandler.js';
import { Logger } from './Logger.js';
import { RecentSegmentIndexes } from './RecentSegmentIndexes.js';
import { RecoveryStore } from './RecoveryStore.js';
import { StreamCatalog } from './StreamCatalog.js';
import { StreamUploader } from './StreamUploader.js';

const DRAIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface StreamOrchestratorConfig {
  streamKey: string;
  stamp: string;
  manifestBeeUrl: string;
  maxQueueSize: number;
  recoveryTimeout: number;
  segmentStallMs: number;
  /** How many further segments an index stays remembered for, so a duplicate inside that is refused. */
  segmentDedupWindow: number;
  /** Defaults to the real clock. Injected so tests can step time rather than wait for it. */
  clock?: Clock;
}

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
   * Per stream, the monotonic reading at which it last showed progress. Monotonic rather than wall
   * clock so a backwards NTP step cannot make an age negative and hide a stall. Registration counts
   * as progress, so a stream that announces and then sends nothing is measured from its announcement.
   */
  private streamActivityAt = new Map<string, number>();
  /** Per stream, the monotonic reading of the most recent segment the engine could not deliver. */
  private segmentLossAt = new Map<string, number>();
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  constructor(
    private bee: Bee,
    private streamCatalog: StreamCatalog,
    private recoveryStore: RecoveryStore,
    private config: StreamOrchestratorConfig,
  ) {
    this.clock = config.clock ?? systemClock;
  }

  private readonly clock: Clock;

  public startStream(streamId: string, mediatype: MediaType): boolean {
    // If recovering, cancel the recovery timeout and resume
    const recoveryTimer = this.recoveryTimers.get(streamId);
    if (recoveryTimer) {
      recoveryTimer.cancel();
      this.recoveryTimers.delete(streamId);
      // The re-announce is itself progress. Without this the stream rejoins the stall signal carrying
      // the age it accumulated while waiting, and a successful resume reports degraded until the first
      // segment lands.
      this.streamActivityAt.set(streamId, this.clock.now());
      this.logger.info(`[StreamOrchestrator] Resumed recovering stream: ${streamId}`);
      return true;
    }

    const stale = this.activeStreams.get(streamId);
    if (stale) {
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
      this.spawnUploader(streamId, mediatype);
      void this.finalizeRetiredSession(streamId, stale);
      return true;
    }

    this.spawnUploader(streamId, mediatype);
    return true;
  }

  /**
   * Detach a stream from the live maps so nothing can reach it by id any more, without waiting for
   * it to finish. The caller keeps the uploader and is responsible for finalizing it.
   */
  private retireSession(streamId: string): void {
    this.activeStreams.delete(streamId);
    this.processedSegments.delete(streamId);
    this.streamActivityAt.delete(streamId);
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
      await this.drainUploader(streamId, uploader);
      this.logger.info(`[StreamOrchestrator] Finalized the replaced session for ${streamId}`);
    } catch (error) {
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
  private spawnUploader(streamId: string, mediatype: MediaType): void {
    const uploader = new StreamUploader(
      this.bee,
      this.config.manifestBeeUrl,
      this.streamCatalog,
      this.recoveryStore,
      this.config.streamKey,
      this.config.stamp,
      streamId,
      mediatype,
    );

    this.activeStreams.set(streamId, uploader);
    this.processedSegments.set(streamId, this.newDuplicateFilter());
    this.streamActivityAt.set(streamId, this.clock.now());
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

    if (this.isDraining(streamId, uploader)) {
      return { accepted: false, reason: REJECT_DRAINING };
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
    uploader.handleSegment(segmentIndex, duration, data);
    return { accepted: true };
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
          streamRawTopic: state.streamRawTopic,
          socIndex: state.socIndex,
          segments: state.segments,
          hlsHeaders: state.hlsHeaders,
          isFirstSegmentReady: state.isFirstSegmentReady,
          isFirstManifestReady: state.isFirstManifestReady,
          pendingDiscontinuity: state.pendingDiscontinuity,
        },
      );

      this.activeStreams.set(streamId, uploader);
      this.streamActivityAt.set(streamId, this.clock.now());

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

      recovered.push(streamId);
    }

    return recovered;
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

  public getHealthSignals(): HealthSignals {
    return {
      activeStreams: this.activeStreams.size,
      staleManifestStreams: this.getStaleManifestStreamCount(),
      maxConsecutiveManifestFailures: this.getMaxConsecutiveManifestFailures(),
      maxConsecutiveSegmentFailures: this.getMaxConsecutiveSegmentFailures(),
      queuePressure: this.getOverallQueuePressure(),
      msSinceStreamActivity: this.getMsSinceStreamActivity(),
      msSinceSegmentLoss: this.getMsSinceSegmentLoss(),
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

    await this.drainUploader(streamId, uploader);

    // A re-announce during this drain registers a replacement under the same id, so detaching by id
    // now would unregister a live session that this drain never touched. Every segment after that
    // comes back as an unknown stream, permanently, and the stall signal cannot see it either
    // because the id is no longer in `activeStreams` at all.
    if (this.activeStreams.get(streamId) !== uploader) {
      this.logger.info(`[StreamOrchestrator] Drained a replaced session for ${streamId}, its successor stays live`);
      return;
    }

    this.retireSession(streamId);

    this.logger.info(`[StreamOrchestrator] Stopped stream: ${streamId}`);
  }

  /** Let an uploader finish what it has in hand and publish its VOD, under a deadline. */
  private async drainUploader(streamId: string, uploader: StreamUploader): Promise<void> {
    let drainTimer: Timer | undefined;
    const drainTimeout = new Promise<void>((_, reject) => {
      drainTimer = this.clock.setTimer(
        () => reject(new Error(`Drain timeout after ${DRAIN_TIMEOUT_MS}ms`)),
        DRAIN_TIMEOUT_MS,
        // A pending drain deadline is not a reason to keep the process alive.
        { unref: true },
      );
    });

    try {
      await Promise.race([uploader.notifyStop(), drainTimeout]);
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
    } finally {
      // Losing the race does not cancel the timer, so without this every stop leaves a five minute
      // timer holding the event loop open, one per stopped stream.
      drainTimer?.cancel();
    }
  }
}
