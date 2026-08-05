import { Bee, PrivateKey, Topic } from '@ethersphere/bee-js';
import crypto from 'crypto';
import PQueue from 'p-queue';

import { MediaType, SegmentEntry, STREAM_STATUS_LIVE, STREAM_STATUS_VOD, StreamState } from '../types.js';
import { retryUntilDeadlineAsync } from '../utils/common.js';

import {
  AnnounceReadiness,
  needsCatalogAnnounce,
  onCatalogAnnounced,
  onFirstSegmentUploaded,
  READINESS_PENDING,
  readinessFromPersisted,
  readinessToPersisted,
} from './AnnounceReadiness.js';
import { ErrorHandler } from './ErrorHandler.js';
import { Logger } from './Logger.js';
import { ManifestManager } from './ManifestManager.js';
import { RecoveryStore } from './RecoveryStore.js';
import { ServiceMetrics } from './ServiceMetrics.js';
import { StreamCatalog } from './StreamCatalog.js';

const SEGMENT_UPLOAD_RETRY_WINDOW_MS = 15_000;
const MANIFEST_UPLOAD_RETRY_WINDOW_MS = 15_000;
const UPLOAD_RETRY_BASE_MS = 350;
const UPLOAD_RETRY_CAP_MS = 2_000;

/**
 * How long to wait before re-attempting a catalog announce that failed.
 *
 * The announce has to keep retrying, because the catalog entry is the only thing that makes a live
 * broadcast discoverable and a stream that gives up is unwatchable for its whole duration. What it
 * must not do is retry on the segment cadence, which is what tied a dead catalog to a feed read, a
 * feed write and the postage for it every two seconds. The right rate is how long a viewer can wait
 * for a broadcast to appear, not how often media arrives.
 */
const CATALOG_ANNOUNCE_RETRY_MS = 30_000;

interface RestoreState {
  streamRawTopic: string;
  socIndex: number | null;
  segments: SegmentEntry[];
  hlsHeaders: string[];
  isFirstSegmentReady: boolean;
  isFirstManifestReady: boolean;
  pendingDiscontinuity?: boolean;
}

export interface StreamUploaderOptions {
  /** State from a previous run of this stream id, so a restart resumes rather than starting over. */
  restoreState?: RestoreState;
  /**
   * How long to wait before re-attempting a failed catalog announce. Injectable only so the retry can
   * be driven in a test: at its default the sequence takes half a minute of wall clock.
   */
  catalogAnnounceRetryMs?: number;
  /** Process-lifetime counters this session reports into. Absent in tests that do not read them. */
  metrics?: ServiceMetrics;
}

export class StreamUploader {
  public readonly segmentQueue = new PQueue({ concurrency: 1 });
  private manifestQueue = new PQueue({ concurrency: 1 });
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  private bee: Bee;
  private streamSigner: PrivateKey;
  private streamRawTopic: string;
  private streamCatalog: StreamCatalog;
  private recoveryStore: RecoveryStore;
  private streamId: string;
  private stamp: string;
  private socIndex: number | null = null;
  private mediatype: MediaType;
  private readiness: AnnounceReadiness = READINESS_PENDING;
  private liveManifestQueued = false;
  private pendingDiscontinuity = false;
  private consecutiveManifestFailures = 0;
  private consecutiveSegmentFailures = 0;
  /**
   * The newest segment index a published live manifest has named, or null before the first publish.
   *
   * Null rather than restored from persisted state after a crash: the window a recovered uploader
   * publishes is built from segments it did reload, so a restored value would report the whole
   * outage as segments this uploader failed to name when nothing here failed at all.
   */
  private announcedThrough: number | null = null;
  private segmentsNeverNamed = 0;
  /** Whether the recovery entry under this stream id still describes this uploader. See `retire`. */
  private ownsRecoveryEntry = true;
  /** The one finalize this session gets, so a second caller joins it rather than repeating it. */
  private finalizing: Promise<void> | undefined;
  /** When the catalog announce first failed and has not since succeeded, or null while it is listed. */
  private catalogAnnounceFailedAt: number | null = null;
  private lastCatalogAnnounceAt: number | null = null;
  private readonly catalogAnnounceRetryMs: number;
  /** When this stream's state first failed to reach disk and has not since landed. See OBS-4. */
  private statePersistFailedAt: number | null = null;
  private readonly metrics?: ServiceMetrics;
  /** Playing time of everything still queued, in seconds, which is how far behind live this stream is. */
  private queuedSeconds = 0;
  /** Segments this session was handed, so an empty finalize can tell "nothing to record" from "lost it all". */
  private segmentsOffered = 0;

