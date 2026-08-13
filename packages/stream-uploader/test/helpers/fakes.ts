import { Bee } from '@ethersphere/bee-js';

import { RecoveryStore } from '../../src/libs/RecoveryStore.js';
import { MetricsSnapshot } from '../../src/libs/ServiceMetrics.js';
import { StreamCatalog } from '../../src/libs/StreamCatalog.js';
import { StreamOrchestrator, StreamOrchestratorConfig } from '../../src/libs/StreamOrchestrator.js';
import {
  HealthSignals,
  MEDIA_TYPE_VIDEO,
  PRESSURE_LOW,
  RECOVERY_ENTRY_LOADED,
  RECOVERY_ENTRY_MISSING,
  RecoveryEntry,
  STREAM_LIFECYCLE_UNKNOWN,
  StreamState,
} from '../../src/types.js';

const TEST_STREAM_KEY = '0'.repeat(63) + '1';

/**
 * A status outside `RETRYABLE_HTTP_STATUSES`, so `retryUntilDeadlineAsync` rethrows on the first
 * attempt instead of burning its 15 second window. Without this a single induced upload failure
 * takes 15 seconds of wall clock.
 */
const NON_RETRYABLE_STATUS = 400;

export interface FakeUploads {
  /** Segment payload write, called as Bee is: stamp, then payload. Defaults to a fresh reference. */
  uploadData?: (stamp: string, data: Uint8Array) => Promise<unknown>;
  /**
   * Manifest SOC write. Defaults to resolving with a reference for the requested index.
   *
   * The payload is passed too, so a test can read the playlist a viewer would be served rather than
   * only counting that one was published.
   */
  uploadPayload?: (index: number, payload: unknown) => Promise<unknown>;
}

/** Rejects immediately with a non-retryable status, standing in for a Bee that refuses the write. */
export function rejectImmediately(): Promise<never> {
  return Promise.reject({ status: NON_RETRYABLE_STATUS, message: 'fake bee refused the write' });
}

/** Never settles, standing in for a Bee that accepted the connection and went silent. */
export function neverSettles(): Promise<never> {
  return new Promise<never>(() => {});
}

export function makeFakeBee(uploads: FakeUploads = {}): Bee {
  let refCounter = 0;
  return {
    uploadData: uploads.uploadData ?? (async () => ({ reference: { toHex: () => `ref${refCounter++}` } })),
    makeFeedWriter: () => ({
      uploadPayload: async (_stamp: string, data: unknown, opts: { index: number }) =>
        uploads.uploadPayload
          ? uploads.uploadPayload(opts.index, data)
          : { reference: { toHex: () => `soc${opts.index}` } },
    }),
  } as unknown as Bee;
}

/**
 * Every method the orchestrator and the uploader call on the catalog, so a stub cannot go stale by
 * omitting one. Cast through `unknown`, so a method the callers start using is not a compile error
 * anywhere: it is a runtime failure in whichever tests happen to reach that line. That has now
 * happened three times in this repository, twice on the orchestrator stub and once here, which is
 * why the shape lives in one place and every stub takes overrides rather than rebuilding it.
 */
export function makeFakeCatalog(overrides: Record<string, unknown> = {}): StreamCatalog {
  return {
    addStream: async () => {},
    getMsSinceIndexSaveFailed: () => null,
    ...overrides,
  } as unknown as StreamCatalog;
}

/** A catalog that appends every published entry, for asserting that a VOD actually landed. */
export function makeRecordingCatalog(published: unknown[]): StreamCatalog {
  return makeFakeCatalog({
    addStream: async (entry: unknown) => {
      published.push(entry);
    },
  });
}

/**
 * Every method a test double for the orchestrator plausibly needs, so a stub cannot go stale by
 * omitting one. The same shape and the same reason as `makeFakeCatalog`, one layer up.
 *
 * This has now broken five times, most of them on a stub that was correct when it was written: the
 * cast through `unknown` means a method the production code starts calling is not a compile error
 * anywhere, so it surfaces as a `TypeError` in whichever tests happen to reach that line, and only
 * in those. Prefer `makeTestOrchestrator`, which is a real orchestrator. Reach for this one only
 * when the test is about what the caller does with the answer, and pass the answers as overrides.
 */
