import { Bee } from '@ethersphere/bee-js';
import PQueue from 'p-queue';

import {
  HealthSignals,
  MediaType,
  PRESSURE_HIGH,
  PRESSURE_LOW,
  PRESSURE_MEDIUM,
  QueuePressure,
  REJECT_QUEUE_FULL,
  REJECT_UNKNOWN_STREAM,
  SegmentResult,
} from '../types.js';
import { getErrorMessage } from '../utils/common.js';

import { ErrorHandler } from './ErrorHandler.js';
import { Logger } from './Logger.js';
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
}

export class StreamOrchestrator {
  private activeStreams = new Map<string, StreamUploader>();
  private drainPromises = new Map<string, Promise<void>>();
  private processedSegments = new Map<string, Set<number>>();
  private recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private queue = new PQueue({ concurrency: 1 });
  private lastStreamActivityAt: number | null = null;
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  constructor(
    private bee: Bee,
    private streamCatalog: StreamCatalog,
    private recoveryStore: RecoveryStore,
    private config: StreamOrchestratorConfig,
  ) {}

  public startStream(streamId: string, mediatype: MediaType): boolean {
    // If recovering, cancel the recovery timeout and resume
    const recoveryTimer = this.recoveryTimers.get(streamId);
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      this.recoveryTimers.delete(streamId);
      this.logger.info(`[StreamOrchestrator] Resumed recovering stream: ${streamId}`);
      return true;
    }

    if (this.activeStreams.has(streamId)) {
      // The engine re-announced a stream we still track — it restarted without sending on_unpublish
      // (e.g. the media engine was restarted). Finalize the stale session as a VOD, then start the
      // new one, so the broadcaster resumes instead of being rejected as "already active".
      this.logger.info(`[StreamOrchestrator] Stream ${streamId} re-announced; finalizing stale session and restarting`);
      void this.stopStream(streamId)
        .catch((error) => this.errorHandler.handleError(error, `StreamOrchestrator.restart - ${streamId}`))
        .then(() => this.spawnUploader(streamId, mediatype));
      return true;
    }

    this.spawnUploader(streamId, mediatype);
    return true;
  }

  private spawnUploader(streamId: string, mediatype: MediaType): void {
    this.queue.add(() => {
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
      this.processedSegments.set(streamId, new Set());
      this.lastStreamActivityAt = Date.now();
      this.logger.info(`[StreamOrchestrator] Started stream: ${streamId}`);
    });
  }

  public handleSegment(streamId: string, segmentIndex: number, duration: number, data: Buffer): SegmentResult {
    const uploader = this.activeStreams.get(streamId);
    if (!uploader) {
      return { accepted: false, reason: REJECT_UNKNOWN_STREAM };
    }

    // Segments arriving mean the engine is feeding this stream again. If it was just recovered after
    // a crash, cancel the pending finalize timer: an engine does not re-announce a session that
    // stayed open across the crash, so startStream never fires to clear the timer, and the stream
    // would otherwise be finalized as VOD mid-broadcast when it expires.
    const recoveryTimer = this.recoveryTimers.get(streamId);
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      this.recoveryTimers.delete(streamId);
      this.logger.info(`[StreamOrchestrator] Segments resumed for ${streamId}; cancelled recovery finalize timer`);
    }

    // Deduplication
    const processed = this.processedSegments.get(streamId);
    if (processed?.has(segmentIndex)) {
      this.lastStreamActivityAt = Date.now();
      return { accepted: true }; // silently accept duplicate
    }

    // Backpressure check
    if (uploader.segmentQueue.size >= this.config.maxQueueSize) {
      return { accepted: false, reason: REJECT_QUEUE_FULL };
    }

    processed?.add(segmentIndex);
    this.lastStreamActivityAt = Date.now();
    uploader.handleSegment(segmentIndex, duration, data);
    return { accepted: true };
  }

  public async stopStream(streamId: string): Promise<void> {
    // Cancel recovery timer if stopping a recovering stream
    const recoveryTimer = this.recoveryTimers.get(streamId);
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      this.recoveryTimers.delete(streamId);
    }

    const drainPromise = this.performDrain(streamId);
    this.drainPromises.set(streamId, drainPromise);

    try {
      await drainPromise;
    } finally {
      this.drainPromises.delete(streamId);
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
      this.lastStreamActivityAt = Date.now();

      // Rebuild processed segments set from state
      const processed = new Set(state.segments.map((s) => s.index));
      this.processedSegments.set(streamId, processed);

      // Set recovery timeout — if engine doesn't reconnect, finalize as VOD
      const timer = setTimeout(async () => {
        this.recoveryTimers.delete(streamId);
        this.logger.info(`[StreamOrchestrator] Recovery timeout for ${streamId}, finalizing as VOD`);
        await this.stopStream(streamId);
      }, this.config.recoveryTimeout);

      this.recoveryTimers.set(streamId, timer);

      this.logger.info(
        `[StreamOrchestrator] Recovered stream ${streamId} with ${state.segments.length} segments, ` +
          `waiting ${this.config.recoveryTimeout}ms for engine reconnect`,
      );

      recovered.push(streamId);
    }

    return recovered;
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
   * Milliseconds since a stream last registered or a segment was last accepted, or `null` while no
   * stream is registered. Registration counts, so a stream that announces and then sends nothing is
   * measured from its announcement rather than looking healthy forever.
   */
  public getMsSinceStreamActivity(): number | null {
    if (this.activeStreams.size === 0 || this.lastStreamActivityAt === null) {
      return null;
    }
    return Date.now() - this.lastStreamActivityAt;
  }

  public getSegmentStallMs(): number {
    return this.config.segmentStallMs;
  }

  public getHealthSignals(): HealthSignals {
    return {
      activeStreams: this.activeStreams.size,
      staleManifestStreams: this.getStaleManifestStreamCount(),
      maxConsecutiveManifestFailures: this.getMaxConsecutiveManifestFailures(),
      maxConsecutiveSegmentFailures: this.getMaxConsecutiveSegmentFailures(),
      queuePressure: this.getOverallQueuePressure(),
      msSinceStreamActivity: this.getMsSinceStreamActivity(),
    };
  }

  public async cleanup(): Promise<void> {
    // Clear all recovery timers
    for (const timer of this.recoveryTimers.values()) {
      clearTimeout(timer);
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

    await this.queue.onIdle();
    this.queue.clear();

    this.logger.info('[StreamOrchestrator] Cleanup complete');
  }

  private async performDrain(streamId: string): Promise<void> {
    await this.queue.onIdle();

    const uploader = this.activeStreams.get(streamId);
    if (!uploader) {
      this.logger.warn(`[StreamOrchestrator] No uploader found for ${streamId}`);
      this.recoveryStore.remove(streamId);
      return;
    }

    const drainTimeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`Drain timeout after ${DRAIN_TIMEOUT_MS}ms`)), DRAIN_TIMEOUT_MS);
    });

    try {
      await Promise.race([uploader.notifyStop(), drainTimeout]);
    } catch (error) {
      const msg = getErrorMessage(error);
      this.logger.error(`[StreamOrchestrator] Force-stopping stream ${streamId}: ${msg}`);
    }

    this.activeStreams.delete(streamId);
    this.processedSegments.delete(streamId);

    if (this.activeStreams.size === 0) {
      this.lastStreamActivityAt = null;
    }

    this.logger.info(`[StreamOrchestrator] Stopped stream: ${streamId}`);
  }
}
