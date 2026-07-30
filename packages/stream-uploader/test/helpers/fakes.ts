import { Bee } from '@ethersphere/bee-js';

import { RecoveryStore } from '../../src/libs/RecoveryStore.js';
import { StreamCatalog } from '../../src/libs/StreamCatalog.js';
import { StreamOrchestrator, StreamOrchestratorConfig } from '../../src/libs/StreamOrchestrator.js';

const TEST_STREAM_KEY = '0'.repeat(63) + '1';

/**
 * A status outside `RETRYABLE_HTTP_STATUSES`, so `retryUntilDeadlineAsync` rethrows on the first
 * attempt instead of burning its 15 second window. Without this a single induced upload failure
 * takes 15 seconds of wall clock.
 */
const NON_RETRYABLE_STATUS = 400;

export interface FakeUploads {
  /** Segment payload write. Defaults to resolving with a fresh reference. */
  uploadData?: () => Promise<unknown>;
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
        uploads.uploadPayload
          ? uploads.uploadPayload(opts.index)
          : { reference: { toHex: () => `soc${opts.index}` } },
    }),
  } as unknown as Bee;
}

export function makeFakeCatalog(): StreamCatalog {
  return { addStream: async () => {} } as unknown as StreamCatalog;
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

export function makeTestOrchestrator(
  config: Partial<StreamOrchestratorConfig> = {},
  uploads: FakeUploads = {},
  recoveryStore: RecoveryStore = makeFakeRecoveryStore(),
): StreamOrchestrator {
  return new StreamOrchestrator(makeFakeBee(uploads), makeFakeCatalog(), recoveryStore, {
    streamKey: TEST_STREAM_KEY,
    stamp: 'stamp',
    manifestBeeUrl: '',
    maxQueueSize: 100,
    recoveryTimeout: 60_000,
    ...config,
  });
}