export function makeFakeOrchestrator(overrides: Record<string, unknown> = {}): StreamOrchestrator {
  return {
    startStream: () => true,
    stopStream: async () => {},
    handleSegment: () => ({ accepted: true }),
    handleSegmentLoss: () => true,
    keepAlive: () => false,
    recordSegmentsSkipped: () => {},
    recordAuthRejection: () => {},
    getStreamStatus: () => ({ streamId: '', state: STREAM_LIFECYCLE_UNKNOWN }),
    getSegmentStallMs: () => 30_000,
    getHealthSignals: () => makeHealthSignals(),
    getMetricsSnapshot: () => makeMetricsSnapshot(),
    ...overrides,
  } as unknown as StreamOrchestrator;
}

/** An entirely healthy reading, so a test that cares about one signal sets only that one. */
export function makeHealthSignals(overrides: Partial<HealthSignals> = {}): HealthSignals {
  return {
    activeStreams: 0,
    staleManifestStreams: 0,
    maxConsecutiveManifestFailures: 0,
    maxConsecutiveSegmentFailures: 0,
    queuePressure: PRESSURE_LOW,
    msSinceStreamActivity: null,
    msSinceSegmentLoss: null,
    msSinceCatalogAnnounceFailed: null,
    msSinceStatePersistFailed: null,
    queueBacklogSeconds: 0,
    msSinceAuthRejection: null,
    hasIngestedMedia: false,
    segmentsSkipped: 0,
    openingSegmentsWithheld: 0,
    segmentsNeverNamed: 0,
    quarantinedRecoveryEntries: 0,
    ...overrides,
  };
}

/** A process that has done nothing yet, which is every counter at zero and no segment on record. */
export function makeMetricsSnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    segmentsUploadedTotal: 0,
    segmentsDroppedTotal: 0,
    segmentsLostTotal: 0,
    segmentsSkippedTotal: 0,
    openingSegmentsWithheldTotal: 0,
    segmentsNeverNamedTotal: 0,
    manifestPublishFailuresTotal: 0,
    streamsFinalizedTotal: 0,
    streamsFailedTotal: 0,
    streamsReapedTotal: 0,
    segmentDurationsUnreadTotal: 0,
    authRejectionsTotal: 0,
    takeoversRefusedTotal: 0,
    lastSegmentAt: null,
    activeStreams: 0,
    queueDepth: 0,
    queueBacklogSeconds: 0,
    ...overrides,
  };
}

export function makeFakeRecoveryStore(overrides: Partial<Record<keyof RecoveryStore, unknown>> = {}): RecoveryStore {
  const load = (overrides.load as ((fileId: string) => StreamState | null) | undefined) ?? (() => null);

  return {
    save: () => {},
    remove: () => {},
    listActive: () => [],
    listQuarantined: () => [],
    quarantine: () => null,
    load,
    // Recovery reads through `read`, so deriving it from `load` keeps every fake that names only
    // `load` describing one store. A test that needs a damaged entry overrides `read` itself, since
    // that is exactly the distinction `load` cannot express.
    read: (fileId: string): RecoveryEntry => {
      const state = load(fileId);
      return state === null ? { kind: RECOVERY_ENTRY_MISSING } : { kind: RECOVERY_ENTRY_LOADED, state };
    },
    ...overrides,
  } as unknown as RecoveryStore;
}

/** A stream state as RecoveryStore.load would return it, for exercising the recovery path. */
export function makeRecoveredState(streamId: string): StreamState {
  return {
    streamId,
    streamRawTopic: 'topic-xyz',
    mediatype: MEDIA_TYPE_VIDEO,
    socIndex: 3,
    segments: [{ index: 0, duration: 2, ref: 'ref0', discontinuity: false }],
    hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
    isFirstSegmentReady: true,
    isFirstManifestReady: true,
    pendingDiscontinuity: false,
    liveManifestStale: false,
    updatedAt: Date.now(),
  };
}

/** RecoveryStore.listActive returns the slash-sanitized file name, not the real stream id. */
export function toRecoveryFileId(streamId: string): string {
  return streamId.replace(/[/\\]/g, '_');
}

export function makeTestOrchestrator(
  config: Partial<StreamOrchestratorConfig> = {},
  uploads: FakeUploads = {},
  recoveryStore: RecoveryStore = makeFakeRecoveryStore(),
  catalog: StreamCatalog = makeFakeCatalog(),
): StreamOrchestrator {
  return new StreamOrchestrator(makeFakeBee(uploads), catalog, recoveryStore, {
    streamKey: TEST_STREAM_KEY,
    stamp: 'stamp',
    maxQueueSize: 100,
    recoveryTimeout: 60_000,
    orphanReapMs: 60_000,
    segmentStallMs: 30_000,
    segmentDedupWindow: 10_000,
    ...config,
  });
}