  private manifestManager: ManifestManager;

  constructor(
    bee: Bee,
    manifestBeeUrl: string,
    streamCatalog: StreamCatalog,
    recoveryStore: RecoveryStore,
    streamKey: string,
    stamp: string,
    streamId: string,
    mediatype: MediaType,
    options: StreamUploaderOptions = {},
  ) {
    const { restoreState } = options;
    this.catalogAnnounceRetryMs = options.catalogAnnounceRetryMs ?? CATALOG_ANNOUNCE_RETRY_MS;
    this.metrics = options.metrics;
    this.bee = bee;
    this.streamSigner = new PrivateKey(streamKey);
    this.streamCatalog = streamCatalog;
    this.recoveryStore = recoveryStore;
    this.streamId = streamId;
    this.stamp = stamp;
    this.mediatype = mediatype;

    this.manifestManager = new ManifestManager(manifestBeeUrl);

    if (restoreState) {
      this.streamRawTopic = restoreState.streamRawTopic;
      this.socIndex = restoreState.socIndex;
      const restored = readinessFromPersisted(restoreState);
      this.readiness = restored.readiness;
      if (restored.repairedFrom) {
        // Loud, because this pair cannot be produced by any live sequence, so the entry on disk was
        // corrupted or hand-edited and whoever owns the deployment should know. Repaired rather than
        // refused: see the note on `readinessFromPersisted`.
        this.logger.warn(
          `[StreamUploader] Recovery entry for ${streamId} claims the catalog announce happened ` +
            'before its first segment, which is not reachable. Treating the stream as not yet ' +
            'announced so it is published rather than left invisible.',
        );
      }
      this.pendingDiscontinuity = restoreState.pendingDiscontinuity ?? false;
      this.manifestManager.restoreState(restoreState.segments, restoreState.hlsHeaders);
      this.logger.info(`[StreamUploader] Restored stream ${streamId} at SOC index ${this.socIndex}`);
    } else {
      this.streamRawTopic = crypto.randomUUID();
    }
  }

  public handleSegment(segmentIndex: number, duration: number, data: Buffer): void {
    // Counted when queued and released however the job ends, so a stream whose uploads are failing
    // reports a backlog that drains rather than one that grows forever.
    this.queuedSeconds += duration;
    this.segmentsOffered += 1;
    this.segmentQueue.add(async () => {
      try {
        await this.uploadSegment(segmentIndex, duration, data);
      } finally {
        this.queuedSeconds -= duration;
      }
    });
  }

  public getQueuedSeconds(): number {
    return this.queuedSeconds;
  }

  private async uploadSegment(segmentIndex: number, duration: number, data: Buffer): Promise<void> {
    const result = await this.uploadDataToBee(data);
    if (!result) {
      // Nothing landed within the retry window; flag the next segment as a discontinuity
      // so players skip the gap instead of stalling on a silent hole.
      this.pendingDiscontinuity = true;
      this.consecutiveSegmentFailures += 1;
      this.logger.error(
        `Failed to upload segment ${segmentIndex} for stream ${this.streamId} within the retry window; marking a discontinuity`,
      );
      this.metrics?.recordSegmentDropped();
      this.persistState();
      return;
    }

    this.consecutiveSegmentFailures = 0;
    const ref = result.reference.toHex();
    this.manifestManager.addSegment(segmentIndex, duration, ref, this.pendingDiscontinuity);
    this.pendingDiscontinuity = false;
    this.readiness = onFirstSegmentUploaded(this.readiness);

    this.logger.log(`Segment ${segmentIndex} uploaded: ${ref}`);

    this.metrics?.recordSegmentUploaded(Date.now());
    this.uploadLiveManifest();
    this.persistState();
  }

