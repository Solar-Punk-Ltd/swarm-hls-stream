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
import { retryAwaitableAsync } from '../utils/common.js';

import { averageBandwidth, emptyBitrateSample, peakBandwidth, recordSegment } from './BitrateMeter.js';
import { ErrorHandler } from './ErrorHandler.js';
import { Logger } from './Logger.js';
import { ManifestManager } from './ManifestManager.js';
import { RecoveryStore } from './RecoveryStore.js';
import { StreamCatalog } from './StreamCatalog.js';

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
  socIndex: number;
  segments: SegmentEntry[];
  hlsHeaders: string[];
  isFirstSegmentReady: boolean;
  isFirstManifestReady: boolean;
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
  private socIndex: number | null = null;
  private mediatype: MediaType;
  private ladder?: LadderMembership;
  private isFirstSegmentReady = false;
  private isFirstManifestReady = false;

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
        this.logger.error(`Failed to upload segment ${segmentIndex} for stream ${this.streamId}`);
        return;
      }

      const ref = result.reference.toHex();
      this.manifestManager.addSegment(segmentIndex, duration, ref);
      this.isFirstSegmentReady = true;

      this.logger.log(`Segment ${segmentIndex} uploaded: ${ref}`);

      await this.uploadLiveManifest();
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

    // Upload final VOD manifest
    const vodManifest = this.manifestManager.buildVODManifest();
    await this.uploadManifestData(vodManifest);
    await this.manifestQueue.onIdle();

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
      index: this.socIndex!,
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
      socIndex: this.socIndex ?? 0,
      segments: manifestState.segments,
      hlsHeaders: manifestState.hlsHeaders,
      isFirstSegmentReady: this.isFirstSegmentReady,
      isFirstManifestReady: this.isFirstManifestReady,
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

  private async uploadLiveManifest(): Promise<void> {
    const liveManifest = this.manifestManager.buildLiveManifest();
    if (!liveManifest) {
      return;
    }

    await this.uploadManifestData(liveManifest);
  }

  private async uploadManifestData(manifestContent: string): Promise<void> {
    this.socIndex = this.socIndex === null ? 0 : this.socIndex + 1;
    const currentIndex = this.socIndex;

    this.manifestQueue.add(async () => {
      const data = Buffer.from(manifestContent, 'utf-8');
      const result = await this.uploadDataAsSoc(currentIndex, data);

      if (result) {
        if (this.isFirstSegmentReady && !this.isFirstManifestReady) {
          this.isFirstManifestReady = true;
          await this.notifyStart();
        }
        this.logger.log(`Manifest uploaded at SOC index ${currentIndex}`);
      } else {
        this.logger.error(`Failed to upload manifest at SOC index ${currentIndex}`);
      }
    });
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
      return retryAwaitableAsync(() => uploadPayload(this.stamp, data, { index }));
    } catch (error) {
      this.errorHandler.handleError(error, 'StreamUploader.uploadDataAsSoc');
      return null;
    }
  }

  private async uploadDataToBee(data: Uint8Array) {
    try {
      return retryAwaitableAsync(() => this.bee.uploadData(this.stamp, data, { redundancyLevel: 1 }));
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
