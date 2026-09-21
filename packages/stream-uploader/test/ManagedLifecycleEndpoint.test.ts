import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  MANAGED_RUN_LOADED,
  MANAGED_RUN_MISSING,
  ManagedRunEntry,
  ManagedRunPersistence,
  ManagedRunRecord,
} from '../src/libs/ManagedRunStore.js';

import { NO_AUTH_HEADER, startTestApi } from './helpers/apiTestServer.js';
import { makeFakeOrchestrator, makeTestOrchestrator } from './helpers/fakes.js';

const NOW = Date.parse('2026-09-20T10:10:00.000Z');
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const CLAIM_ID = '22222222-2222-4222-8222-222222222222';
const CHECKPOINT_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';

function record(overrides: Partial<ManagedRunRecord>): ManagedRunRecord {
  return {
    lifecycleVersion: 1,
    streamId: 'video/source',
    adminStreamId: ADMIN_ID,
    topic: 'source-topic',
    mediaType: 'video',
    revision: 4,
    runNumber: 2,
    uploaderId: 'uploader-a',
    claimId: CLAIM_ID,
    claimRequestId: REQUEST_ID,
    eventSequence: 2,
    expectedRenditions: [],
    checkpointReference: CHECKPOINT_ID,
    state: 'live',
    deadlineWallMs: NOW + 60_000,
    deadlineRecordedAtWallMs: NOW - 10_000,
    deadlineRemainingMs: 60_000,
    lastProgressPts: 90_000,
    source: { serverId: 'server', serviceId: 'service', clientId: 'client', generation: 1 },
    rungConnections: [],
    pendingReports: [],
    lastObservedAt: '2026-09-20T10:09:50.000Z',
    ...overrides,
  };
}

class MemoryRuns implements ManagedRunPersistence {
  constructor(private readonly records: ManagedRunRecord[]) {}
  save(): void {}
  read(streamId: string): ManagedRunEntry {
    const found = this.records.find((candidate) => candidate.streamId === streamId);
    return found ? { kind: MANAGED_RUN_LOADED, record: structuredClone(found) } : { kind: MANAGED_RUN_MISSING };
  }
  list(): string[] {
    return this.records.map(({ streamId }) => streamId);
  }
}

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('managed lifecycle status', () => {
  it('reports complete durable active and terminal records without private authority', () => {
    const store = new MemoryRuns([
      record({
        streamId: 'video/waiting',
        state: 'waiting',
        deadlineWallMs: NOW + 50_000,
      }),
      record({
        streamId: 'video/closed',
        state: 'closed',
        deadlineWallMs: NOW - 100_000,
        deadlineRemainingMs: 0,
        source: null,
        closeReason: 'reconnect_timeout',
        lastObservedAt: '2026-09-20T08:00:00.000Z',
      }),
      record({
        streamId: 'video/vod',
        state: 'vod',
        deadlineWallMs: NOW - 100_000,
        deadlineRemainingMs: 0,
        source: null,
        lastObservedAt: '2026-09-20T08:01:00.000Z',
      }),
      record({
        streamId: 'video/claimed',
        state: 'claimed',
        source: null,
      }),
      record({
        streamId: 'video/restored-stale',
        state: 'live',
        deadlineRecordedAtWallMs: NOW - 120_000,
        lastObservedAt: undefined,
      }),
    ]);
    const orchestrator = makeTestOrchestrator({
      managedRunStore: store,
      managedSourceReconnectMs: 60_000,
      wallClock: () => NOW,
    });

    const result = orchestrator.getManagedLifecycleSummary();

    assert.deepEqual(result, {
      lifecycleVersion: 1,
      observedAt: '2026-09-20T10:10:00.000Z',
      streams: [
        {
          streamId: 'video/claimed',
          adminStreamId: ADMIN_ID,
          runNumber: 2,
          state: 'claimed',
          permission: 'claimed',
          lastObservedAt: '2026-09-20T10:09:50.000Z',
        },
        {
          streamId: 'video/closed',
          adminStreamId: ADMIN_ID,
          runNumber: 2,
          state: 'closed',
          permission: 'closed',
          closeReason: 'reconnect_timeout',
          lastObservedAt: '2026-09-20T08:00:00.000Z',
        },
        {
          streamId: 'video/restored-stale',
          adminStreamId: ADMIN_ID,
          runNumber: 2,
          state: 'live',
          permission: 'claimed',
          lastObservedAt: '2026-09-20T10:08:00.000Z',
        },
        {
          streamId: 'video/vod',
          adminStreamId: ADMIN_ID,
          runNumber: 2,
          state: 'vod',
          permission: 'closed',
          lastObservedAt: '2026-09-20T08:01:00.000Z',
        },
        {
          streamId: 'video/waiting',
          adminStreamId: ADMIN_ID,
          runNumber: 2,
          state: 'waiting',
          permission: 'claimed',
          reconnectDeadline: '2026-09-20T10:10:50.000Z',
          lastObservedAt: '2026-09-20T10:09:50.000Z',
        },
      ],
    });
    assert.doesNotMatch(JSON.stringify(result), /claimId|checkpoint|topic|uploaderId|clientId/i);
  });

  it('keeps an unresolved durable claim unavailable instead of inventing open permission', () => {
    const store = new MemoryRuns([
      record({
        state: 'claiming',
        claimId: null,
        eventSequence: 0,
        source: null,
      }),
    ]);
    const orchestrator = makeTestOrchestrator({
      managedRunStore: store,
      managedSourceReconnectMs: 60_000,
      wallClock: () => NOW,
    });

    assert.throws(() => orchestrator.getManagedLifecycleSummary(), /claim is unresolved/);
  });

  it('keeps the endpoint disabled by default and protects enabled reads with the existing bearer', async () => {
    const response = {
      lifecycleVersion: 1 as const,
      observedAt: '2026-09-20T10:10:00.000Z',
      streams: [],
    };
    const orchestrator = makeFakeOrchestrator({ getManagedLifecycleSummary: () => response });
    const disabled = await startTestApi(orchestrator);
    servers.push(disabled);
    assert.equal((await disabled.request('/stream/lifecycle')).status, 404);

    const enabled = await startTestApi(orchestrator, [], undefined, undefined, { version: 1 });
    servers.push(enabled);
    assert.equal((await enabled.request('/stream/lifecycle', { headers: NO_AUTH_HEADER })).status, 401);
    const accepted = await enabled.request('/stream/lifecycle');
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, response);
  });
});