  /**
   * Segments that never reached this uploader, because the engine could not download them from the
   * origin. The next segment carries a discontinuity so players skip the gap rather than stalling on
   * a hole they were told is contiguous. One contiguous gap is one call, however many it spans.
   *
   * Deliberately does **not** touch `consecutiveSegmentFailures`. That counter clears on the next
   * successful segment, and the engine writes a segment off and then downloads the one behind it in
   * the same pass, so the clearing success always lands before anything can read the count. The
   * signal for a loss is an age recorded by the orchestrator, which no later event makes untrue.
   *
   * Queued rather than applied inline so it takes its place behind segments already awaiting upload.
   * Applied inline, the discontinuity would attach to a segment that arrived before the gap.
   */
  public handleSegmentLoss(firstIndex: number, count: number): void {
    const subject = count === 1 ? `Segment ${firstIndex}` : `${count} segments from index ${firstIndex}`;
    this.queueDiscontinuity(() =>
      this.logger.error(`${subject} for stream ${this.streamId} never reached the uploader, marking a discontinuity`),
    );
  }

  /**
   * A discontinuity the origin declared with `#EXT-X-DISCONTINUITY`, meaning the media from here on is
   * not a continuation of what came before it. An encoder restart upstream produces exactly this, and
   * a manifest that omits it tells players the join is seamless, which is what they stall on.
   *
   * Ordinary rather than an error, unlike a loss: nothing went wrong here and nothing was dropped.
   */
  public markDiscontinuity(): void {
    this.queueDiscontinuity(() =>
      this.logger.info(`Origin declared a discontinuity for stream ${this.streamId}, marking the next segment`),
    );
  }

  /**
   * Queued rather than applied inline so it takes its place behind segments already awaiting upload.
   * Applied inline, the discontinuity would attach to a segment that arrived before the break.
   */
  private queueDiscontinuity(announce: () => void): void {
    this.segmentQueue.add(() => {
      this.pendingDiscontinuity = true;
      announce();
      this.persistState();
    });
  }

  public async notifyStart(): Promise<void> {
    const entry = {
      title: this.getFormattedDate(),
      owner: this.streamSigner.publicKey().address().toHex(),
      topic: this.streamRawTopic,
      state: STREAM_STATUS_LIVE,
      mediatype: this.mediatype,
      timestamp: Date.now(),
    };

    this.logger.log(`Adding stream to list: ${JSON.stringify(entry)}`);
    return this.streamCatalog.addStream(entry);
  }

  /**
   * Finalize this session as a VOD, once, however many callers ask.
   *
   * Two of them reach here for one session and neither can see the other. A reconnect during a drain
   * retires the live session and hands it to `finalizeRetiredSession`, which deliberately stays out of
   * the orchestrator's `drainPromises` because the id belongs to the replacement by then, so the guard
   * that answers a duplicate stop with the drain already running never sees it. Unguarded, both ran the
   * body below: two VOD manifests, each its own SOC write and the postage for it, and the second
   * rewriting the catalog entry the first had published.
   *
   * A finalize that throws is shared rather than retried, which is what the callers already did with
   * the orchestrator's drain promise, and no path retries one today.
   */
  public async notifyStop(): Promise<void> {
    this.finalizing ??= this.finalize();
    return this.finalizing;
  }

