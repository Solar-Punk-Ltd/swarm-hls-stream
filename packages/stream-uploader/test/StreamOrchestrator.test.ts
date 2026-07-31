import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { RecoveryStore } from '../src/libs/RecoveryStore.js';
import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { MEDIA_TYPE_VIDEO, STREAM_STATUS_VOD, StreamState } from '../src/types.js';

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
  interface PublishedEntry {
    state: string;
  }

  function startedOrchestrator(published: unknown[], removed: string[]): StreamOrchestrator {
    return makeTestOrchestrator(
      { recoveryTimeout: RECOVERY_TIMEOUT_MS },
      {},
      makeFakeRecoveryStore({ remove: (streamId: string) => removed.push(streamId) }),
      makeRecordingCatalog(published),
    );
  }

  it('accepts a re-announced already-active stream and restarts it instead of rejecting', async () => {
    const id = 'live/stream';
    const published: unknown[] = [];
    const removed: string[] = [];
    const orch = startedOrchestrator(published, removed);

    assert.equal(orch.startStream(id, MEDIA_TYPE_VIDEO), true);
    await waitFor(() => orch.getActiveStreamCount() === 1);
    assert.equal(orch.getActiveStreamCount(), 1, 'first publish starts the stream');
    // Content, so finalizing the stale session is observable as the VOD it publishes. Recovery-entry
    // removal cannot serve as that signal any more: the id belongs to the live session by then.
    orch.handleSegment(id, 0, 2, Buffer.from('one'));

    // Previously this returned false → SRS rejected the broadcaster. It must now be accepted.
    assert.equal(orch.startStream(id, MEDIA_TYPE_VIDEO), true, 're-announce of an active stream must be accepted');

    await waitFor(() => published.some((entry) => (entry as PublishedEntry).state === STREAM_STATUS_VOD));
    assert.ok(
      published.some((entry) => (entry as PublishedEntry).state === STREAM_STATUS_VOD),
      'the stale session must be finalized on re-announce, not abandoned',
    );
    assert.equal(orch.getActiveStreamCount(), 1, 'a fresh stream is active after the re-announce restart');
    await orch.cleanup();
  });

  // The outgoing session and the live one share a stream id, and the recovery entry under it now
  // describes the live one. Anything the outgoing session writes there lands on a broadcast that is
  // still running: its VOD commit saves an outgoing session's state over the live one's, and the
  // delete that ends `notifyStop` discards it outright. Both directions, because each fails alone.
  it('stops touching the recovery entry once another session has replaced it', async () => {
    const id = 'live/stream';
    const published: unknown[] = [];
    const removed: string[] = [];
    const saved: StreamState[] = [];
    const orch = makeTestOrchestrator(
      { recoveryTimeout: RECOVERY_TIMEOUT_MS },
      {},
      makeFakeRecoveryStore({
        remove: (streamId: string) => removed.push(streamId),
        save: (_streamId: string, state: StreamState) => saved.push(state),
      }),
      makeRecordingCatalog(published),
    );

    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => orch.getActiveStreamCount() === 1);
    orch.handleSegment(id, 0, 2, Buffer.from('one'));
    await waitFor(() => saved.length > 0);

    // Each uploader owns a freshly generated feed topic, so the topic is what tells the outgoing
    // session's recovery writes apart from the live one's.
    const retiredTopic = saved[saved.length - 1].streamRawTopic;
    const writesBeforeRetirement = saved.length;

    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => published.some((entry) => (entry as PublishedEntry).state === STREAM_STATUS_VOD));
    await waitFor(() => orch.getActiveStreamCount() === 1);
    orch.handleSegment(id, 0, 2, Buffer.from('two'));
    await waitFor(() => saved.length > writesBeforeRetirement);

    const afterRetirement = saved.slice(writesBeforeRetirement);
    assert.ok(
      !afterRetirement.some((state) => state.streamRawTopic === retiredTopic),
      'the replaced session saved its own state over the recovery entry of the session that replaced it',
    );
    assert.deepEqual(
      removed,
      [],
      'finalizing the replaced session deleted the recovery entry of the session that replaced it',
    );
    await orch.cleanup();
  });

  // A broadcaster that drops and reconnects inside the drain its own disconnect started. The stop
  // captured the outgoing uploader before the reconnect, so when it finishes it must not detach
  // whatever holds the id by then. Getting this wrong is silent and permanent: the reconnected
  // session is unregistered, every segment comes back as an unknown stream, and with the id gone
  // from the active map the stall signal has nothing left to report it through.
  it('keeps the reconnected session when a stop that began before it finishes after it', async () => {
    const id = 'live/stream';
    const published: unknown[] = [];
    const finalizeStarted: string[] = [];
    const orch = makeTestOrchestrator({ recoveryTimeout: RECOVERY_TIMEOUT_MS }, {}, makeFakeRecoveryStore(), {
      addStream: async (entry: unknown) => {
        finalizeStarted.push('vod');
        // Long enough that the reconnect below lands inside this drain rather than after it.
        await sleep(60);
        published.push(entry);
      },
    } as unknown as StreamCatalog);

    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => orch.getActiveStreamCount() === 1);
    orch.handleSegment(id, 0, 2, Buffer.from('one'));

    // The disconnect. Deliberately not awaited: every caller in the engines fires it and moves on.
    const stopping = orch.stopStream(id);
    await waitFor(() => finalizeStarted.length > 0);

    // The reconnect, while that drain is still running.
    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => orch.getActiveStreamCount() === 1);
    await stopping;

    assert.equal(orch.getActiveStreamCount(), 1, 'the drain that started first unregistered the reconnected session');
    assert.deepEqual(
      orch.handleSegment(id, 0, 2, Buffer.from('two')),
      { accepted: true },
      'the reconnected broadcaster cannot deliver anything, and nothing reports why',
    );
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
    await clock.advance(RECOVERY_TIMEOUT_60S);
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

  it('measures stream activity age from the injected clock', async () => {
    const clock = new FakeClock();
    const orch = makeRecoveringOrchestrator(clock, [], []);

    await orch.recoverStreams();
    assert.equal(orch.getMsSinceStreamActivity(), null, 'a stream awaiting reconnect is excluded from the signal');

    orch.startStream('live/stream', MEDIA_TYPE_VIDEO);
    await clock.advance(5_000);

    assert.equal(
      orch.getMsSinceStreamActivity(),
      5_000,
      'the age comes from the clock, so stepping it must move the /health stall signal',
    );
    await orch.cleanup();
  });

  it('does not fire the recovery timer one millisecond early', async () => {
    const clock = new FakeClock();
    const orch = makeRecoveringOrchestrator(clock, [], []);

    await orch.recoverStreams();
    await clock.advance(RECOVERY_TIMEOUT_60S - 1);

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

    await clock.advance(RECOVERY_TIMEOUT_60S * 10);
    // advance yields a macrotask per fired timer, so a finalize that wrongly started has had room to
    // land by now. Asserting immediately after a synchronous advance could not see it at all.
    await waitFor(() => catalogEntries.length > 0, 200);

    assert.equal(orch.getActiveStreamCount(), 1, 'a resumed stream is never VOD-ed by the timer it cancelled');
    assert.deepEqual(catalogEntries, [], 'and nothing is published as VOD');
    await orch.cleanup();
  });
});

