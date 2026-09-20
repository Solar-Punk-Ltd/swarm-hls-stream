import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { AbrLadder } from '../src/libs/AbrLadder.js';
import {
  AdminApiClient,
  ManagedRunReport,
  STATE_REPORT_ACCEPTED,
  STATE_REPORT_FAILED,
  StateReportOutcome,
} from '../src/libs/AdminApiClient.js';
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
import { FakeUploads, makeTestOrchestrator, rejectImmediately } from './helpers/fakes.js';
import { FRAME_TICKS, videoSegment } from './helpers/transportStream.js';

const STREAM_ID = 'video/11111111-1111-4111-8111-111111111111';
const RUNG_ID = `${STREAM_ID}_360p`;
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

function activeUploader(orchestrator: StreamOrchestrator, streamId = STREAM_ID): StreamUploader | undefined {
  return (orchestrator as unknown as OrchestratorInternals).activeStreams.get(streamId);
}

function orchestrator(
  clock: FakeClock,
  wallNow: () => number,
  store: ManagedRunPersistence,
  adminApi?: AdminApiClient,
  uploads: FakeUploads = {},
): StreamOrchestrator {
  return makeTestOrchestrator({
    clock,
    wallClock: wallNow,
    managedSourceReconnectMs: RECONNECT_MS,
    managedRunStore: store,
    adminApi,
  }, uploads);
}

function reportingAdmin(
  reports: ManagedRunReport[],
  outcome: StateReportOutcome,
): AdminApiClient {
  return {
    reportManagedRun: async (_streamId: string, _runNumber: number, report: ManagedRunReport) => {
      reports.push(structuredClone(report));
      return outcome;
    },
  } as AdminApiClient;
}

