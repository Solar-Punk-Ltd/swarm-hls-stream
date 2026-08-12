import { Bee, PrivateKey, Topic } from '@ethersphere/bee-js';
import PQueue from 'p-queue';

import {
  BitrateSample,
  LadderMembership,
  MediaType,
  Rendition,
  SegmentEntry,
  STREAM_STATUS_LIVE,
  STREAM_STATUS_VOD,
  StreamState,
} from '../types.js';
import { retryUntilDeadlineAsync } from '../utils/common.js';

import { averageBandwidth, emptyBitrateSample, peakBandwidth, recordSegment } from './BitrateMeter.js';
import { ErrorHandler } from './ErrorHandler.js';
import { Logger } from './Logger.js';
import { ManifestManager } from './ManifestManager.js';
import { RecoveryStore } from './RecoveryStore.js';
import { StreamCatalog } from './StreamCatalog.js';

const SEGMENT_UPLOAD_RETRY_WINDOW_MS = 15_000;
const MANIFEST_UPLOAD_RETRY_WINDOW_MS = 15_000;
const UPLOAD_RETRY_BASE_MS = 350;
const UPLOAD_RETRY_CAP_MS = 2_000;

/**
 * How far the measured bitrate has to drift, and how long between corrections, before a rung
 * rewrites the catalog.
 *
 * BANDWIDTH is the whole supply-side input to the player's ABR decision, so it has to end up
 * honest — but the catalog is one feed shared by every stream, and republishing per segment would
 * have four rungs contending on it every fragment. Announce on the encoder's target, then correct
 * only when the measurement has actually moved.
 */
const BITRATE_REFRESH_RATIO = 0.15;
const BITRATE_REFRESH_INTERVAL_MS = 30_000;


interface RestoreState {
  streamRawTopic: string;
  socIndex: number | null;
  segments: SegmentEntry[];
  hlsHeaders: string[];
  isFirstSegmentReady: boolean;
  isFirstManifestReady: boolean;
  pendingDiscontinuity?: boolean;
  bitrate?: BitrateSample;
}

export interface StreamUploaderOptions {
  bee: Bee;
  manifestBeeUrl: string;
  streamCatalog: StreamCatalog;
  recoveryStore: RecoveryStore;
  streamKey: string;
  stamp: string;
  streamId: string;
  /**
   * Feed topic for this stream's manifest. Supplied rather than generated, because a ladder's
   * rungs derive theirs from a shared group id and the orchestrator is what knows the group.
   */
  streamTopic: string;
  mediatype: MediaType;
  /**
   * Erasure-coding level for segment uploads.
   *
   * Parity is durability insurance, and it is paid for twice on a live stream: once on upload, and
   * again by every viewer, because the extra chunks widen the retrieval fan-out that dominates how
   * long a segment takes to arrive. A segment that outlives its playlist window is of no use to
   * anyone, so for live the insurance mostly buys nothing. 0 turns it off.
   */
  redundancyLevel: number;
  ladder?: LadderMembership;
  restoreState?: RestoreState;
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
  private redundancyLevel: number;
  private socIndex: number | null = null;
  private mediatype: MediaType;
  private ladder?: LadderMembership;
  private isFirstSegmentReady = false;
  private isFirstManifestReady = false;
  private liveManifestQueued = false;
  private pendingDiscontinuity = false;
  private consecutiveManifestFailures = 0;

  private bitrate: BitrateSample = emptyBitrateSample();
  private announcedBandwidth = 0;
  private lastBandwidthAnnounceAt = 0;

  private manifestManager: ManifestManager;

  constructor(options: StreamUploaderOptions) {
    this.bee = options.bee;
    this.streamSigner = new PrivateKey(options.streamKey);
    this.streamCatalog = options.streamCatalog;
    this.recoveryStore = options.recoveryStore;
    this.streamId = options.streamId;
    this.stamp = options.stamp;
    this.redundancyLevel = options.redundancyLevel;
    this.mediatype = options.mediatype;
    this.ladder = options.ladder;
    this.streamRawTopic = options.streamTopic;

    this.manifestManager = new ManifestManager(options.manifestBeeUrl);

    const restoreState = options.restoreState;
    if (restoreState) {
      this.streamRawTopic = restoreState.streamRawTopic;
      this.socIndex = restoreState.socIndex;
      this.isFirstSegmentReady = restoreState.isFirstSegmentReady;
      this.isFirstManifestReady = restoreState.isFirstManifestReady;
      this.pendingDiscontinuity = restoreState.pendingDiscontinuity ?? false;
      if (restoreState.bitrate) {
        this.bitrate = restoreState.bitrate;
      }
      this.manifestManager.restoreState(restoreState.segments, restoreState.hlsHeaders);
      this.logger.info(`[StreamUploader] Restored stream ${options.streamId} at SOC index ${this.socIndex}`);
    }
  }

