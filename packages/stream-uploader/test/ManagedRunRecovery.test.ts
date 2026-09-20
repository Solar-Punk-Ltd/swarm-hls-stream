import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  MANAGED_RUN_LOADED,
  MANAGED_RUN_MISSING,
  MANAGED_RUN_UNREADABLE,
  ManagedRunClaim,
  ManagedRunEntry,
  ManagedRunPersistence,
  ManagedRunRecord,
} from '../src/libs/ManagedRunStore.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { StreamUploader } from '../src/libs/StreamUploader.js';
import { MEDIA_TYPE_VIDEO, SourceConnectionIdentity } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import { makeTestOrchestrator } from './helpers/fakes.js';
import { FRAME_TICKS, videoSegment } from './helpers/transportStream.js';

const STREAM_ID = 'video/11111111-1111-4111-8111-111111111111';
const RECONNECT_MS = 60_000;
const WALL_START = 1_000_000;
const CLAIM: ManagedRunClaim = {
  lifecycleVersion: 1,
  streamId: STREAM_ID,
  adminStreamId: '22222222-2222-4222-8222-222222222222',
  topic: 'a'.repeat(64),
  mediaType: MEDIA_TYPE_VIDEO,
  revision: 8,
  runNumber: 2,
  uploaderId: 'srs-157-90-34-105',
  claimId: '44444444-4444-4444-8444-444444444444',
  eventSequence: 1,
};
const ADMIN = { id: CLAIM.adminStreamId, topic: CLAIM.topic };
const CLAIMANT = { address: '198.51.100.7', isAuthenticated: true };
const SOURCE_A: SourceConnectionIdentity = {
  serverId: 'server-a',
  serviceId: 'service-a',
  clientId: 'client-a',
  generation: 1,
};
const SOURCE_B: SourceConnectionIdentity = {
  serverId: 'server-a',
  serviceId: 'service-a',
  clientId: 'client-b',
  generation: 2,
};

class MemoryManagedRuns implements ManagedRunPersistence {
  public records = new Map<string, ManagedRunRecord>();
  public failState?: ManagedRunRecord['state'];

  public save(record: ManagedRunRecord): void {
    if (record.state === this.failState) {
      throw new Error(`injected ${record.state} save failure`);
    }
    this.records.set(record.streamId, structuredClone(record));
  }

  public read(streamId: string): ManagedRunEntry {
    const record = this.records.get(streamId);
    return record ? { kind: MANAGED_RUN_LOADED, record: structuredClone(record) } : { kind: MANAGED_RUN_MISSING };
  }

  public list(): string[] {
    return [...this.records.keys()];
  }
}

interface OrchestratorInternals {
  activeStreams: Map<string, StreamUploader>;
}

function activeUploader(orchestrator: StreamOrchestrator): StreamUploader | undefined {
  return (orchestrator as unknown as OrchestratorInternals).activeStreams.get(STREAM_ID);
}

function orchestrator(clock: FakeClock, wallNow: () => number, store: ManagedRunPersistence): StreamOrchestrator {
  return makeTestOrchestrator({
    clock,
    wallClock: wallNow,
    managedSourceReconnectMs: RECONNECT_MS,
    managedRunStore: store,
  });
}

function provision(target: StreamOrchestrator, source: SourceConnectionIdentity): boolean {
  return target.provisionManagedSource(STREAM_ID, MEDIA_TYPE_VIDEO, source, CLAIMANT, ADMIN);
}

function media(target: StreamOrchestrator, source: SourceConnectionIdentity, index = 0) {
  return target.handleManagedSegment(
    STREAM_ID,
    source,
    index,
    0.1,
    videoSegment(4, index * 4 * FRAME_TICKS),
  );
}

