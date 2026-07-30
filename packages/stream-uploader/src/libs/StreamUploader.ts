import { Bee, PrivateKey, Topic } from '@ethersphere/bee-js';
import crypto from 'crypto';
import PQueue from 'p-queue';

import { MediaType, SegmentEntry, STREAM_STATUS_LIVE, STREAM_STATUS_VOD, StreamState } from '../types.js';
import { retryUntilDeadlineAsync } from '../utils/common.js';

import { ErrorHandler } from './ErrorHandler.js';
import { Logger } from './Logger.js';
import { ManifestManager } from './ManifestManager.js';
import { RecoveryStore } from './RecoveryStore.js';
import { StreamCatalog } from './StreamCatalog.js';

const SEGMENT_UPLOAD_RETRY_WINDOW_MS = 15_000;
const MANIFEST_UPLOAD_RETRY_WINDOW_MS = 15_000;
const UPLOAD_RETRY_BASE_MS = 350;
const UPLOAD_RETRY_CAP_MS = 2_000;

interface RestoreState {
  streamRawTopic: string;
  socIndex: number | null;
  segments: SegmentEntry[];
  hlsHeaders: string[];
  isFirstSegmentReady: boolean;
  isFirstManifestReady: boolean;
  pendingDiscontinuity?: boolean;
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
  private isFirstSegmentReady = false;
  private isFirstManifestReady = false;
  private liveManifestQueued = false;
  private pendingDiscontinuity = false;
  private consecutiveManifestFailures = 0;
  private consecutiveSegmentFailures = 0;

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
    restoreState?: RestoreState,
  ) {
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
      this.isFirstSegmentReady = restoreState.isFirstSegmentReady;
      this.isFirstManifestReady = restoreState.isFirstManifestReady;
      this.pendingDiscontinuity = restoreState.pendingDiscontinuity ?? false;
      this.manifestManager.restoreState(restoreState.segments, restoreState.hlsHeaders);
      this.logger.info(`[StreamUploader] Restored stream ${streamId} at SOC index ${this.socIndex}`);
    } else {
      this.streamRawTopic = crypto.randomUUID();
    }
  }

  public handleSegment(segmentIndex: number, duration: number, data: Buffer): void {
    this.segmentQueue.add(async () => {
      const result = await this.uploadDataToBee(data);
      if (!result) {
        // Nothing landed within the retry window; flag the next segment as a discontinuity
        // so players skip the gap instead of stalling on a silent hole.
        this.pendingDiscontinuity = true;
        this.consecutiveSegmentFailures += 1;
        this.logger.error(
          `Failed to upload segment ${segmentIndex} for stream ${this.streamId} within the retry window; marking a discontinuity`,
        );
        this.persistState();
        return;
      }

      this.consecutiveSegmentFailures = 0;
      const ref = result.reference.toHex();
      this.manifestManager.addSegment(segmentIndex, duration, ref, this.pendingDiscontinuity);
      this.pendingDiscontinuity = false;
      this.isFirstSegmentReady = true;

      this.logger.log(`Segment ${segmentIndex} uploaded: ${ref}`);

      this.uploadLiveManifest();
      this.persistState();
    });
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
    this.segmentQueue.add(() => {
      this.pendingDiscontinuity = true;
      const subject = count === 1 ? `Segment ${firstIndex}` : `${count} segments from index ${firstIndex}`;
      this.logger.error(`${subject} for stream ${this.streamId} never reached the uploader, marking a discontinuity`);
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

  public async notifyStop(): Promise<void> {
    await this.segmentQueue.onIdle();
    await this.manifestQueue.onIdle();

    if (!this.manifestManager.hasSegments()) {
      this.logger.warn(`Stream ${this.streamId} has no segments, skipping VOD finalization`);
      this.recoveryStore.remove(this.streamId);
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

    this.recoveryStore.remove(this.streamId);
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
      isFirstSegmentReady: this.isFirstSegmentReady,
      isFirstManifestReady: this.isFirstManifestReady,
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
      const index = await this.commitManifest(manifest);
      if (index === null) {
        this.consecutiveManifestFailures += 1;
        this.logger.warn(
          `Live manifest for stream ${this.streamId} is stale: ${this.consecutiveManifestFailures} consecutive publish failure(s)`,
        );
      } else {
        this.consecutiveManifestFailures = 0;
      }
    });
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

    if (this.isFirstSegmentReady && !this.isFirstManifestReady) {
      this.persistState();
      try {
        await this.notifyStart();
        this.isFirstManifestReady = true;
      } catch (error) {
        this.errorHandler.handleError(error, 'StreamUploader.notifyStart');
      }
    }

    this.logger.log(`Manifest uploaded at SOC index ${nextIndex}`);
    this.persistState();
    return nextIndex;
  }

  private persistState(): void {
    try {
      this.recoveryStore.save(this.streamId, this.getStreamState());
    } catch (error) {
      this.logger.error(`Failed to persist state for ${this.streamId}:`, error);
    }
  }

  private async uploadDataAsSoc(index: number, data: Uint8Array) {
    try {
      const { uploadPayload } = this.bee.makeFeedWriter(Topic.fromString(this.streamRawTopic), this.streamSigner);
      // deferred: bee acks the SOC from its local store and push-syncs in the background (honored
      // since bee 2.8.1). A direct /soc write blocks until push-sync completes, which held manifest
      // publishes for ~80s behind the segment backlog after a node restart.
      return await retryUntilDeadlineAsync(
        () => uploadPayload(this.stamp, data, { index, deferred: true }),
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