  public handleSegment(segmentIndex: number, duration: number, data: Buffer): void {
    recordSegment(this.bitrate, data.length, duration);

    this.segmentQueue.add(async () => {
      const result = await this.uploadDataToBee(data);
      if (!result) {
        // Nothing landed within the retry window; flag the next segment as a discontinuity
        // so players skip the gap instead of stalling on a silent hole.
        this.pendingDiscontinuity = true;
        this.logger.error(
          `Failed to upload segment ${segmentIndex} for stream ${this.streamId} within the retry window; marking a discontinuity`,
        );
        this.persistState();
        return;
      }

      const ref = result.reference.toHex();
      this.manifestManager.addSegment(segmentIndex, duration, ref, this.pendingDiscontinuity);
      this.pendingDiscontinuity = false;
      this.isFirstSegmentReady = true;

      this.logger.log(`Segment ${segmentIndex} uploaded: ${ref}`);

      this.uploadLiveManifest();
      // Not gated on the manifest publish any more, now that it is queued rather than awaited. The
      // drift check guards on isFirstManifestReady itself, so before the first publish lands it is
      // a no-op and the next segment retries it.
      await this.refreshBandwidthIfDrifted();
      this.persistState();
    });
  }

  public async notifyStart(): Promise<void> {
    if (this.ladder) {
      return this.announceRendition();
    }

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

    if (this.ladder) {
      await this.announceRendition({ index: this.socIndex!, duration: this.manifestManager.getTotalDuration() });
      this.recoveryStore.remove(this.streamId);
      return;
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
      ladder: this.ladder,
      bitrate: this.bitrate,
    };
  }

  /**
   * What the ladder rung looks like to a player right now.
   *
   * Falls back to the encoder's configured target until segments have actually been measured, so
   * the master playlist is complete and usable from the first one rather than advertising a
   * bandwidth of zero.
   */
  private buildRendition(final?: { index: number; duration: number }): Rendition {
    const rung = this.ladder!.rung;
    const configuredBps = rung.configuredKbps * 1000;

    return {
      name: rung.name,
      width: rung.width,
      height: rung.height,
      topic: this.streamRawTopic,
      bandwidth: peakBandwidth(this.bitrate, configuredBps),
      avgBandwidth: averageBandwidth(this.bitrate, configuredBps),
      ...(final ?? {}),
    };
  }

  public hasStaleLiveManifest(): boolean {
    return this.consecutiveManifestFailures > 0;
  }

  private async announceRendition(final?: { index: number; duration: number }): Promise<void> {
    const rendition = this.buildRendition(final);

    this.announcedBandwidth = rendition.bandwidth;
    this.lastBandwidthAnnounceAt = Date.now();

    this.logger.log(`Publishing rendition ${rendition.name} of ladder ${this.ladder!.group}`);
    return this.streamCatalog.upsertRendition(
      {
        title: this.getFormattedDate(),
        owner: this.streamSigner.publicKey().address().toHex(),
        group: this.ladder!.group,
        mediatype: this.mediatype,
      },
      rendition,
    );
  }

  private async refreshBandwidthIfDrifted(): Promise<void> {
    if (!this.ladder || !this.isFirstManifestReady || this.announcedBandwidth <= 0) {
      return;
    }

    if (Date.now() - this.lastBandwidthAnnounceAt < BITRATE_REFRESH_INTERVAL_MS) {
      return;
    }

    const drift = Math.abs(this.bitrate.peakBps - this.announcedBandwidth) / this.announcedBandwidth;
    if (drift < BITRATE_REFRESH_RATIO) {
      return;
    }

    await this.announceRendition();
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
        () => this.bee.uploadData(this.stamp, data, { redundancyLevel: this.redundancyLevel, deferred: true }),
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