describe('managed run recovery', () => {
  it('does not admit a source until its claim is durably prepared', () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    store.failState = 'claimed';
    const target = orchestrator(clock, () => WALL_START + clock.now(), store);

    assert.equal(target.prepareManagedRun(CLAIM), false);
    assert.equal(provision(target, SOURCE_A), false);
    assert.equal(store.records.size, 0);
  });

  it('restores only the unused part of the original deadline', async () => {
    const firstClock = new FakeClock();
    const store = new MemoryManagedRuns();
    const first = orchestrator(firstClock, () => WALL_START + firstClock.now(), store);
    assert.equal(first.prepareManagedRun(CLAIM), true);
    assert.equal(provision(first, SOURCE_A), true);
    assert.deepEqual(media(first, SOURCE_A), { accepted: true });
    await firstClock.advance(30_000);

    const secondClock = new FakeClock();
    const second = orchestrator(secondClock, () => WALL_START + 30_000 + secondClock.now(), store);
    assert.equal(second.restoreManagedRun(STREAM_ID), MANAGED_RUN_LOADED);
    assert.equal(provision(second, SOURCE_B), false, 'the recovered incumbent admitted an overlap');

    await secondClock.advance(RECONNECT_MS / 2 - 1);
    assert.notEqual(store.records.get(STREAM_ID)?.state, 'closed');
    await secondClock.advance(1);
    assert.equal(store.records.get(STREAM_ID)?.state, 'closed', 'restart granted a fresh reconnect window');
    assert.equal(provision(second, SOURCE_B), false);
    await first.cleanup();
    await second.cleanup();
  });

  it('fails closed without finalizing when the closed marker cannot be persisted', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const target = orchestrator(clock, () => WALL_START + clock.now(), store);
    assert.equal(target.prepareManagedRun(CLAIM), true);
    assert.equal(provision(target, SOURCE_A), true);
    assert.deepEqual(media(target, SOURCE_A), { accepted: true });
    const uploader = activeUploader(target);
    assert.ok(uploader);
    const notifyStop = mock.method(uploader, 'notifyStop');
    assert.equal(target.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    store.failState = 'closed';

    await clock.advance(RECONNECT_MS);

    assert.equal(notifyStop.mock.callCount(), 0, 'finalization started before closed state was durable');
    assert.equal(store.records.get(STREAM_ID)?.state, 'waiting');
    assert.equal(provision(target, SOURCE_B), false, 'a failed closed save left admission open in memory');
    store.failState = undefined;
    await target.stopStream(STREAM_ID);
    assert.equal(store.records.get(STREAM_ID)?.state, 'closed', 'a later stop skipped the missing durable closure');
    await target.cleanup();
  });

  it('refuses callbacks when a known run is missing or unreadable', () => {
    const clock = new FakeClock();
    for (const kind of [MANAGED_RUN_MISSING, MANAGED_RUN_UNREADABLE] as const) {
      const store: ManagedRunPersistence = {
        save: () => undefined,
        read: () => ({ kind }),
        list: () => [STREAM_ID],
      };
      const target = orchestrator(clock, () => WALL_START, store);

      assert.equal(target.restoreManagedRun(STREAM_ID), kind);
      assert.equal(provision(target, SOURCE_A), false);
    }
  });

  it('expires a recovered run immediately after wall-clock rollback', () => {
    const firstClock = new FakeClock();
    const store = new MemoryManagedRuns();
    const first = orchestrator(firstClock, () => WALL_START, store);
    assert.equal(first.prepareManagedRun(CLAIM), true);

    const secondClock = new FakeClock();
    const second = orchestrator(secondClock, () => WALL_START - 1, store);
    assert.equal(second.restoreManagedRun(STREAM_ID), MANAGED_RUN_LOADED);
    assert.equal(store.records.get(STREAM_ID)?.state, 'closed');
    assert.equal(provision(second, SOURCE_A), false);
  });

  it('keeps a durable tombstone through a generic stop', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const target = orchestrator(clock, () => WALL_START + clock.now(), store);
    assert.equal(target.prepareManagedRun(CLAIM), true);
    assert.equal(provision(target, SOURCE_A), true);
    assert.deepEqual(media(target, SOURCE_A), { accepted: true });

    await target.stopStream(STREAM_ID);

    assert.equal(store.records.get(STREAM_ID)?.state, 'closed');
    assert.equal(provision(target, SOURCE_B), false, 'generic stop erased the managed closed permission');
    await target.cleanup();
  });
});
