import { Bee, PrivateKey, Topic } from '@ethersphere/bee-js';
import crypto from 'crypto';
import PQueue from 'p-queue';

import { MediaType, SegmentEntry, STREAM_STATUS_LIVE, STREAM_STATUS_VOD, StreamState } from '../types.js';
import { retryAwaitableAsync } from '../utils/common.js';

import { ErrorHandler } from './ErrorHandler.js';
import { Logger } from './Logger.js';
import { ManifestManager } from './ManifestManager.js';
import { RecoveryStore } from './RecoveryStore.js';
import { StreamCatalog } from './StreamCatalog.js';

interface RestoreState {
  streamRawTopic: string;
  socIndex: number;
  segments: SegmentEntry[];
  hlsHeaders: string[];
  isFirstSegmentReady: boolean;
  isFirstManifestReady: boolean;
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
        this.logger.error(`Failed to upload segment ${segmentIndex} for stream ${this.streamId}`);
        return;
      }

      const ref = result.reference.toHex();
      this.manifestManager.addSegment(segmentIndex, duration, ref);
      this.isFirstSegmentReady = true;

      this.logger.log(`Segment ${segmentIndex} uploaded: ${ref}`);

      await this.uploadLiveManifest();
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

    // Upload final VOD manifest
    const vodManifest = this.manifestManager.buildVODManifest();
    await this.uploadManifestData(vodManifest);
    await this.manifestQueue.onIdle();

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
    };
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
