import { Bee } from '@ethersphere/bee-js';

import { RecoveryStore } from '../../src/libs/RecoveryStore.js';
import { StreamCatalog } from '../../src/libs/StreamCatalog.js';
import { StreamOrchestrator, StreamOrchestratorConfig } from '../../src/libs/StreamOrchestrator.js';
import { MEDIA_TYPE_VIDEO, StreamState } from '../../src/types.js';

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
  /** Manifest SOC write. Defaults to resolving with a reference for the requested index. */
  uploadPayload?: (index: number) => Promise<unknown>;
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
      uploadPayload: async (_stamp: string, _data: unknown, opts: { index: number }) =>
        uploads.uploadPayload ? uploads.uploadPayload(opts.index) : { reference: { toHex: () => `soc${opts.index}` } },
    }),
  } as unknown as Bee;
}

export function makeFakeCatalog(): StreamCatalog {
  return { addStream: async () => {} } as unknown as StreamCatalog;
}

/** A catalog that appends every published entry, for asserting that a VOD actually landed. */
export function makeRecordingCatalog(published: unknown[]): StreamCatalog {
  return {
    addStream: async (entry: unknown) => {
      published.push(entry);
    },
  } as unknown as StreamCatalog;
}

export function makeFakeRecoveryStore(overrides: Partial<Record<keyof RecoveryStore, unknown>> = {}): RecoveryStore {
  return {
    save: () => {},
    load: () => null,
    remove: () => {},
    listActive: () => [],
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
    manifestBeeUrl: '',
    maxQueueSize: 100,
    recoveryTimeout: 60_000,
    segmentStallMs: 30_000,
    segmentDedupWindow: 10_000,
    ...config,
  });
}
