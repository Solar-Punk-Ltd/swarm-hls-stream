import { Bee } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { RecoveryStore } from '../src/libs/RecoveryStore.js';
import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { MEDIA_TYPE_VIDEO, StreamState } from '../src/types.js';

const TEST_STREAM_KEY = '0'.repeat(63) + '1';
const RECOVERY_TIMEOUT_MS = 80;

function makeBee(): Bee {
  let refCounter = 0;
  return {
    uploadData: async () => ({ reference: { toHex: () => `ref${refCounter++}` } }),
    makeFeedWriter: () => ({
      uploadPayload: async (_stamp: string, _data: unknown, opts: { index: number }) => ({
        reference: { toHex: () => `soc${opts.index}` },
      }),
    }),
  } as unknown as Bee;
}

function makeCatalog(): StreamCatalog {
  return { addStream: async () => {} } as unknown as StreamCatalog;
}

function makeRecovery(overrides: Partial<Record<keyof RecoveryStore, unknown>> = {}): RecoveryStore {
  return {
    save: () => {},
    load: () => null,
    remove: () => {},
    listActive: () => [],
    ...overrides,
  } as unknown as RecoveryStore;
}

function makeOrchestrator(recovery: RecoveryStore = makeRecovery()): StreamOrchestrator {
  return new StreamOrchestrator(makeBee(), makeCatalog(), recovery, {
    streamKey: TEST_STREAM_KEY,
    stamp: 'stamp',
    manifestBeeUrl: '',
    maxQueueSize: 100,
    recoveryTimeout: RECOVERY_TIMEOUT_MS,
  });
}

function restoreState(streamId: string): StreamState {
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

async function waitFor(pred: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() >= deadline) {
      return;
    }
    await sleep(10);
  }
}

describe('StreamOrchestrator recovery-timer cancellation (F: uploader crash recovery)', () => {
  it('finalizes a recovered stream if no segments arrive before the recovery timeout', async () => {
    const id = 'live/stream';
    // RecoveryStore.listActive() returns the slash-sanitized filename, not the real streamId.
    const orch = makeOrchestrator(
      makeRecovery({ listActive: () => [id.replace(/[/\\]/g, '_')], load: () => restoreState(id) }),
    );

    await orch.recoverStreams();
    assert.equal(orch.getActiveStreamCount(), 1, 'recovered stream should be active with a pending timer');

    await waitFor(() => orch.getActiveStreamCount() === 0, RECOVERY_TIMEOUT_MS * 6);
    assert.equal(orch.getActiveStreamCount(), 0, 'an unfed recovered stream is finalized by the recovery timer');
  });

  it('keeps a recovered stream alive when segments resume before on_publish (cancels the finalize timer)', async () => {
    const id = 'live/stream';
    // RecoveryStore.listActive() returns the slash-sanitized filename, not the real streamId.
    const orch = makeOrchestrator(
      makeRecovery({ listActive: () => [id.replace(/[/\\]/g, '_')], load: () => restoreState(id) }),
    );

    await orch.recoverStreams();
    const result = orch.handleSegment(id, 7, 2, Buffer.from('seg7'));
    assert.equal(result.accepted, true, 'segments for a recovered stream must be accepted');

    await sleep(RECOVERY_TIMEOUT_MS * 3);
    assert.equal(
      orch.getActiveStreamCount(),
      1,
      'segments resuming must cancel the recovery timer so the stream is not VOD-ed mid-broadcast',
    );
    await orch.cleanup();
  });

  it('returns the ids of the streams it recovered so pull-based engines can resume them', async () => {
    const id = 'video/stream';
    const orch = makeOrchestrator(
      makeRecovery({ listActive: () => [id.replace(/[/\\]/g, '_')], load: () => restoreState(id) }),
    );

    const recovered = await orch.recoverStreams();

    assert.deepEqual(recovered, [id], 'recoverStreams must return the real stream ids it restored');
    await orch.cleanup();
  });
});

describe('StreamOrchestrator recovery hygiene', () => {
  it('skips a state-dir file that is not a stream state instead of crashing boot', async () => {
    // The state dir also holds non-stream JSON (e.g. the catalog feed-index file);
    // a foreign file must never crash recovery into a boot loop.
    const removed: string[] = [];
    const orch = makeOrchestrator(
      makeRecovery({
        listActive: () => ['catalog-feed-index'],
        load: () => ({ owner: 'aa'.repeat(20), topicHex: 'bb'.repeat(32), index: '000000000000007d' }) as never,
        remove: (id: string) => removed.push(id),
      }),
    );

    await orch.recoverStreams();

    assert.equal(orch.getActiveStreamCount(), 0, 'non-stream json in the state dir must be ignored');
    assert.deepEqual(removed, [], 'files we do not own must not be deleted');
  });
});

describe('StreamOrchestrator re-announce (E: engine restart)', () => {
  it('accepts a re-announced already-active stream and restarts it instead of rejecting', async () => {
    const id = 'live/stream';
    const removed: string[] = [];
    const orch = makeOrchestrator(makeRecovery({ remove: (streamId: string) => removed.push(streamId) }));

    assert.equal(orch.startStream(id, MEDIA_TYPE_VIDEO), true);
    await waitFor(() => orch.getActiveStreamCount() === 1);
    assert.equal(orch.getActiveStreamCount(), 1, 'first publish starts the stream');

    // Previously this returned false → SRS rejected the broadcaster. It must now be accepted.
    assert.equal(orch.startStream(id, MEDIA_TYPE_VIDEO), true, 're-announce of an active stream must be accepted');

    // The stale session is finalized (recovery state removed) and a fresh uploader takes its place.
    await waitFor(() => removed.includes(id) && orch.getActiveStreamCount() === 1);
    assert.ok(removed.includes(id), 'the stale session must be finalized on re-announce');
    assert.equal(orch.getActiveStreamCount(), 1, 'a fresh stream is active after the re-announce restart');
    await orch.cleanup();
  });
});