async function settleReports(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
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
  it('reuses the durable request identity after a crash before the claim response', () => {
    const firstClock = new FakeClock();
    const store = new MemoryManagedRuns();
    const first = orchestrator(firstClock, () => WALL_START, store);
    const attempt = {
      lifecycleVersion: 1 as const,
      streamId: STREAM_ID,
      adminStreamId: CLAIM.adminStreamId,
      topic: CLAIM.topic,
      mediaType: CLAIM.mediaType,
      revision: 7,
      runNumber: CLAIM.runNumber,
      uploaderId: CLAIM.uploaderId,
    };

    const decision = first.beginManagedClaimAttempt(attempt);
    assert.match(decision?.requestId ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(decision?.needsClaim, true);

    const restarted = orchestrator(new FakeClock(), () => WALL_START + 1_000, store);
    const retry = restarted.beginManagedClaimAttempt(attempt);
    assert.equal(retry?.requestId, decision?.requestId);
    assert.equal(retry?.needsClaim, true);
    assert.equal(store.records.get(STREAM_ID)?.state, 'claiming');
    assert.equal(store.records.get(STREAM_ID)?.claimRequestId, decision?.requestId);
  });

  it('does not reclaim a run that this uploader already owns', () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const target = orchestrator(clock, () => WALL_START, store);
    assert.equal(target.prepareManagedRun(CLAIM), true);

    const decision = target.beginManagedClaimAttempt({
      lifecycleVersion: 1,
      streamId: STREAM_ID,
      adminStreamId: CLAIM.adminStreamId,
      topic: CLAIM.topic,
      mediaType: CLAIM.mediaType,
      revision: CLAIM.revision,
      runNumber: CLAIM.runNumber,
      uploaderId: CLAIM.uploaderId,
    });

    assert.equal(decision?.needsClaim, false);
    assert.equal(decision?.expectedRevision, CLAIM.revision);
  });

  it('does not erase the incumbent while checking an overlapping publish', () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const target = orchestrator(clock, () => WALL_START, store);
    assert.equal(target.prepareManagedRun(CLAIM), true);
    assert.equal(provision(target, SOURCE_A), true);

    const decision = target.beginManagedClaimAttempt({
      lifecycleVersion: 1,
      streamId: STREAM_ID,
      adminStreamId: CLAIM.adminStreamId,
      topic: CLAIM.topic,
      mediaType: CLAIM.mediaType,
      revision: CLAIM.revision,
      runNumber: CLAIM.runNumber,
      uploaderId: CLAIM.uploaderId,
    });

    assert.equal(decision?.needsClaim, false);
    assert.equal(provision(target, SOURCE_B), false);
    assert.deepEqual(media(target, SOURCE_A), { accepted: true });
  });

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
    await activeUploader(first)?.segmentQueue.onIdle();
    await settleReports();
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

  it('retries the exact durable report after restart', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const sent: ManagedRunReport[] = [];
    const first = orchestrator(
      clock,
      () => WALL_START + clock.now(),
      store,
      reportingAdmin(sent, STATE_REPORT_FAILED),
    );
    assert.equal(first.prepareManagedRun(CLAIM), true);
    assert.equal(provision(first, SOURCE_A), true);
    assert.deepEqual(media(first, SOURCE_A), { accepted: true });
    await settleReports();

    const pending = store.records.get(STREAM_ID)?.pendingReports[0];
    assert.equal(pending?.state, 'live');
    assert.equal(pending?.eventSequence, 2);

    const restarted = orchestrator(
      new FakeClock(),
      () => WALL_START + 1_000,
      store,
      reportingAdmin(sent, STATE_REPORT_ACCEPTED),
    );
    assert.equal(restarted.restoreManagedRun(STREAM_ID), MANAGED_RUN_LOADED);
    await settleReports();

    assert.deepEqual(sent, [pending, pending]);
    assert.deepEqual(store.records.get(STREAM_ID)?.pendingReports, []);
  });

  it('does not advertise live when the first segment upload fails', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const sent: ManagedRunReport[] = [];
    const target = orchestrator(
      clock,
      () => WALL_START + clock.now(),
      store,
      reportingAdmin(sent, STATE_REPORT_ACCEPTED),
      { uploadData: rejectImmediately },
    );
    assert.equal(target.prepareManagedRun(CLAIM), true);
    assert.equal(provision(target, SOURCE_A), true);
    assert.deepEqual(media(target, SOURCE_A), { accepted: true });
    await activeUploader(target)?.segmentQueue.onIdle();
    await settleReports();

    assert.equal(store.records.get(STREAM_ID)?.state, 'claimed');
    assert.deepEqual(sent, []);
  });

  it('refuses identity-free media while a managed run owns the stream', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const target = orchestrator(clock, () => WALL_START + clock.now(), store);
    assert.equal(target.prepareManagedRun(CLAIM), true);
    assert.equal(provision(target, SOURCE_A), true);
    assert.deepEqual(media(target, SOURCE_A), { accepted: true });
    const uploader = activeUploader(target);
    assert.ok(uploader);
    const queuedBefore = uploader.segmentQueue.size;

    const result = target.handleSegment(STREAM_ID, 1, 0.1, videoSegment(4, 4 * FRAME_TICKS));

    assert.equal(result.accepted, false);
    assert.equal(uploader.segmentQueue.size, queuedBefore);
    await target.cleanup();
  });

  it('keeps identity-free callbacks closed after restoring a managed run', () => {
    const store = new MemoryManagedRuns();
    const first = orchestrator(new FakeClock(), () => WALL_START, store);
    assert.equal(first.prepareManagedRun(CLAIM), true);
    assert.equal(provision(first, SOURCE_A), true);

    const restarted = orchestrator(new FakeClock(), () => WALL_START + 1_000, store);
    assert.equal(restarted.restoreManagedRun(STREAM_ID), MANAGED_RUN_LOADED);

    const result = restarted.handleSegment(STREAM_ID, 0, 0.1, videoSegment(4, 0));

    assert.equal(result.accepted, false);
  });

  it('returns waiting to live only after the reconnect source publishes', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const sent: ManagedRunReport[] = [];
    const target = orchestrator(
      clock,
      () => WALL_START + clock.now(),
      store,
      reportingAdmin(sent, STATE_REPORT_ACCEPTED),
    );
    assert.equal(target.prepareManagedRun(CLAIM), true);
    assert.equal(provision(target, SOURCE_A), true);
    assert.deepEqual(media(target, SOURCE_A), { accepted: true });
    await activeUploader(target)?.segmentQueue.onIdle();
    await settleReports();
    assert.equal(sent.findLast((report) => report.state === 'live')?.state, 'live');

    assert.equal(target.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    assert.equal(provision(target, SOURCE_B), true);
    assert.deepEqual(media(target, SOURCE_B, 1), { accepted: true });
    await activeUploader(target)?.segmentQueue.onIdle();
    await settleReports();

    assert.deepEqual(sent.slice(-2).map((report) => report.state), ['waiting', 'live']);
    assert.equal(store.records.get(STREAM_ID)?.source?.clientId, SOURCE_B.clientId);
  });

  it('does not let a delayed old-source manifest mark the reconnect live', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const sent: ManagedRunReport[] = [];
    let releaseA: (value: unknown) => void = () => undefined;
    let releaseB: (value: unknown) => void = () => undefined;
    const manifests = [
      new Promise((resolve) => { releaseA = resolve; }),
      new Promise((resolve) => { releaseB = resolve; }),
    ];
    let manifest = 0;
    const target = orchestrator(
      clock,
      () => WALL_START + clock.now(),
      store,
      reportingAdmin(sent, STATE_REPORT_ACCEPTED),
      { uploadPayload: async () => manifests[manifest++] },
    );
    assert.equal(target.prepareManagedRun(CLAIM), true);
    assert.equal(provision(target, SOURCE_A), true);
    assert.deepEqual(media(target, SOURCE_A), { accepted: true });
    await activeUploader(target)?.segmentQueue.onIdle();
    assert.equal(target.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    assert.equal(provision(target, SOURCE_B), true);
    assert.deepEqual(media(target, SOURCE_B, 1), { accepted: true });
    await activeUploader(target)?.segmentQueue.onIdle();

    releaseA({ reference: { toHex: () => 'manifest-a' } });
    await settleReports();
    assert.equal(sent.some((report) => report.state === 'live'), false);

    releaseB({ reference: { toHex: () => 'manifest-b' } });
    await settleReports();
    assert.equal(sent.findLast((report) => report.state === 'live')?.state, 'live');
  });

  it('keeps managed ABR rung uploaders through reconnect grace and finalizes them at cutoff', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const target = makeTestOrchestrator({
      clock,
      wallClock: () => WALL_START + clock.now(),
      managedSourceReconnectMs: RECONNECT_MS,
      managedRunStore: store,
      ladder: AbrLadder.parse('360p:640:360:700'),
    });
    assert.equal(target.prepareManagedRun(CLAIM), true);
    assert.equal(provision(target, SOURCE_A), true);
    assert.deepEqual(
      target.handleManagedSourceProgress(STREAM_ID, SOURCE_A, 0.1, videoSegment(4, 0)),
      { accepted: true },
    );
    assert.equal(
      target.provisionManagedRendition(RUNG_ID, STREAM_ID, SOURCE_A, MEDIA_TYPE_VIDEO, CLAIMANT, ADMIN),
      true,
    );
    assert.deepEqual(
      target.handleManagedRenditionSegment(RUNG_ID, STREAM_ID, SOURCE_A, 0, 0.1, videoSegment(4, 0)),
      { accepted: true },
    );
    const uploader = activeUploader(target, RUNG_ID);
    assert.ok(uploader);
    const notifyStop = mock.method(uploader, 'notifyStop');

    assert.equal(target.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    await clock.advance(30_000);
    await settleReports();
    assert.equal(notifyStop.mock.callCount(), 0, 'the generic rung reaper finalized inside reconnect grace');
    assert.equal(provision(target, SOURCE_B), true);
    assert.deepEqual(
      target.handleManagedSourceProgress(STREAM_ID, SOURCE_B, 0.1, videoSegment(4, 4 * FRAME_TICKS)),
      { accepted: true },
    );
    assert.equal(
      target.provisionManagedRendition(RUNG_ID, STREAM_ID, SOURCE_B, MEDIA_TYPE_VIDEO, CLAIMANT, ADMIN),
      true,
    );
    assert.equal(activeUploader(target, RUNG_ID), uploader);
    assert.deepEqual(
      target.handleManagedRenditionSegment(RUNG_ID, STREAM_ID, SOURCE_B, 0, 0.1, videoSegment(4, 4 * FRAME_TICKS)),
      { accepted: true },
    );
    assert.equal(notifyStop.mock.callCount(), 0);

    await clock.advance(RECONNECT_MS);
    await settleReports();

    assert.equal(store.records.get(STREAM_ID)?.state, 'closed');
    assert.equal(notifyStop.mock.callCount(), 1);
  });

  it('heartbeats without extending the source media deadline', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const sent: ManagedRunReport[] = [];
    const target = orchestrator(
      clock,
      () => WALL_START + clock.now(),
      store,
      reportingAdmin(sent, STATE_REPORT_ACCEPTED),
    );
    assert.equal(target.prepareManagedRun(CLAIM), true);
    assert.equal(provision(target, SOURCE_A), true);
    assert.deepEqual(media(target, SOURCE_A), { accepted: true });
    await settleReports();
    const mediaDeadline = store.records.get(STREAM_ID)?.deadlineWallMs;

    await clock.advance(10_000);
    await settleReports();
    assert.deepEqual(
      sent.slice(0, 2).map((report) => [report.state, report.eventSequence]),
      [
        ['live', 2],
        ['live', 3],
      ],
    );
    assert.equal(store.records.get(STREAM_ID)?.deadlineWallMs, mediaDeadline);

    assert.equal(target.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    await settleReports();
    const waiting = sent.findLast((report) => report.state === 'waiting');
    assert.equal(waiting?.state, 'waiting');
    if (waiting?.state === 'waiting') {
      assert.equal(waiting.reconnectDeadline, new Date(mediaDeadline as number).toISOString());
    }

    await clock.advance(50_000);
    assert.equal(store.records.get(STREAM_ID)?.state, 'closed', 'heartbeats renewed the source cutoff');
  });

  it('disconnects the attached source only after the deadline closure is durable', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const disconnected: SourceConnectionIdentity[] = [];
    const target = orchestrator(clock, () => WALL_START + clock.now(), store);
    target.registerManagedSourceDisconnector((identity) => disconnected.push(identity));
    assert.equal(target.prepareManagedRun(CLAIM), true);
    assert.equal(provision(target, SOURCE_A), true);
    assert.deepEqual(media(target, SOURCE_A), { accepted: true });

    await clock.advance(RECONNECT_MS);

    assert.equal(store.records.get(STREAM_ID)?.state, 'closed');
    assert.deepEqual(disconnected, [SOURCE_A]);
    await target.cleanup();
  });

  it('retries a durable closed report after the admin recovers without a restart', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const sent: ManagedRunReport[] = [];
    let online = false;
    const admin = {
      reportManagedRun: async (_streamId: string, _runNumber: number, report: ManagedRunReport) => {
        sent.push(structuredClone(report));
        return online ? STATE_REPORT_ACCEPTED : STATE_REPORT_FAILED;
      },
    } as AdminApiClient;
    const target = orchestrator(clock, () => WALL_START + clock.now(), store, admin);
    assert.equal(target.prepareManagedRun(CLAIM), true);
    assert.equal(provision(target, SOURCE_A), true);
    assert.deepEqual(media(target, SOURCE_A), { accepted: true });
    await activeUploader(target)?.segmentQueue.onIdle();
    await settleReports();
    assert.equal(target.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);

    await clock.advance(RECONNECT_MS);
    await settleReports();
    assert.equal(store.records.get(STREAM_ID)?.state, 'closed');
    assert.equal(store.records.get(STREAM_ID)?.pendingReports.some((report) => report.state === 'closed'), true);

    online = true;
    await clock.advance(MANAGED_REPORT_RETRY_MS);
    await settleReports();
    assert.equal(sent.some((report) => report.state === 'closed'), true);
    assert.deepEqual(store.records.get(STREAM_ID)?.pendingReports, []);
  });
});

const MANAGED_REPORT_RETRY_MS = 10_000;
