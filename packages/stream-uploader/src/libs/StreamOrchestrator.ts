import { Bee } from '@ethersphere/bee-js';
import crypto from 'crypto';
import PQueue from 'p-queue';

import {
  LadderMembership,
  MediaType,
  PRESSURE_HIGH,
  PRESSURE_LOW,
  PRESSURE_MEDIUM,
  QueuePressure,
  REJECT_QUEUE_FULL,
  REJECT_UNKNOWN_STREAM,
  SegmentResult,
} from '../types.js';

import { AbrLadder } from './AbrLadder.js';
import { ErrorHandler } from './ErrorHandler.js';
import { Logger } from './Logger.js';
import { RecoveryStore } from './RecoveryStore.js';
import { StreamCatalog } from './StreamCatalog.js';
import { StreamUploader } from './StreamUploader.js';

const DRAIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface StreamOrchestratorConfig {
  streamKey: string;
  stamp: string;
  manifestBeeUrl: string;
  maxQueueSize: number;
  recoveryTimeout: number;
  ladder?: AbrLadder;
}

export class StreamOrchestrator {
  private activeStreams = new Map<string, StreamUploader>();
  private drainPromises = new Map<string, Promise<void>>();
  private processedSegments = new Map<string, Set<number>>();
  private recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Ladder id per base stream, so the four rungs of one source share a catalog entry. */
  private ladderGroups = new Map<string, string>();
  private streamBases = new Map<string, string>();
  private queue = new PQueue({ concurrency: 1 });
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
      this.logger.warn(`[StreamOrchestrator] Stream ${streamId} already active, rejecting start`);
      return false;
    }

    // Resolved before queueing: the rungs of one ladder publish within milliseconds of each
    // other, and a group id assigned inside the queue's async callback would let two of them
    // create two groups for the same source.
    const match = this.config.ladder?.match(streamId) ?? null;
    let ladder: LadderMembership | undefined;
    let streamTopic: string;

    if (match) {
      const group = this.groupFor(match.baseStreamId);
      ladder = { group, rung: match.rung };
      streamTopic = ladderTopic(group, match.rung.name);
      this.streamBases.set(streamId, match.baseStreamId);
      this.logger.info(`[StreamOrchestrator] ${streamId} is rung ${match.rung.name} of ladder ${group}`);
    } else {
      streamTopic = crypto.randomUUID();
    }

    this.queue.add(() => {
      const uploader = new StreamUploader({
        bee: this.bee,
        manifestBeeUrl: this.config.manifestBeeUrl,
        streamCatalog: this.streamCatalog,
        recoveryStore: this.recoveryStore,
        streamKey: this.config.streamKey,
        stamp: this.config.stamp,
        streamId,
        streamTopic,
        mediatype,
        ladder,
      });

      this.activeStreams.set(streamId, uploader);
      this.processedSegments.set(streamId, new Set());
      this.logger.info(`[StreamOrchestrator] Started stream: ${streamId}`);
    });

    return true;
  }

  public handleSegment(streamId: string, segmentIndex: number, duration: number, data: Buffer): SegmentResult {
    const uploader = this.activeStreams.get(streamId);
    if (!uploader) {
      return { accepted: false, reason: REJECT_UNKNOWN_STREAM };
    }

    // Deduplication
    const processed = this.processedSegments.get(streamId);
    if (processed?.has(segmentIndex)) {
      return { accepted: true }; // silently accept duplicate
    }

    // Backpressure check
    if (uploader.segmentQueue.size >= this.config.maxQueueSize) {
      return { accepted: false, reason: REJECT_QUEUE_FULL };
    }

    processed?.add(segmentIndex);
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

  public async recoverStreams(): Promise<void> {
    const activeIds = this.recoveryStore.listActive();

    if (activeIds.length === 0) {
      this.logger.info('[StreamOrchestrator] No streams to recover');
      return;
    }

    this.logger.info(`[StreamOrchestrator] Recovering ${activeIds.length} stream(s)...`);

    for (const streamId of activeIds) {
      const state = this.recoveryStore.load(streamId);
      if (!state) {
        this.recoveryStore.remove(streamId);
        continue;
      }

      // Reinstate the ladder from what was persisted, not from the current ABR_LADDER: a rung
      // that was mid-stream keeps the group and topic its siblings already published under, even
      // if the ladder has been reconfigured since.
      if (state.ladder) {
        const base = baseStreamId(streamId, state.ladder.rung.name);
        this.ladderGroups.set(base, state.ladder.group);
        this.streamBases.set(streamId, base);
      }

      const uploader = new StreamUploader({
        bee: this.bee,
        manifestBeeUrl: this.config.manifestBeeUrl,
        streamCatalog: this.streamCatalog,
        recoveryStore: this.recoveryStore,
        streamKey: this.config.streamKey,
        stamp: this.config.stamp,
        streamId: state.streamId,
        streamTopic: state.streamRawTopic,
        mediatype: state.mediatype,
        ladder: state.ladder,
        restoreState: {
          streamRawTopic: state.streamRawTopic,
          socIndex: state.socIndex,
          segments: state.segments,
          hlsHeaders: state.hlsHeaders,
          isFirstSegmentReady: state.isFirstSegmentReady,
          isFirstManifestReady: state.isFirstManifestReady,
          bitrate: state.bitrate,
        },
      });

      this.activeStreams.set(streamId, uploader);

      // Rebuild processed segments set from state
      const processed = new Set(state.segments.map(s => s.index));
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
    }
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

  public async cleanup(): Promise<void> {
    // Clear all recovery timers
    for (const timer of this.recoveryTimers.values()) {
      clearTimeout(timer);
    }
    this.recoveryTimers.clear();

    // Stop all active streams
    const streamIds = Array.from(this.activeStreams.keys());
    await Promise.all(
      streamIds.map(async streamId => {
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

  private groupFor(base: string): string {
    const existing = this.ladderGroups.get(base);
    if (existing) {
      return existing;
    }

    const group = crypto.randomUUID();
    this.ladderGroups.set(base, group);
    return group;
  }

  private releaseLadder(streamId: string): void {
    const base = this.streamBases.get(streamId);
    this.streamBases.delete(streamId);

    if (!base) {
      return;
    }

    // The group only dies once its last rung has. A source that restarts while a sibling is
    // still draining must not be handed a second group for the same ladder.
    const stillRunning = [...this.streamBases.values()].some(other => other === base);
    if (!stillRunning) {
      this.ladderGroups.delete(base);
    }
  }

  private async performDrain(streamId: string): Promise<void> {
    await this.queue.onIdle();

    const uploader = this.activeStreams.get(streamId);
    if (!uploader) {
      this.logger.warn(`[StreamOrchestrator] No uploader found for ${streamId}`);
      this.recoveryStore.remove(streamId);
      this.releaseLadder(streamId);
      return;
    }

    const drainTimeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`Drain timeout after ${DRAIN_TIMEOUT_MS}ms`)), DRAIN_TIMEOUT_MS);
    });

    try {
      await Promise.race([uploader.notifyStop(), drainTimeout]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[StreamOrchestrator] Force-stopping stream ${streamId}: ${msg}`);
    }

    this.activeStreams.delete(streamId);
    this.processedSegments.delete(streamId);
    this.releaseLadder(streamId);

    this.logger.info(`[StreamOrchestrator] Stopped stream: ${streamId}`);
  }
}

/**
 * The rung's feed topic, derived from the ladder id rather than drawn fresh.
 *
 * Deriving it means every rung's topic is known the moment the ladder exists, which is what lets
 * the catalog entry stay one entry with a stable identity while its rungs come up one by one.
 */
function ladderTopic(group: string, rung: string): string {
  return `${group}-${rung}`;
}

function baseStreamId(streamId: string, rung: string): string {
  const suffix = `_${rung}`;
  return streamId.endsWith(suffix) ? streamId.slice(0, -suffix.length) : streamId;
}