  private async finalize(): Promise<void> {
    await this.segmentQueue.onIdle();
    await this.manifestQueue.onIdle();

    if (!this.manifestManager.hasSegments()) {
      // A session nobody sent anything to ends cleanly: there is no recording because there was
      // nothing to record. A session that was handed media and has none to publish is the opposite,
      // and it used to end the same way, so a broadcast whose every upload failed answered
      // `finalized` byte for byte like a healthy stop and counted as one.
      if (this.segmentsOffered > 0) {
        throw new Error(
          `Stream ${this.streamId} was handed ${this.segmentsOffered} segment(s) and published none, so it has no VOD`,
        );
      }
      this.logger.warn(`Stream ${this.streamId} has no segments, skipping VOD finalization`);
      this.clearRecoveryEntry();
      return;
    }

    const vodManifest = this.manifestManager.buildVODManifest();
    const vodIndex = (await this.manifestQueue.add(() => this.commitManifest(vodManifest))) ?? null;
    if (vodIndex === null) {
      throw new Error(`Failed to upload VOD manifest for stream ${this.streamId}`);
    }

    const entry = {
      title: this.getFormattedDate(),
      owner: this.streamSigner.publicKey().address().toHex(),
      topic: this.streamRawTopic,
      state: STREAM_STATUS_VOD,
      index: vodIndex,
      duration: this.manifestManager.getTotalDuration(),
      mediatype: this.mediatype,
      timestamp: Date.now(),
    };

    this.logger.log(`Updating stream in list to VOD: ${JSON.stringify(entry)}`);
    await this.streamCatalog.addStream(entry);

    // Counted here rather than by the orchestrator because `notifyStop` is memoized, so this line
    // runs exactly once however many drains ask. Counting it from a drain double-counted a session
    // that a reconnect replaced, since two drains await this one promise.
    this.metrics?.recordStreamFinalized();
    this.clearRecoveryEntry();
  }

  /**
   * Stop owning the crash-recovery entry under this stream id, because a newer session now holds it.
   *
   * A re-announce starts the replacement while this uploader is still finalizing, and both carry the
   * same stream id. Everything this one writes to or deletes from the recovery store after that point
   * lands on a broadcast that is still running: a save replaces the live session's state with an
   * outgoing session's, and the delete at the end of `notifyStop` discards it outright. The published
   * media is unaffected, since each uploader owns its own feed topic.
   */
  public retire(): void {
    this.ownsRecoveryEntry = false;
  }

  private clearRecoveryEntry(): void {
    if (this.ownsRecoveryEntry) {
      this.recoveryStore.remove(this.streamId);
    }
  }

  public getStreamState(): StreamState {
    const manifestState = this.manifestManager.getState();
    return {
      streamId: this.streamId,
      streamRawTopic: this.streamRawTopic,
      mediatype: this.mediatype,
      socIndex: this.socIndex,
      segments: manifestState.segments,
      hlsHeaders: manifestState.hlsHeaders,
      ...readinessToPersisted(this.readiness),
      pendingDiscontinuity: this.pendingDiscontinuity,
      liveManifestStale: this.hasStaleLiveManifest(),
      updatedAt: Date.now(),
    };
  }

  public hasStaleLiveManifest(): boolean {
    return this.consecutiveManifestFailures > 0;
  }

  public getConsecutiveManifestFailures(): number {
    return this.consecutiveManifestFailures;
  }

  /**
   * Segments dropped back to back, each after its retry window was already spent. Unlike a manifest
   * publish, a dropped segment is not retried later: the data is gone and the next one is marked as a
   * discontinuity, so this counter is the only trace an upload failure leaves.
   */
  public getConsecutiveSegmentFailures(): number {
    return this.consecutiveSegmentFailures;
  }