describe('StreamOrchestrator segment loss (OBS-11)', () => {
  it('carries a loss through to the uploader, so the next segment is a discontinuity', async () => {
    // Neither side of this link was crossed: the uploader tests call its method directly and the
    // health tests read /health, so the orchestrator could stop forwarding entirely and stay green.
    const saved: StreamState[] = [];
    const orchestrator = makeTestOrchestrator(
      {},
      {},
      makeFakeRecoveryStore({ save: (_id: string, state: StreamState) => saved.push(state) }),
    );

    orchestrator.startStream('live/one', MEDIA_TYPE_VIDEO);
    await sleep(20);

    assert.equal(orchestrator.handleSegmentLoss('live/one', 7, 1), true);
    orchestrator.handleSegment('live/one', 8, 2, Buffer.from('seg8'));
    await sleep(20);

    const withSegment = saved.filter((state) => state.segments.length > 0);
    assert.ok(withSegment.length > 0, 'a segment reached the manifest');
    assert.equal(
      withSegment[withSegment.length - 1].segments.find((s) => s.index === 8)?.discontinuity,
      true,
      'the segment after a lost one has to carry the marker, or players are told the gap is contiguous',
    );
  });

  it('answers false for a stream it does not have, rather than dropping the loss silently', () => {
    const orchestrator = makeTestOrchestrator();

    assert.equal(
      orchestrator.handleSegmentLoss('live/never-started', 0, 1),
      false,
      'the caller has to learn nothing recorded the gap, or it steps over indexes with no trace',
    );
  });

  it('does not count a loss as stream activity, so a stream losing everything still stalls', () => {
    const clock = new FakeClock();
    const orchestrator = makeTestOrchestrator({ clock, segmentStallMs: 1_000 });

    orchestrator.startStream('live/one', MEDIA_TYPE_VIDEO);
    clock.advance(5_000);
    orchestrator.handleSegmentLoss('live/one', 0, 1);

    assert.equal(
      orchestrator.getMsSinceStreamActivity(),
      5_000,
      'refreshing the activity clock on a loss would hide a dead stream behind its own losses',
    );
  });
});
