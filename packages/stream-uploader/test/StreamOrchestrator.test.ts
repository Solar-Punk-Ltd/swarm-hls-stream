import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { RecoveryStore } from '../src/libs/RecoveryStore.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { MEDIA_TYPE_VIDEO } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import {
  makeFakeRecoveryStore,
  makeRecordingCatalog,
  makeRecoveredState,
  makeTestOrchestrator,
  toRecoveryFileId,
} from './helpers/fakes.js';

const RECOVERY_TIMEOUT_MS = 80;

function makeOrchestrator(recovery: RecoveryStore = makeFakeRecoveryStore()): StreamOrchestrator {
  return makeTestOrchestrator({ recoveryTimeout: RECOVERY_TIMEOUT_MS }, {}, recovery);
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

describe('recovery file id sanitizing', () => {
  // RecoveryStore names files by a slash-sanitized id, and recoverStreams relies on that to find the
  // real stream id inside the state. Nothing pinned it: the helper could return its input unchanged and
  // every other test still passed, because they all sanitize on both sides of the comparison.
  it('replaces both path separators so a stream id becomes one file name', () => {
    assert.equal(toRecoveryFileId('live/stream'), 'live_stream');
    assert.equal(toRecoveryFileId('live\\stream'), 'live_stream');
    assert.equal(toRecoveryFileId('a/b\\c/d'), 'a_b_c_d');
  });

  it('leaves an id with no separator alone', () => {
    assert.equal(toRecoveryFileId('catalog-feed-index'), 'catalog-feed-index');
  });
});

describe('StreamOrchestrator recovery-timer cancellation (F: uploader crash recovery)', () => {
  it('finalizes a recovered stream if no segments arrive before the recovery timeout', async () => {
    const id = 'live/stream';
    const orch = makeOrchestrator(
      makeFakeRecoveryStore({ listActive: () => [toRecoveryFileId(id)], load: () => makeRecoveredState(id) }),
    );

    await orch.recoverStreams();
    assert.equal(orch.getActiveStreamCount(), 1, 'recovered stream should be active with a pending timer');

    await waitFor(() => orch.getActiveStreamCount() === 0, RECOVERY_TIMEOUT_MS * 6);
    assert.equal(orch.getActiveStreamCount(), 0, 'an unfed recovered stream is finalized by the recovery timer');
  });

  it('keeps a recovered stream alive when segments resume before on_publish (cancels the finalize timer)', async () => {
    const id = 'live/stream';
    const orch = makeOrchestrator(
      makeFakeRecoveryStore({ listActive: () => [toRecoveryFileId(id)], load: () => makeRecoveredState(id) }),
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
      makeFakeRecoveryStore({ listActive: () => [toRecoveryFileId(id)], load: () => makeRecoveredState(id) }),
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
      makeFakeRecoveryStore({
        listActive: () => ['catalog-feed-index'],
        load: () => ({ owner: 'aa'.repeat(20), topicHex: 'bb'.repeat(32), index: '000000000000007d' } as never),
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
    const orch = makeOrchestrator(makeFakeRecoveryStore({ remove: (streamId: string) => removed.push(streamId) }));

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

describe('StreamOrchestrator recovery finalization on an injected clock (S0.5)', () => {
  const RECOVERY_TIMEOUT_60S = 60_000;

  interface CatalogEntry {
    state: string;
    topic: string;
  }

  function makeRecoveringOrchestrator(clock: FakeClock, catalogEntries: CatalogEntry[], removed: string[]) {
    const id = 'live/stream';
    const recovery = makeFakeRecoveryStore({
      listActive: () => [toRecoveryFileId(id)],
      load: () => makeRecoveredState(id),
      remove: (streamId: string) => removed.push(streamId),
    });

    return makeTestOrchestrator(
      { recoveryTimeout: RECOVERY_TIMEOUT_60S, clock },
      {},
      recovery,
      makeRecordingCatalog(catalogEntries),
    );
  }

  it('finalizes an unfed recovered stream when 60s is advanced, with no real waiting', async () => {
    const clock = new FakeClock();
    const catalogEntries: CatalogEntry[] = [];
    const removed: string[] = [];
    const orch = makeRecoveringOrchestrator(clock, catalogEntries, removed);

    await orch.recoverStreams();
    assert.equal(orch.getActiveStreamCount(), 1, 'the recovered stream waits with a pending timer');
    assert.equal(clock.pendingCount(), 1, 'exactly one recovery timer is scheduled');

    // One step past a minute. Real time does not move, so this costs no wall clock.
    clock.advance(RECOVERY_TIMEOUT_60S + 1);
    await waitFor(() => orch.getActiveStreamCount() === 0);

    assert.equal(orch.getActiveStreamCount(), 0, 'the timer fired and the stream was finalized');
    // TEST-4: the old assertion stopped at the count above, which passes even if nothing was published.
    assert.deepEqual(
      catalogEntries.map((entry) => entry.state),
      ['vod'],
      'finalizing must publish the VOD entry, not merely forget the stream',
    );
    assert.deepEqual(removed, ['live/stream'], 'and must clear the recovery state it owns');
  });

  it('does not fire the recovery timer one millisecond early', async () => {
    const clock = new FakeClock();
    const orch = makeRecoveringOrchestrator(clock, [], []);

    await orch.recoverStreams();
    clock.advance(RECOVERY_TIMEOUT_60S - 1);

    assert.equal(orch.getActiveStreamCount(), 1, 'the stream is still waiting just short of the timeout');
    assert.equal(clock.pendingCount(), 1, 'and its timer is still pending');
    await orch.cleanup();
  });

  it('cancels the recovery timer when the engine re-announces, so advancing time does nothing', async () => {
    const clock = new FakeClock();
    const catalogEntries: CatalogEntry[] = [];
    const orch = makeRecoveringOrchestrator(clock, catalogEntries, []);

    await orch.recoverStreams();
    assert.equal(clock.pendingCount(), 1, 'the finalize timer was scheduled on the injected clock');
    assert.equal(orch.startStream('live/stream', MEDIA_TYPE_VIDEO), true, 'the re-announce resumes the stream');
    assert.equal(clock.pendingCount(), 0, 'resuming cancels the pending finalize timer');

    clock.advance(RECOVERY_TIMEOUT_60S * 10);

    assert.equal(orch.getActiveStreamCount(), 1, 'a resumed stream is never VOD-ed by the timer it cancelled');
    assert.deepEqual(catalogEntries, [], 'and nothing is published as VOD');
    await orch.cleanup();
  });
});