  private uploadLiveManifest(): void {
    if (this.liveManifestQueued) {
      return;
    }

    this.liveManifestQueued = true;
    void this.manifestQueue.add(async () => {
      this.liveManifestQueued = false;
      const manifest = this.manifestManager.buildLiveManifest();
      if (!manifest) {
        return;
      }
      // Both read here, beside the build and before anything is awaited. `handleSegment` runs between
      // awaits, so either read taken after the publish returns would describe a manifest other than
      // the one being published.
      const newestNamed = this.manifestManager.liveWindowNewestIndex();
      const neverNamed =
        this.announcedThrough === null ? 0 : this.manifestManager.segmentsNeverNamed(this.announcedThrough);

      const index = await this.commitManifest(manifest);
      if (index === null) {
        this.consecutiveManifestFailures += 1;
        this.metrics?.recordManifestPublishFailure();
        this.logger.warn(
          `Live manifest for stream ${this.streamId} is stale: ${this.consecutiveManifestFailures} consecutive publish failure(s)`,
        );
        return;
      }

      this.consecutiveManifestFailures = 0;
      this.reportSegmentsNeverNamed(neverNamed);
      this.announcedThrough = newestNamed;
    });
  }

  /**
   * Segments that were uploaded and that no manifest will ever name.
   *
   * Their bytes are in Swarm and any viewer handed the address could fetch them. A viewer learns of a
   * segment only from a manifest, and the window slid past these before one naming them was
   * published, so the media is simply missing from every playlist with no discontinuity to mark it.
   * That makes this the quietest way this uploader can lose a piece of a broadcast, and until now
   * nothing counted it: `recordSegmentDropped` answers a failed upload and `recordSegmentsLost`
   * answers segments the engine never had.
   *
   * The window has to outrun its own publishing for this to happen, which
   * `MANIFEST_UPLOAD_RETRY_WINDOW_MS` permits for {@link MANIFEST_UPLOAD_RETRY_WINDOW_MS}ms while the
   * segment queue keeps running.
   */
  private reportSegmentsNeverNamed(count: number): void {
    if (count === 0) {
      return;
    }
    this.segmentsNeverNamed += count;
    this.metrics?.recordSegmentsNeverNamed(count);
    this.logger.warn(
      `Stream ${this.streamId} published a live manifest that skipped ${count} uploaded segment(s): ` +
        `the window advanced past them before a manifest naming them was published, so no viewer can ` +
        `reach them. ${this.segmentsNeverNamed} total this stream.`,
    );
  }

  /** Segments uploaded but never named in any published manifest, for the life of this stream. */
  public getSegmentsNeverNamed(): number {
    return this.segmentsNeverNamed;
  }

  private async commitManifest(manifestContent: string): Promise<number | null> {
    const nextIndex = this.socIndex === null ? 0 : this.socIndex + 1;
    const data = Buffer.from(manifestContent, 'utf-8');
    const result = await this.uploadDataAsSoc(nextIndex, data);

    if (!result) {
      this.logger.error(
        `Failed to upload manifest at SOC index ${nextIndex}; will retry at the same index when the next segment triggers a publish`,
      );
      return null;
    }

    this.socIndex = nextIndex;

    if (needsCatalogAnnounce(this.readiness)) {
      this.persistState();
      await this.announceToCatalog();
    }

    this.logger.log(`Manifest uploaded at SOC index ${nextIndex}`);
    this.persistState();
    return nextIndex;
  }

  /**
   * Publish this stream to the catalog, at most once per `CATALOG_ANNOUNCE_RETRY_MS`.
   *
   * The rate limit is the whole point: a failure left the stream short of `announced`, and every later
   * manifest publish then re-attempted, so a catalog that was down cost a paid feed write per segment
   * and nothing said so. Giving up instead would be worse, since the entry is the only thing that
   * makes a live broadcast discoverable, so this keeps trying at a rate set by the viewer rather than
   * by the encoder.
   */
  private async announceToCatalog(): Promise<void> {
    const now = Date.now();
    if (this.lastCatalogAnnounceAt !== null && now - this.lastCatalogAnnounceAt < this.catalogAnnounceRetryMs) {
      return;
    }

    this.lastCatalogAnnounceAt = now;
    try {
      await this.notifyStart();
      this.readiness = onCatalogAnnounced(this.readiness);
      this.catalogAnnounceFailedAt = null;
    } catch (error) {
      this.catalogAnnounceFailedAt ??= now;
      this.errorHandler.handleError(error, 'StreamUploader.notifyStart');
    }
  }

