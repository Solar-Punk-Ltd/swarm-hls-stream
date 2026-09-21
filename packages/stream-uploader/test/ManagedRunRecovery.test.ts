import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';

import { AbrLadder } from '../src/libs/AbrLadder.js';
import {
  AdminApiClient,
  ManagedRunReport,
  STATE_REPORT_ACCEPTED,
  STATE_REPORT_FAILED,
  StateReportOutcome,
} from '../src/libs/AdminApiClient.js';
import { LadderIdentity, LadderRegistry } from '../src/libs/LadderRegistry.js';
import { ManagedCheckpointPersistence, ManagedCheckpointStore } from '../src/libs/ManagedCheckpointStore.js';
import { ManagedMediaStore } from '../src/libs/ManagedMediaStore.js';
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
import { MEDIA_TYPE_VIDEO, Rendition, SourceConnectionIdentity } from '../src/types.js';
import { rungTopicFor } from '../src/utils/rungTopic.js';

import { FakeClock } from './helpers/fakeClock.js';
import {
  FakeUploads,
  makeFakeRecoveryStore,
  makeRecoveredState,
  makeTestOrchestrator,
  rejectImmediately,
} from './helpers/fakes.js';
import { MemoryManagedCheckpoints } from './helpers/managedCheckpoint.js';
import { FRAME_TICKS, videoSegment } from './helpers/transportStream.js';

/** `Array.prototype.findLast` is only declared from lib ES2023, and this package targets ES2020. */
function lastMatching<T>(items: readonly T[], matches: (item: T) => boolean): T | undefined {
  return [...items].reverse().find(matches);
}

