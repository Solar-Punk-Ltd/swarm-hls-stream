import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { RecoveryStore } from '../src/libs/RecoveryStore.js';
import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { MEDIA_TYPE_VIDEO, STREAM_STATUS_VOD, StreamState, StreamStatus } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import {
  makeFakeRecoveryStore,
  makeRecordingCatalog,
  makeRecoveredState,
  makeTestOrchestrator,
  toRecoveryFileId,
} from './helpers/fakes.js';
import { waitAndConfirmNothingHappened, waitFor } from './helpers/waiting.js';

const RECOVERY_TIMEOUT_MS = 80;
/**
 * A ceiling on a hung wait, not a measurement of how long anything here takes. The budgets it replaces
 * read as generous and were not: at eight concurrent suites a finalize that normally lands in 90ms
 * took longer than 480ms, and a wait that expired quietly let the assertion after it report a correct
 * orchestrator as broken. A satisfied wait returns at the poll it is satisfied on, so raising this
 * costs nothing on the passing path.
 */
const SETTLE_CEILING_MS = 4_000;

function makeOrchestrator(recovery: RecoveryStore = makeFakeRecoveryStore(), clock?: FakeClock): StreamOrchestrator {
  return makeTestOrchestrator({ recoveryTimeout: RECOVERY_TIMEOUT_MS, clock }, {}, recovery);
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

    await waitFor(() => orch.getActiveStreamCount() === 0, SETTLE_CEILING_MS);
    assert.equal(orch.getActiveStreamCount(), 0, 'an unfed recovered stream is finalized by the recovery timer');
  });

  it('keeps a recovered stream alive when segments resume before on_publish (cancels the finalize timer)', async () => {
    const id = 'live/stream';
    const clock = new FakeClock();
    const orch = makeOrchestrator(
      makeFakeRecoveryStore({ listActive: () => [toRecoveryFileId(id)], load: () => makeRecoveredState(id) }),
      clock,
    );

    await orch.recoverStreams();
    assert.equal(clock.pendingCount(), 1, 'the recovered stream waits on a finalize timer');

    const result = orch.handleSegment(id, 7, 2, Buffer.from('seg7'));
    assert.equal(result.accepted, true, 'segments for a recovered stream must be accepted');
    assert.equal(clock.pendingCount(), 0, 'and resuming cancels that timer rather than racing it');

    await clock.advance(RECOVERY_TIMEOUT_MS * 3);
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

describe('StreamOrchestrator per-stream bookkeeping', () => {
  /** Reaches the maps directly, because a retained entry has no behavioural signal to observe. */
  interface OrchestratorMaps {
    processedSegments: Map<string, Set<number>>;
    streamActivityAt: Map<string, number>;
  }

  // A stopped stream leaves nothing behind. The per-stream duplicate filter holds one index per
  // segment the broadcast ever delivered, so a long-running uploader that has served many streams
  // keeps every one of those sets alive for the life of the process.
  it('drops its per-stream entries when a stream stops', async () => {
    const id = 'live/stream';
    const orch = makeOrchestrator();
    const maps = orch as unknown as OrchestratorMaps;

    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    orch.handleSegment(id, 0, 2, Buffer.from('one'));
    assert.equal(maps.processedSegments.has(id), true, 'the stream must be tracked before the stop means anything');

    await orch.stopStream(id);

    assert.equal(maps.processedSegments.has(id), false, 'the duplicate filter outlived the stream it belonged to');
    assert.equal(maps.streamActivityAt.has(id), false, 'the activity reading outlived the stream it belonged to');
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

  it('registers every session before it returns, so a reconnect is addressable in its own tick', async () => {
    const id = 'live/stream';
    const published: unknown[] = [];
    const orch = startedOrchestrator(published, []);

    // Three announces, each fed in the same tick it arrives. CON-1's own account of this race is wrong
    // and the correction is what this test pins: p-queue 8 runs the first job inside `add()`, so two
    // announces never did both take the fresh-stream path. The window opens on the second one, which
    // retires the live session and queues its replacement, and that queued write is deferred. Between
    // there and the microtask that ran it, `activeStreams` held nothing for a stream mid-broadcast, so
    // a segment was refused as an unknown stream and a third announce found the id free and started
    // yet another session over the top of the pending one, which was then never retired or finalized.
    for (const index of [0, 1, 2]) {
      assert.equal(orch.startStream(id, MEDIA_TYPE_VIDEO), true, `announce ${index} is accepted`);
      assert.deepEqual(
        orch.handleSegment(id, index, 2, Buffer.from(`seg${index}`)),
        { accepted: true },
        `the segment after announce ${index} reaches the session that announce just started`,
      );
    }

    // Two retirements, so two VODs. A session that is overwritten rather than retired publishes
    // nothing, which is how the loss shows up.
    await waitFor(
      () => published.filter((entry) => (entry as PublishedEntry).state === STREAM_STATUS_VOD).length >= 2,
      SETTLE_CEILING_MS,
    );

    assert.equal(orch.getActiveStreamCount(), 1, 'exactly one session holds the id at the end');
    await orch.cleanup();
  });

  it('accepts a re-announced already-active stream and restarts it instead of rejecting', async () => {
    const id = 'live/stream';
    const published: unknown[] = [];
    const removed: string[] = [];
    const orch = startedOrchestrator(published, removed);

    assert.equal(orch.startStream(id, MEDIA_TYPE_VIDEO), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    assert.equal(orch.getActiveStreamCount(), 1, 'first publish starts the stream');
    // Content, so finalizing the stale session is observable as the VOD it publishes. Recovery-entry
    // removal cannot serve as that signal any more: the id belongs to the live session by then.
    orch.handleSegment(id, 0, 2, Buffer.from('one'));

    // Previously this returned false → SRS rejected the broadcaster. It must now be accepted.
    assert.equal(orch.startStream(id, MEDIA_TYPE_VIDEO), true, 're-announce of an active stream must be accepted');

    await waitFor(
      () => published.some((entry) => (entry as PublishedEntry).state === STREAM_STATUS_VOD),
      SETTLE_CEILING_MS,
    );
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
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    orch.handleSegment(id, 0, 2, Buffer.from('one'));
    await waitFor(() => saved.length > 0, SETTLE_CEILING_MS);

    // Each uploader owns a freshly generated feed topic, so the topic is what tells the outgoing
    // session's recovery writes apart from the live one's.
    const retiredTopic = saved[saved.length - 1].streamRawTopic;
    const writesBeforeRetirement = saved.length;

    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(
      () => published.some((entry) => (entry as PublishedEntry).state === STREAM_STATUS_VOD),
      SETTLE_CEILING_MS,
    );
    // Without this the rest holds vacuously: a build that never finalizes the replaced session at all
    // also never touches the entry, and both assertions below would pass on that.
    assert.ok(
      published.some((entry) => (entry as PublishedEntry).state === STREAM_STATUS_VOD),
      'the replaced session was never finalized, so nothing here has been exercised',
    );
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    orch.handleSegment(id, 0, 2, Buffer.from('two'));
    await waitFor(() => saved.length > writesBeforeRetirement, SETTLE_CEILING_MS);

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

  // The core of the failure, at the layer it belongs to. A re-announced session must get its own
  // duplicate filter: the outgoing one holds every index the previous broadcast delivered, and the
  // restarted origin numbers from its own beginning, so sharing it means the new session's opening
  // segments come back accepted and are never uploaded. Accepted-as-duplicate is indistinguishable
  // from accepted-and-published to everything upstream, which is why this went unseen.
  it('accepts the new session at an index the outgoing one had already delivered', async () => {
    const id = 'live/stream';
    const orch = makeOrchestrator();

    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    assert.deepEqual(
      orch.handleSegment(id, 0, 2, Buffer.from('one')),
      { accepted: true },
      'the outgoing session must deliver index 0 before a re-announce means anything',
    );
    assert.deepEqual(
      orch.handleSegment(id, 0, 2, Buffer.from('one again')),
      { accepted: true },
      'a replay of a delivered index is accepted silently, which is what the next assertion has to out-rank',
    );

    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    orch.handleSegment(id, 0, 2, Buffer.from('restarted'));

    assert.equal(
      (orch as unknown as { processedSegments: Map<string, Set<number>> }).processedSegments.get(id)?.size,
      1,
      'the new session inherited the outgoing filter, so its own index 0 was swallowed as a duplicate',
    );
    await orch.cleanup();
  });

  // The replacement has to be registered before the finalize rather than after it. Deferring it
  // looks like it only costs latency and does not: a close arriving inside that window finds no
  // uploader to drain, and the deferred spawn then registers one after the close, live for the rest
  // of the process with nothing left to stop it and a catalog entry that never becomes a VOD.
  it('leaves nothing running when a close arrives while the replaced session is finalizing', async () => {
    const id = 'live/stream';
    const finalizing: string[] = [];
    const orch = makeTestOrchestrator({ recoveryTimeout: RECOVERY_TIMEOUT_MS }, {}, makeFakeRecoveryStore(), {
      addStream: async () => {
        finalizing.push('vod');
        await sleep(60);
      },
    } as unknown as StreamCatalog);

    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    orch.handleSegment(id, 0, 2, Buffer.from('one'));

    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => finalizing.length > 0, SETTLE_CEILING_MS);
    await orch.stopStream(id);
    // Long enough that a spawn deferred behind the finalize would have landed by now.
    await sleep(150);

    assert.equal(
      orch.getActiveStreamCount(),
      0,
      'a stream survived its own close, so nothing will ever finalize it or move it off live',
    );
    await orch.cleanup();
  });

  // Finalizing the outgoing session must not borrow the machinery that hides a stopping stream from
  // the stall signal, because the id it would hide belongs to the live one by then. A whole finalize
  // window, up to the five minute drain timeout, in which a broadcaster that goes quiet reports
  // nothing at all. This is the shape every round of review here keeps finding: a fix whose safety
  // rests on a signal staying live, with nothing holding it there.
  it('leaves the replacement visible to the stall signal while the outgoing session finalizes', async () => {
    const id = 'live/stream';
    const finalizing: string[] = [];
    const orch = makeTestOrchestrator({ recoveryTimeout: RECOVERY_TIMEOUT_MS }, {}, makeFakeRecoveryStore(), {
      addStream: async () => {
        finalizing.push('vod');
        await sleep(60);
      },
    } as unknown as StreamCatalog);

    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    orch.handleSegment(id, 0, 2, Buffer.from('one'));

    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => finalizing.length > 0 && orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);

    assert.notEqual(
      orch.getMsSinceStreamActivity(),
      null,
      'the live stream is unreadable to the stall signal for as long as the replaced one takes to finalize',
    );
    await orch.cleanup();
  });

  // Two stops for one stream, close enough together that the second starts before the first has
  // finished. Every caller in the engines fires and forgets, and two of them sit next to each other on
  // the same id: a puller that halts calls this, and the closing OME sends afterwards calls it again.
  // A second drain finds the uploader still registered, because the first has not retired it yet, and
  // finalizes it a second time. The stream is not lost, it is published twice, and a viewer reading the
  // list sees the same broadcast under two entries with nothing to say which is real. See CON-22.
  it('finalizes a stream once when a second stop lands inside the first drain', async () => {
    const id = 'live/stream';
    const published: { state?: StreamStatus }[] = [];
    const orch = makeTestOrchestrator(
      { recoveryTimeout: RECOVERY_TIMEOUT_MS },
      {},
      makeFakeRecoveryStore(),
      makeRecordingCatalog(published),
    );

    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    orch.handleSegment(id, 0, 2, Buffer.from('one'));

    await Promise.all([orch.stopStream(id), orch.stopStream(id)]);

    assert.equal(
      published.filter((entry) => entry.state === STREAM_STATUS_VOD).length,
      1,
      'one broadcast was published as two VODs, because both stops drained the same uploader',
    );
    await orch.cleanup();
  });

  // The other side of coalescing two stops, and the expensive one. A drain in flight belongs to one
  // uploader, not to the stream id, and those stop being the same thing the moment a reconnect
  // registers a replacement under that id. Answering the replacement's own stop with the outgoing
  // session's drain never finalizes the replacement: its catalog entry stays live for a broadcast that
  // ended, it holds the id in `activeStreams` with no puller, and the stall signal reports it forever.
  // Only a process restart rescues it, at the recovery timeout, off the recovery store.
  it('drains the replacement when its own stop lands inside the outgoing session drain', async () => {
    const id = 'live/stream';
    const finalizeStarted: string[] = [];
    const published: { state?: StreamStatus; topic?: string }[] = [];
    const orch = makeTestOrchestrator({ recoveryTimeout: RECOVERY_TIMEOUT_MS }, {}, makeFakeRecoveryStore(), {
      addStream: async (entry: unknown) => {
        finalizeStarted.push('vod');
        // Long enough that the reconnect and its own close both land inside this drain, which is the
        // whole scenario. A real one has the same shape for as long as a Bee that is answering slowly
        // holds the VOD commit, up to the drain deadline.
        await sleep(60);
        published.push(entry as { state?: StreamStatus; topic?: string });
      },
    } as unknown as StreamCatalog);

    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    orch.handleSegment(id, 0, 2, Buffer.from('outgoing'));

    // The outgoing session's close. Fire and forget, the way every engine caller sends it.
    const stoppingOutgoing = orch.stopStream(id);
    await waitFor(() => finalizeStarted.length > 0, SETTLE_CEILING_MS);

    // The reconnect, inside that drain, followed by its own close.
    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    orch.handleSegment(id, 0, 2, Buffer.from('reconnected'));
    await orch.stopStream(id);
    await stoppingOutgoing;

    assert.equal(
      orch.getActiveStreamCount(),
      0,
      'the replacement was answered with the outgoing session’s drain, so nothing ever finalized it',
    );
    assert.equal(
      orch.handleSegment(id, 0, 2, Buffer.from('after')).accepted,
      false,
      'a session that was told to stop still accepts segments, which is what an undrained uploader looks like from outside',
    );
    // Counted by feed topic rather than by entry, because the outgoing session is finalized twice here
    // for a reason that predates this and is not what the test is about: a re-announce inside a drain
    // runs `finalizeRetiredSession` alongside the `performDrain` already in flight. Each uploader owns
    // its own topic, and the real catalog keys on `(owner, topic)`, so the duplicate replaces rather
    // than adds and only the distinct count says whether both broadcasts were actually published.
    const vodTopics = new Set(
      published.filter((entry) => entry.state === STREAM_STATUS_VOD).map((entry) => entry.topic),
    );
    assert.equal(vodTopics.size, 2, 'two broadcasts ended and only one of them was ever published');
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
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    orch.handleSegment(id, 0, 2, Buffer.from('one'));

    // The disconnect. Deliberately not awaited: every caller in the engines fires it and moves on.
    const stopping = orch.stopStream(id);
    await waitFor(() => finalizeStarted.length > 0, SETTLE_CEILING_MS);

    // The reconnect, while that drain is still running.
    orch.startStream(id, MEDIA_TYPE_VIDEO);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
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
    await waitFor(() => orch.getActiveStreamCount() === 0, SETTLE_CEILING_MS);

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
    await waitAndConfirmNothingHappened(() => catalogEntries.length === 0, 200);

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