  /**
   * How long this stream has been live and absent from the catalog, or null while it is listed.
   *
   * An age rather than a count of failures, because the retry window and the segment cadence are
   * unrelated: a count says how many times the write was attempted, and the thing an operator needs
   * is how long a viewer has been unable to find a broadcast that is running.
   */
  public getMsSinceCatalogAnnounceFailed(): number | null {
    return this.catalogAnnounceFailedAt === null ? null : Date.now() - this.catalogAnnounceFailedAt;
  }

  /**
   * How long this stream's state has been failing to reach disk, or null when the last save landed.
   *
   * The failure was logged and otherwise swallowed, which made it the quietest way to lose a
   * broadcast: recovery reads whatever did land, so a crash then re-uploads or drops everything
   * written since, and until it happens the stream looks perfectly healthy.
   */
  public getMsSinceStatePersistFailed(): number | null {
    return this.statePersistFailedAt === null ? null : Date.now() - this.statePersistFailedAt;
  }

  private persistState(): void {
    if (!this.ownsRecoveryEntry) {
      return;
    }
    try {
      this.recoveryStore.save(this.streamId, this.getStreamState());
      this.statePersistFailedAt = null;
    } catch (error) {
      this.statePersistFailedAt ??= Date.now();
      this.logger.error(`Failed to persist state for ${this.streamId}:`, error);
    }
  }

  private async uploadDataAsSoc(index: number, data: Uint8Array) {
    try {
      const { uploadPayload } = this.bee.makeFeedWriter(Topic.fromString(this.streamRawTopic), this.streamSigner);
      // NOT deferred, unlike the segment write below, and the asymmetry is deliberate.
      //
      // Deferred means bee acks the SOC from its own local store and push-syncs it in the
      // background, so the publish reports success while the chunk is still only local and a
      // viewer's gateway is told about a segment it cannot yet resolve. This was deferred until
      // LAT-10 measured what that costs: worst capture-to-fetchable 14.04s and 14.53s over two
      // 30-minute broadcasts, against 9.04s and 9.27s with the synchronous write, and the buffer a
      // player needs 12.08s against 7.08s.
      //
      // The comment this replaces justified deferring as avoiding an ~80s block behind the segment
      // backlog. That was a post-restart condition. In steady state the synchronous push costs
      // about 300ms and logs no retries at all.
      //
      // Safe to block: retryUntilDeadlineAsync bounds retries, not one slow call.
      return await retryUntilDeadlineAsync(
        () => uploadPayload(this.stamp, data, { index, deferred: false }),
        MANIFEST_UPLOAD_RETRY_WINDOW_MS,
        UPLOAD_RETRY_BASE_MS,
        UPLOAD_RETRY_CAP_MS,
      );
    } catch (error) {
      this.errorHandler.handleError(error, 'StreamUploader.uploadDataAsSoc');
      return null;
    }
  }

  private async uploadDataToBee(data: Uint8Array) {
    try {
      return await retryUntilDeadlineAsync(
        () => this.bee.uploadData(this.stamp, data, { redundancyLevel: 1, deferred: true }),
        SEGMENT_UPLOAD_RETRY_WINDOW_MS,
        UPLOAD_RETRY_BASE_MS,
        UPLOAD_RETRY_CAP_MS,
      );
    } catch (error) {
      this.errorHandler.handleError(error, 'StreamUploader.uploadDataToBee');
      return null;
    }
  }

  private getFormattedDate(): string {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    return `${day}/${month}/${year}`;
  }
}