const STREAM_ID = 'video/11111111-1111-4111-8111-111111111111';
const RUNG_ID = `${STREAM_ID}_360p`;
const RECONNECT_MS = 60_000;
const WALL_START = 1_000_000;
const CLAIM_ID = '44444444-4444-4444-8444-444444444444';
const CLAIM: ManagedRunClaim = {
  lifecycleVersion: 1,
  streamId: STREAM_ID,
  adminStreamId: '22222222-2222-4222-8222-222222222222',
  topic: 'a'.repeat(64),
  mediaType: MEDIA_TYPE_VIDEO,
  revision: 8,
  runNumber: 2,
  uploaderId: 'srs-157-90-34-105',
  claimId: CLAIM_ID,
  eventSequence: 1,
  expectedRenditions: [],
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
  public failClosedSaves = 0;
  public failVodSaves = 0;

  public save(record: ManagedRunRecord): void {
    if (record.state === 'closed' && this.failClosedSaves > 0) {
      this.failClosedSaves -= 1;
      throw new Error('injected closed save failure');
    }
    if (record.state === 'vod' && this.failVodSaves > 0) {
      this.failVodSaves -= 1;
      throw new Error('injected vod save failure');
    }
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
  managedSources: Map<string, unknown>;
}

const checkpointsByRunStore = new WeakMap<ManagedRunPersistence, MemoryManagedCheckpoints>();

function activeUploader(orchestrator: StreamOrchestrator, streamId = STREAM_ID): StreamUploader | undefined {
  return (orchestrator as unknown as OrchestratorInternals).activeStreams.get(streamId);
}

function orchestrator(
  clock: FakeClock,
  wallNow: () => number,
  store: ManagedRunPersistence,
  adminApi?: AdminApiClient,
  uploads: FakeUploads = {},
  checkpoints?: MemoryManagedCheckpoints,
): StreamOrchestrator {
  let managedCheckpointStore = checkpointsByRunStore.get(store);
  if (checkpoints) {
    managedCheckpointStore = checkpoints;
    checkpointsByRunStore.set(store, checkpoints);
  } else if (!managedCheckpointStore) {
    managedCheckpointStore = new MemoryManagedCheckpoints();
    checkpointsByRunStore.set(store, managedCheckpointStore);
  }
  return makeTestOrchestrator(
    {
      clock,
      wallClock: wallNow,
      managedSourceReconnectMs: RECONNECT_MS,
      managedRunStore: store,
      managedCheckpointStore,
      adminApi,
    },
    uploads,
  );
}

function reportingAdmin(reports: ManagedRunReport[], outcome: StateReportOutcome): AdminApiClient {
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition did not settle');
}

function provision(target: StreamOrchestrator, source: SourceConnectionIdentity): boolean {
  return target.provisionManagedSource(STREAM_ID, MEDIA_TYPE_VIDEO, source, CLAIMANT, ADMIN);
}

function media(target: StreamOrchestrator, source: SourceConnectionIdentity, index = 0) {
  return target.handleManagedSegment(STREAM_ID, source, index, 0.1, videoSegment(4, index * 4 * FRAME_TICKS));
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
      expectedRenditions: CLAIM.expectedRenditions,
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

  it('binds a delayed claim response without extending the original deadline', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const target = orchestrator(clock, () => WALL_START + clock.now(), store);
    const attempt = {
      lifecycleVersion: 1 as const,
      streamId: STREAM_ID,
      adminStreamId: CLAIM.adminStreamId,
      topic: CLAIM.topic,
      mediaType: CLAIM.mediaType,
      revision: 7,
      runNumber: CLAIM.runNumber,
      uploaderId: CLAIM.uploaderId,
      expectedRenditions: CLAIM.expectedRenditions,
    };
    assert.equal(target.beginManagedClaimAttempt(attempt)?.needsClaim, true);
    await clock.advance(30_000);

    assert.equal(
      target.completeManagedClaim(STREAM_ID, {
        lifecycleVersion: 1,
        streamId: CLAIM.adminStreamId,
        revision: 8,
        runNumber: CLAIM.runNumber,
        uploaderId: CLAIM.uploaderId,
        claimId: CLAIM_ID,
        expectedRenditions: CLAIM.expectedRenditions,
        state: 'claimed',
        permission: 'claimed',
      }),
      true,
    );
    assert.equal(store.records.get(STREAM_ID)?.deadlineWallMs, WALL_START + RECONNECT_MS);
    assert.equal(store.records.get(STREAM_ID)?.deadlineRemainingMs, 30_000);
    assert.equal(provision(target, SOURCE_A), true);

    await clock.advance(30_000);
    assert.equal(store.records.get(STREAM_ID)?.state, 'closed');
  });

  it('closes an expired preclaim when its response is reconciled after restart', () => {
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
      expectedRenditions: CLAIM.expectedRenditions,
    };
    const original = first.beginManagedClaimAttempt(attempt);

    const restarted = orchestrator(new FakeClock(), () => WALL_START + 70_000, store);
    assert.equal(restarted.beginManagedClaimAttempt(attempt)?.requestId, original?.requestId);
    assert.equal(
      restarted.completeManagedClaim(STREAM_ID, {
        lifecycleVersion: 1,
        streamId: CLAIM.adminStreamId,
        revision: 8,
        runNumber: CLAIM.runNumber,
        uploaderId: CLAIM.uploaderId,
        claimId: CLAIM_ID,
        expectedRenditions: CLAIM.expectedRenditions,
        state: 'claimed',
        permission: 'claimed',
      }),
      false,
    );
    assert.equal(store.records.get(STREAM_ID)?.state, 'closed');
    assert.equal(provision(restarted, SOURCE_A), false);
  });

  it('does not let an old report acknowledgement overwrite a replacement run', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    let releaseReport!: (outcome: StateReportOutcome) => void;
    let markReportStarted!: () => void;
    const reportStarted = new Promise<void>((resolve) => {
      markReportStarted = resolve;
    });
    const reportResult = new Promise<StateReportOutcome>((resolve) => {
      releaseReport = resolve;
    });
    const admin = {
      reportManagedRun: async () => {
        markReportStarted();
        return reportResult;
      },
    } as unknown as AdminApiClient;
    const target = orchestrator(clock, () => WALL_START + clock.now(), store, admin);
    assert.equal(target.prepareManagedRun(CLAIM), true);
    assert.equal(provision(target, SOURCE_A), true);
    assert.deepEqual(media(target, SOURCE_A), { accepted: true });
    await activeUploader(target)?.segmentQueue.onIdle();
    await reportStarted;

    const replacement: ManagedRunRecord = {
      ...store.records.get(STREAM_ID)!,
      runNumber: 3,
      revision: 20,
      eventSequence: 0,
      state: 'claimed',
      pendingReports: [],
    };
    store.save(replacement);
    (target as unknown as OrchestratorInternals).managedSources.set(STREAM_ID, {
      record: replacement,
      mediatype: replacement.mediaType,
      deadline: clock.now() + RECONNECT_MS,
    });

    releaseReport(STATE_REPORT_ACCEPTED);
    await settleReports();

    assert.equal(store.records.get(STREAM_ID)?.runNumber, 3);
    assert.equal(store.records.get(STREAM_ID)?.eventSequence, 0);
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
      expectedRenditions: CLAIM.expectedRenditions,
    });

    assert.equal(decision?.needsClaim, false);
    assert.equal(decision?.expectedRevision, CLAIM.revision);
  });

  it('admits only prepared cumulative successor runs in the same and a fresh process', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-successor-admission-'));
    const clock = new FakeClock();
    const runs = new MemoryManagedRuns();
    const checkpoints = new ManagedCheckpointStore(path.join(root, 'checkpoints'));
    const mediaStore = new ManagedMediaStore(path.join(root, 'media'));
    const sent: ManagedRunReport[] = [];
    const uploads = {
      uploadData: async () => ({ reference: { toHex: () => 'a'.repeat(64) } }),
      uploadPayload: async (index: number) => ({
        reference: { toHex: () => String(index + 1).padStart(64, '0') },
      }),
    };
    const first = makeTestOrchestrator(
      {
        clock,
        wallClock: () => WALL_START + clock.now(),
        managedSourceReconnectMs: RECONNECT_MS,
        managedRunStore: runs,
        managedCheckpointStore: checkpoints,
        managedMediaStore: mediaStore,
        adminApi: reportingAdmin(sent, STATE_REPORT_ACCEPTED),
      },
      uploads,
    );
    const successor = (runNumber: number, revision: number) => ({
      lifecycleVersion: 1 as const,
      streamId: STREAM_ID,
      adminStreamId: CLAIM.adminStreamId,
      topic: CLAIM.topic,
      mediaType: CLAIM.mediaType,
      revision,
      runNumber,
      uploaderId: CLAIM.uploaderId,
      expectedRenditions: CLAIM.expectedRenditions,
    });

    try {
      assert.equal(first.prepareManagedRun(CLAIM), true);
      assert.equal(provision(first, SOURCE_A), true);
      assert.deepEqual(media(first, SOURCE_A), { accepted: true });
      await activeUploader(first)!.segmentQueue.onIdle();
      await clock.advance(RECONNECT_MS);
      await waitFor(() => runs.records.get(STREAM_ID)?.state === 'vod');
      await waitFor(() => runs.records.get(STREAM_ID)?.pendingReports.length === 0);
      await waitFor(() => activeUploader(first) === undefined);

      const recordingA = checkpoints.findRun(CLAIM.adminStreamId, CLAIM.runNumber)?.completedRecording;
      assert.ok(recordingA);
      const attemptB = successor(CLAIM.runNumber + 1, 21);
      assert.equal(first.beginManagedClaimAttempt(attemptB), null);
      const preparedB = checkpoints.prepare({
        lifecycleVersion: 1,
        operationId: '55555555-5555-4555-8555-555555555555',
        requestId: '66666666-6666-4666-8666-666666666666',
        streamId: CLAIM.adminStreamId,
        topic: CLAIM.topic,
        mediaType: CLAIM.mediaType,
        uploaderId: CLAIM.uploaderId,
        previousRunNumber: CLAIM.runNumber,
        nextRunNumber: CLAIM.runNumber + 1,
        revision: 20,
        status: 'pending',
        retainedRecording: recordingA,
      });
      const decisionB = first.beginManagedClaimAttempt(attemptB);
      assert.equal(decisionB?.needsClaim, true);
      assert.equal(runs.records.get(STREAM_ID)?.runNumber, attemptB.runNumber);
      assert.equal(runs.records.get(STREAM_ID)?.checkpointReference, preparedB.checkpointReference);
      assert.deepEqual(media(first, SOURCE_A, 1), { accepted: false, reason: 'stale_source' });
      assert.equal(
        first.completeManagedClaim(STREAM_ID, {
          lifecycleVersion: 1,
          streamId: CLAIM.adminStreamId,
          revision: 22,
          runNumber: attemptB.runNumber,
          uploaderId: CLAIM.uploaderId,
          claimId: '77777777-7777-4777-8777-777777777777',
          expectedRenditions: CLAIM.expectedRenditions,
          state: 'claimed',
          permission: 'claimed',
        }),
        true,
      );
      assert.equal(provision(first, SOURCE_B), true);
      assert.deepEqual(media(first, SOURCE_A, 1), { accepted: false, reason: 'stale_source' });
      assert.deepEqual(media(first, SOURCE_B), { accepted: true });
      await activeUploader(first)!.segmentQueue.onIdle();
      await clock.advance(RECONNECT_MS);
      await waitFor(() => runs.records.get(STREAM_ID)?.state === 'vod');
      await waitFor(() => runs.records.get(STREAM_ID)?.pendingReports.length === 0);
      await waitFor(() => activeUploader(first) === undefined);

      const recordingB = checkpoints.findRun(CLAIM.adminStreamId, attemptB.runNumber)?.completedRecording;
      assert.ok(recordingB);
      assert.equal(checkpoints.findRun(CLAIM.adminStreamId, attemptB.runNumber)?.tracks[0]?.state.segments.length, 2);
      await first.cleanup();

      const restarted = makeTestOrchestrator(
        {
          clock: new FakeClock(),
          wallClock: () => WALL_START + clock.now() + 1_000,
          managedSourceReconnectMs: RECONNECT_MS,
          managedRunStore: runs,
          managedCheckpointStore: checkpoints,
          managedMediaStore: mediaStore,
          adminApi: reportingAdmin(sent, STATE_REPORT_ACCEPTED),
        },
        uploads,
      );
      restarted.restoreManagedRuns();
      const preparedC = checkpoints.prepare({
        lifecycleVersion: 1,
        operationId: '88888888-8888-4888-8888-888888888888',
        requestId: '99999999-9999-4999-8999-999999999999',
        streamId: CLAIM.adminStreamId,
        topic: CLAIM.topic,
        mediaType: CLAIM.mediaType,
        uploaderId: CLAIM.uploaderId,
        previousRunNumber: attemptB.runNumber,
        nextRunNumber: attemptB.runNumber + 2,
        revision: 30,
        status: 'pending',
        retainedRecording: recordingB,
      });
      const attemptC = successor(attemptB.runNumber + 2, 31);
      const decisionC = restarted.beginManagedClaimAttempt(attemptC);
      assert.equal(decisionC?.needsClaim, true);
      assert.equal(runs.records.get(STREAM_ID)?.runNumber, attemptC.runNumber);
      assert.equal(runs.records.get(STREAM_ID)?.checkpointReference, preparedC.checkpointReference);
      assert.equal(checkpoints.findRun(CLAIM.adminStreamId, CLAIM.runNumber)?.status, 'complete');
      assert.equal(checkpoints.findRun(CLAIM.adminStreamId, attemptB.runNumber)?.status, 'complete');
      await restarted.cleanup();
    } finally {
      await first.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
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
      expectedRenditions: CLAIM.expectedRenditions,
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

  it('does not admit a run whose checkpoint could not be durably created', () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const checkpoints = new MemoryManagedCheckpoints();
    checkpoints.failCreate = true;
    const target = orchestrator(clock, () => WALL_START, store, undefined, {}, checkpoints);

    assert.equal(target.prepareManagedRun(CLAIM), false);
    assert.equal(provision(target, SOURCE_A), false);
    assert.equal(store.records.size, 0, 'admission was persisted without its recovery checkpoint');
  });

  it('refuses an ABR run whose frozen expected rung differs from local configuration', () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const checkpoints = new MemoryManagedCheckpoints();
    const target = makeTestOrchestrator({
      clock,
      wallClock: () => WALL_START,
      managedSourceReconnectMs: RECONNECT_MS,
      managedRunStore: store,
      managedCheckpointStore: checkpoints,
      ladder: AbrLadder.parse('360p:640:360:700'),
    });

    assert.equal(
      target.prepareManagedRun({
        ...CLAIM,
        expectedRenditions: [
          {
            name: '360p',
            topic: '77777777-7777-4777-8777-777777777777',
            width: 640,
            height: 360,
            bandwidth: 700_000,
            avgBandwidth: 700_000,
          },
        ],
      }),
      false,
    );
    assert.equal(store.records.size, 0);
    assert.equal(checkpoints.runs.size, 0);
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

  it('retries a failed cutoff save without reopening or losing the attached source', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    store.failClosedSaves = 1;
    const disconnected: SourceConnectionIdentity[] = [];
    const target = orchestrator(clock, () => WALL_START + clock.now(), store);
    target.registerManagedSourceDisconnector((source) => disconnected.push(source));
    assert.equal(target.prepareManagedRun(CLAIM), true);
    assert.equal(provision(target, SOURCE_A), true);
    assert.deepEqual(media(target, SOURCE_A), { accepted: true });
    const uploader = activeUploader(target);
    assert.ok(uploader);
    const notifyStop = mock.method(uploader, 'notifyStop');
    await uploader.segmentQueue.onIdle();

    await clock.advance(RECONNECT_MS);

    assert.notEqual(store.records.get(STREAM_ID)?.state, 'closed');
    assert.equal(provision(target, SOURCE_B), false);
    assert.deepEqual(disconnected, []);
    assert.equal(notifyStop.mock.callCount(), 0);

    await clock.advance(10_000);
    await settleReports();

    assert.equal(store.records.get(STREAM_ID)?.state, 'closed');
    assert.equal(store.records.get(STREAM_ID)?.deadlineWallMs, WALL_START + RECONNECT_MS);
    assert.deepEqual(disconnected, [SOURCE_A]);
    assert.equal(notifyStop.mock.callCount(), 1);
    assert.equal(provision(target, SOURCE_B), false);
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

  it('reserves every listed managed run before legacy recovery can accept its callbacks', () => {
    const store: ManagedRunPersistence = {
      save: () => undefined,
      read: () => ({ kind: MANAGED_RUN_UNREADABLE }),
      list: () => [STREAM_ID],
    };
    const target = orchestrator(new FakeClock(), () => WALL_START, store);

    target.restoreManagedRuns();

    assert.deepEqual(target.handleSegment(STREAM_ID, 0, 0.1, videoSegment(4, 0)), {
      accepted: false,
      reason: 'stale_source',
    });
  });

  it('does not rebuild a legacy uploader for an unreadable reserved managed run', async () => {
    const store: ManagedRunPersistence = {
      save: () => undefined,
      read: () => ({ kind: MANAGED_RUN_UNREADABLE }),
      list: () => [STREAM_ID],
    };
    const recovery = makeFakeRecoveryStore({
      listActive: () => [STREAM_ID],
      load: () => makeRecoveredState(STREAM_ID),
    });
    const target = makeTestOrchestrator(
      {
        clock: new FakeClock(),
        managedSourceReconnectMs: RECONNECT_MS,
        managedRunStore: store,
        managedCheckpointStore: new MemoryManagedCheckpoints(),
      },
      {},
      recovery,
    );

    target.restoreManagedRuns();

    assert.deepEqual(await target.recoverStreams(), []);
    assert.equal(activeUploader(target), undefined);
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

  it('checkpoints the final manifest before appending a managed VOD report', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-finalization-'));
    const clock = new FakeClock();
    const runs = new MemoryManagedRuns();
    const checkpoints = new ManagedCheckpointStore(path.join(root, 'checkpoints'));
    const mediaStore = new ManagedMediaStore(path.join(root, 'media'));
    const target = makeTestOrchestrator(
      {
        clock,
        wallClock: () => WALL_START + clock.now(),
        managedSourceReconnectMs: RECONNECT_MS,
        managedRunStore: runs,
        managedCheckpointStore: checkpoints,
        managedMediaStore: mediaStore,
      },
      {
        uploadData: async () => ({ reference: { toHex: () => 'a'.repeat(64) } }),
        uploadPayload: async (index) => ({
          reference: { toHex: () => String(index + 1).padStart(64, '0') },
        }),
      },
    );

    try {
      assert.equal(target.prepareManagedRun(CLAIM), true);
      assert.equal(provision(target, SOURCE_A), true);
      assert.deepEqual(media(target, SOURCE_A), { accepted: true });
      await activeUploader(target)!.segmentQueue.onIdle();
      assert.equal(target.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);

      await clock.advance(RECONNECT_MS);
      await waitFor(() => runs.records.get(STREAM_ID)?.state === 'vod');

      const run = runs.records.get(STREAM_ID);
      const checkpoint = checkpoints.findRun(CLAIM.adminStreamId, CLAIM.runNumber);
      assert.equal(checkpoint?.status, 'complete');
      assert.deepEqual(
        run?.pendingReports.map((report) => report.state),
        ['waiting', 'closed', 'vod'],
      );
      const completed = run?.pendingReports.at(-1)?.completedRecording as
        | { master: { topic: string; index: number; reference: string } }
        | undefined;
      assert.equal(completed?.master.topic, CLAIM.topic);
      assert.equal(completed?.master.reference, String((completed?.master.index ?? -1) + 1).padStart(64, '0'));
    } finally {
      await target.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resumes durable finalization for a closed run at startup and leaves a completed VOD dormant', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-closed-recovery-'));
    const clock = new FakeClock();
    const runs = new MemoryManagedRuns();
    const checkpoints = new ManagedCheckpointStore(path.join(root, 'checkpoints'));
    const mediaStore = new ManagedMediaStore(path.join(root, 'media'));
    let uploadCount = 0;
    const uploads = {
      uploadData: async () => ({
        reference: { toHex: () => String(uploadCount++).padStart(64, 'a') },
      }),
      uploadPayload: async (index: number) => ({
        reference: { toHex: () => String(index + 1).padStart(64, '0') },
      }),
    };
    const first = makeTestOrchestrator(
      {
        clock,
        wallClock: () => WALL_START + clock.now(),
        managedSourceReconnectMs: RECONNECT_MS,
        managedRunStore: runs,
        managedCheckpointStore: checkpoints,
        managedMediaStore: mediaStore,
      },
      uploads,
    );

    try {
      assert.equal(first.prepareManagedRun(CLAIM), true);
      assert.equal(provision(first, SOURCE_A), true);
      assert.deepEqual(media(first, SOURCE_A), { accepted: true });
      await activeUploader(first)!.segmentQueue.onIdle();

      const beforeCrash = runs.records.get(STREAM_ID);
      assert.ok(beforeCrash);
      runs.save({
        ...beforeCrash,
        state: 'closed',
        deadlineWallMs: WALL_START + clock.now(),
        deadlineRecordedAtWallMs: WALL_START + clock.now(),
        deadlineRemainingMs: 0,
        source: SOURCE_A,
      });

      const restarted = makeTestOrchestrator(
        {
          clock: new FakeClock(),
          wallClock: () => WALL_START + 1_000,
          managedSourceReconnectMs: RECONNECT_MS,
          managedRunStore: runs,
          managedCheckpointStore: checkpoints,
          managedMediaStore: mediaStore,
        },
        uploads,
      );
      restarted.restoreManagedRuns();
      assert.deepEqual(restarted.recoverManagedMedia(), [STREAM_ID]);
      await waitFor(() => runs.records.get(STREAM_ID)?.state === 'vod');
      assert.equal(checkpoints.findRun(CLAIM.adminStreamId, CLAIM.runNumber)?.status, 'complete');
      await restarted.cleanup();

      const uploadsAfterCompletion = uploadCount;
      const completed = makeTestOrchestrator(
        {
          clock: new FakeClock(),
          wallClock: () => WALL_START + 2_000,
          managedSourceReconnectMs: RECONNECT_MS,
          managedRunStore: runs,
          managedCheckpointStore: checkpoints,
          managedMediaStore: mediaStore,
        },
        uploads,
      );
      completed.restoreManagedRuns();
      assert.deepEqual(completed.recoverManagedMedia(), []);
      assert.equal(activeUploader(completed), undefined);
      await settleReports();
      assert.equal(uploadCount, uploadsAfterCompletion);
      await completed.cleanup();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('completes an ABR checkpoint only after its frozen rung and master are immutable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-abr-finalization-'));
    const clock = new FakeClock();
    const runs = new MemoryManagedRuns();
    const checkpoints = new ManagedCheckpointStore(path.join(root, 'checkpoints'));
    const mediaStore = new ManagedMediaStore(path.join(root, 'media'));
    const ladder = AbrLadder.parse('360p:640:360:700');
    const expectedRenditions = [
      {
        name: '360p',
        topic: rungTopicFor(CLAIM.topic, '360p'),
        width: 640,
        height: 360,
        bandwidth: 700_000,
        avgBandwidth: 700_000,
      },
    ];
    const announcedIdentities: LadderIdentity[] = [];
    const announcedRenditions: Rendition[] = [];
    const ladderRegistry = {
      recordRungDelivered: () => {},
      upsertRendition: async (identity: LadderIdentity, rendition: Rendition) => {
        announcedIdentities.push(structuredClone(identity));
        announcedRenditions.push(structuredClone(rendition));
        return {
          masterIndex: 9,
          masterReference: 'b'.repeat(64),
          flippedToFinished: true,
          duration: 0.1,
        };
      },
    } as LadderRegistry;
    const target = makeTestOrchestrator(
      {
        clock,
        wallClock: () => WALL_START + clock.now(),
        managedSourceReconnectMs: RECONNECT_MS,
        managedRunStore: runs,
        managedCheckpointStore: checkpoints,
        managedMediaStore: mediaStore,
        ladder,
        ladderRegistry,
      },
      {
        uploadData: async () => ({ reference: { toHex: () => 'a'.repeat(64) } }),
        uploadPayload: async (index) => ({
          reference: { toHex: () => String(index + 1).padStart(64, '0') },
        }),
      },
    );

    try {
      assert.equal(target.prepareManagedRun({ ...CLAIM, expectedRenditions }), true);
      assert.equal(provision(target, SOURCE_A), true);
      assert.deepEqual(target.handleManagedSourceProgress(STREAM_ID, SOURCE_A, 0.1, videoSegment(4, 0)), {
        accepted: true,
      });
      assert.equal(
        target.provisionManagedRendition(RUNG_ID, STREAM_ID, SOURCE_A, MEDIA_TYPE_VIDEO, CLAIMANT, ADMIN),
        true,
      );
      assert.deepEqual(target.handleManagedRenditionSegment(RUNG_ID, STREAM_ID, SOURCE_A, 0, 0.1, videoSegment(4, 0)), {
        accepted: true,
      });
      await activeUploader(target, RUNG_ID)!.segmentQueue.onIdle();

      await clock.advance(RECONNECT_MS);
      await waitFor(() => runs.records.get(STREAM_ID)?.state === 'vod');

      const completed = checkpoints.findRun(CLAIM.adminStreamId, CLAIM.runNumber)?.completedRecording;
      assert.deepEqual(completed?.master, {
        topic: CLAIM.topic,
        index: 9,
        reference: 'b'.repeat(64),
        duration: 0.1,
      });
      assert.deepEqual(completed?.expectedRenditions, ['360p']);
      assert.equal(completed?.renditions[0]?.name, '360p');
      assert.equal(completed?.renditions[0]?.topic, expectedRenditions[0].topic);
      assert.deepEqual(announcedIdentities.at(-1)?.managedRun, {
        runNumber: CLAIM.runNumber,
        uploaderId: CLAIM.uploaderId,
        claimId: CLAIM_ID,
        expectedRenditions,
      });
      assert.ok(announcedRenditions.length > 0);
      assert.ok(
        announcedRenditions.every(
          (rendition) =>
            rendition.bandwidth === expectedRenditions[0].bandwidth &&
            rendition.avgBandwidth === expectedRenditions[0].avgBandwidth,
        ),
      );
    } finally {
      await target.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores an ABR VOD from its completed checkpoint after the run record save was lost', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-abr-complete-recovery-'));
    const clock = new FakeClock();
    const runs = new MemoryManagedRuns();
    const checkpoints = new ManagedCheckpointStore(path.join(root, 'checkpoints'));
    const mediaStore = new ManagedMediaStore(path.join(root, 'media'));
    const ladder = AbrLadder.parse('360p:640:360:700');
    const expectedRenditions = [
      {
        name: '360p',
        topic: rungTopicFor(CLAIM.topic, '360p'),
        width: 640,
        height: 360,
        bandwidth: 700_000,
        avgBandwidth: 700_000,
      },
    ];
    const finalAnnouncements: unknown[] = [];
    const ladderRegistry = {
      recordRungDelivered: () => {},
      upsertRendition: async (_identity: unknown, rendition: { index?: number }) => {
        if (rendition.index !== undefined) {
          finalAnnouncements.push(structuredClone(rendition));
          return {
            masterIndex: 9,
            masterReference: 'b'.repeat(64),
            flippedToFinished: true,
            duration: 0.1,
          };
        }
        return {
          masterIndex: 8,
          masterReference: 'c'.repeat(64),
          flippedToFinished: false,
          duration: null,
        };
      },
    } as LadderRegistry;
    const uploads = {
      uploadData: async () => ({ reference: { toHex: () => 'a'.repeat(64) } }),
      uploadPayload: async (index: number) => ({
        reference: { toHex: () => String(index + 1).padStart(64, '0') },
      }),
    };
    const first = makeTestOrchestrator(
      {
        clock,
        wallClock: () => WALL_START + clock.now(),
        managedSourceReconnectMs: RECONNECT_MS,
        managedRunStore: runs,
        managedCheckpointStore: checkpoints,
        managedMediaStore: mediaStore,
        ladder,
        ladderRegistry,
      },
      uploads,
    );

    try {
      assert.equal(first.prepareManagedRun({ ...CLAIM, expectedRenditions }), true);
      assert.equal(provision(first, SOURCE_A), true);
      assert.deepEqual(first.handleManagedSourceProgress(STREAM_ID, SOURCE_A, 0.1, videoSegment(4, 0)), {
        accepted: true,
      });
      assert.equal(
        first.provisionManagedRendition(RUNG_ID, STREAM_ID, SOURCE_A, MEDIA_TYPE_VIDEO, CLAIMANT, ADMIN),
        true,
      );
      assert.deepEqual(first.handleManagedRenditionSegment(RUNG_ID, STREAM_ID, SOURCE_A, 0, 0.1, videoSegment(4, 0)), {
        accepted: true,
      });
      await activeUploader(first, RUNG_ID)!.segmentQueue.onIdle();

      runs.failVodSaves = 2;
      await clock.advance(RECONNECT_MS);
      await waitFor(() => checkpoints.findRun(CLAIM.adminStreamId, CLAIM.runNumber)?.status === 'complete');
      await waitFor(() => activeUploader(first, RUNG_ID) === undefined);

      const completedBeforeRestart = checkpoints.findRun(CLAIM.adminStreamId, CLAIM.runNumber)?.completedRecording;
      assert.equal(runs.records.get(STREAM_ID)?.state, 'closed');
      assert.equal(finalAnnouncements.length, 1);
      assert.deepEqual(completedBeforeRestart?.master, {
        topic: CLAIM.topic,
        index: 9,
        reference: 'b'.repeat(64),
        duration: 0.1,
      });
      await first.cleanup();

      const sent: ManagedRunReport[] = [];
      const restartedClock = new FakeClock();
      const restarted = makeTestOrchestrator(
        {
          clock: restartedClock,
          wallClock: () => WALL_START + RECONNECT_MS + 1_000,
          managedSourceReconnectMs: RECONNECT_MS,
          managedRunStore: runs,
          managedCheckpointStore: checkpoints,
          managedMediaStore: mediaStore,
          adminApi: reportingAdmin(sent, STATE_REPORT_ACCEPTED),
          ladder,
          ladderRegistry,
        },
        uploads,
      );
      restarted.restoreManagedRuns();

      assert.deepEqual(restarted.recoverManagedMedia(), []);
      assert.equal(runs.records.get(STREAM_ID)?.state, 'closed');
      assert.equal(finalAnnouncements.length, 1);
      await restartedClock.advance(10_000);
      await waitFor(() => runs.records.get(STREAM_ID)?.state === 'vod');
      await waitFor(() => sent.some((report) => report.state === 'vod'));
      assert.deepEqual(sent.find((report) => report.state === 'vod')?.completedRecording, completedBeforeRestart);
      assert.deepEqual(
        checkpoints.findRun(CLAIM.adminStreamId, CLAIM.runNumber)?.completedRecording,
        completedBeforeRestart,
      );
      assert.equal(finalAnnouncements.length, 1);
      assert.equal(activeUploader(restarted, RUNG_ID), undefined);
      await restarted.cleanup();
    } finally {
      await first.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps accepted media pending and reports no VOD when every upload fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failed-finalization-'));
    const clock = new FakeClock();
    const runs = new MemoryManagedRuns();
    const checkpoints = new ManagedCheckpointStore(path.join(root, 'checkpoints'));
    const mediaStore = new ManagedMediaStore(path.join(root, 'media'));
    const target = makeTestOrchestrator(
      {
        clock,
        wallClock: () => WALL_START + clock.now(),
        managedSourceReconnectMs: RECONNECT_MS,
        managedRunStore: runs,
        managedCheckpointStore: checkpoints,
        managedMediaStore: mediaStore,
      },
      { uploadData: rejectImmediately },
    );

    try {
      assert.equal(target.prepareManagedRun(CLAIM), true);
      assert.equal(provision(target, SOURCE_A), true);
      assert.deepEqual(media(target, SOURCE_A), { accepted: true });
      await activeUploader(target)!.segmentQueue.onIdle();

      await clock.advance(RECONNECT_MS);
      await waitFor(() => activeUploader(target) === undefined);

      assert.equal(runs.records.get(STREAM_ID)?.state, 'closed');
      assert.equal(
        runs.records.get(STREAM_ID)?.pendingReports.some((report) => report.state === 'vod'),
        false,
      );
      assert.equal(checkpoints.findRun(CLAIM.adminStreamId, CLAIM.runNumber)?.status, 'prepared');
      assert.deepEqual(
        mediaStore.listRun(CLAIM.adminStreamId, CLAIM.runNumber).map((record) => record.status),
        ['pending'],
      );
    } finally {
      await target.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains recovery and withholds VOD when the final track checkpoint fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-checkpoint-failure-'));
    const clock = new FakeClock();
    const runs = new MemoryManagedRuns();
    const durable = new ManagedCheckpointStore(path.join(root, 'checkpoints'));
    const removeRecovery = mock.fn();
    const recovery = makeFakeRecoveryStore({ remove: removeRecovery });
    const checkpoints: ManagedCheckpointPersistence = {
      createRun: (input) => durable.createRun(input),
      adoptLegacy: (input) => durable.adoptLegacy(input),
      prepare: (operation) => durable.prepare(operation),
      saveTrack: () => {
        throw new Error('injected track checkpoint failure');
      },
      complete: (reference, master) => durable.complete(reference, master),
      sealEmpty: (reference, count) => durable.sealEmpty(reference, count),
      read: (reference) => durable.read(reference),
      findRun: (streamId, runNumber) => durable.findRun(streamId, runNumber),
    };
    const target = makeTestOrchestrator(
      {
        clock,
        wallClock: () => WALL_START + clock.now(),
        managedSourceReconnectMs: RECONNECT_MS,
        managedRunStore: runs,
        managedCheckpointStore: checkpoints,
      },
      {
        uploadData: async () => ({ reference: { toHex: () => 'a'.repeat(64) } }),
        uploadPayload: async (index) => ({
          reference: { toHex: () => String(index + 1).padStart(64, '0') },
        }),
      },
      recovery,
    );

    try {
      assert.equal(target.prepareManagedRun(CLAIM), true);
      assert.equal(provision(target, SOURCE_A), true);
      assert.deepEqual(media(target, SOURCE_A), { accepted: true });
      await activeUploader(target)!.segmentQueue.onIdle();

      await clock.advance(RECONNECT_MS);
      await waitFor(() => activeUploader(target) === undefined);

      assert.equal(runs.records.get(STREAM_ID)?.state, 'closed');
      assert.equal(
        runs.records.get(STREAM_ID)?.pendingReports.some((report) => report.state === 'vod'),
        false,
      );
      assert.equal(durable.findRun(CLAIM.adminStreamId, CLAIM.runNumber)?.status, 'prepared');
      assert.equal(removeRecovery.mock.callCount(), 0);
    } finally {
      await target.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries the exact durable report after restart', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const sent: ManagedRunReport[] = [];
    const first = orchestrator(clock, () => WALL_START + clock.now(), store, reportingAdmin(sent, STATE_REPORT_FAILED));
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
    assert.equal(lastMatching(sent, (report) => report.state === 'live')?.state, 'live');

    assert.equal(target.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    assert.equal(provision(target, SOURCE_B), true);
    assert.deepEqual(media(target, SOURCE_B, 1), { accepted: true });
    await activeUploader(target)?.segmentQueue.onIdle();
    await settleReports();

    assert.deepEqual(
      sent.slice(-2).map((report) => report.state),
      ['waiting', 'live'],
    );
    assert.equal(store.records.get(STREAM_ID)?.source?.clientId, SOURCE_B.clientId);
  });

  it('does not let a delayed old-source manifest mark the reconnect live', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const sent: ManagedRunReport[] = [];
    let releaseA: (value: unknown) => void = () => undefined;
    let releaseB: (value: unknown) => void = () => undefined;
    const manifests = [
      new Promise((resolve) => {
        releaseA = resolve;
      }),
      new Promise((resolve) => {
        releaseB = resolve;
      }),
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
    assert.equal(
      sent.some((report) => report.state === 'live'),
      false,
    );

    releaseB({ reference: { toHex: () => 'manifest-b' } });
    await settleReports();
    assert.equal(lastMatching(sent, (report) => report.state === 'live')?.state, 'live');
  });

  it('keeps managed ABR rung uploaders through reconnect grace and finalizes them at cutoff', async () => {
    const clock = new FakeClock();
    const store = new MemoryManagedRuns();
    const checkpoints = new MemoryManagedCheckpoints();
    const expectedRenditions = [
      {
        name: '360p',
        topic: rungTopicFor(CLAIM.topic, '360p'),
        width: 640,
        height: 360,
        bandwidth: 700_000,
        avgBandwidth: 700_000,
      },
    ];
    const target = makeTestOrchestrator({
      clock,
      wallClock: () => WALL_START + clock.now(),
      managedSourceReconnectMs: RECONNECT_MS,
      managedRunStore: store,
      managedCheckpointStore: checkpoints,
      ladder: AbrLadder.parse('360p:640:360:700'),
    });
    assert.equal(target.prepareManagedRun({ ...CLAIM, expectedRenditions }), true);
    assert.equal(provision(target, SOURCE_A), true);
    assert.deepEqual(target.handleManagedSourceProgress(STREAM_ID, SOURCE_A, 0.1, videoSegment(4, 0)), {
      accepted: true,
    });
    assert.equal(
      target.provisionManagedRendition(RUNG_ID, STREAM_ID, SOURCE_A, MEDIA_TYPE_VIDEO, CLAIMANT, ADMIN),
      true,
    );
    assert.deepEqual(target.handleManagedRenditionSegment(RUNG_ID, STREAM_ID, SOURCE_A, 0, 0.1, videoSegment(4, 0)), {
      accepted: true,
    });
    const uploader = activeUploader(target, RUNG_ID);
    assert.ok(uploader);
    const notifyStop = mock.method(uploader, 'notifyStop');

    assert.equal(target.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    await clock.advance(30_000);
    await settleReports();
    assert.equal(notifyStop.mock.callCount(), 0, 'the generic rung reaper finalized inside reconnect grace');
    assert.equal(provision(target, SOURCE_B), true);
    assert.deepEqual(target.handleManagedSourceProgress(STREAM_ID, SOURCE_B, 0.1, videoSegment(4, 4 * FRAME_TICKS)), {
      accepted: true,
    });
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
    const waiting = lastMatching(sent, (report) => report.state === 'waiting');
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
    assert.equal(
      store.records.get(STREAM_ID)?.pendingReports.some((report) => report.state === 'closed'),
      true,
    );

    online = true;
    await clock.advance(MANAGED_REPORT_RETRY_MS);
    await settleReports();
    assert.equal(
      sent.some((report) => report.state === 'closed'),
      true,
    );
    assert.deepEqual(store.records.get(STREAM_ID)?.pendingReports, []);
  });
});

const MANAGED_REPORT_RETRY_MS = 10_000;
