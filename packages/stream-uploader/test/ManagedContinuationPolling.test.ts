import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AdminApiClient, ManagedContinuationPreparation } from '../src/libs/AdminApiClient.js';
import { ManagedCheckpointStore, ManagedContinuationOperation } from '../src/libs/ManagedCheckpointStore.js';
import { ManagedMediaStore } from '../src/libs/ManagedMediaStore.js';
import { ManagedRunRecord, ManagedRunStore } from '../src/libs/ManagedRunStore.js';

import { makeTestOrchestrator } from './helpers/fakes.js';

const STREAM_ID = '22222222-2222-4222-8222-222222222222';
const UPLOADER_ID = 'srs-157-90-34-105';
const TOPIC = 'a'.repeat(64);
const INGEST_ID = 'video/demo';

function streamState() {
  return {
    streamId: 'video/demo',
    streamRawTopic: TOPIC,
    mediatype: 'video' as const,
    socIndex: 2,
    segments: [{ index: 0, duration: 2, ref: 'b'.repeat(64), discontinuity: false }],
    hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
    isFirstSegmentReady: true,
    isFirstManifestReady: true,
    pendingDiscontinuity: false,
    liveManifestStale: false,
    updatedAt: 1,
  };
}

function completedRun(root: string) {
  const checkpoints = new ManagedCheckpointStore(path.join(root, 'checkpoints'));
  const first = checkpoints.createRun({
    adminStreamId: STREAM_ID,
    runNumber: 1,
    topic: TOPIC,
    mediaType: 'video',
    expectedRenditions: [],
  });
  checkpoints.saveTrack(first.checkpointReference, {
    streamId: INGEST_ID,
    rendition: null,
    state: streamState(),
    manifest: { topic: TOPIC, index: 2, reference: 'c'.repeat(64), duration: 2 },
  });
  const recording = checkpoints.complete(first.checkpointReference, {
    topic: TOPIC,
    index: 2,
    reference: 'c'.repeat(64),
    duration: 2,
  });
  const runs = new ManagedRunStore(path.join(root, 'runs'));
  const record: ManagedRunRecord = {
    lifecycleVersion: 1,
    streamId: INGEST_ID,
    adminStreamId: STREAM_ID,
    topic: TOPIC,
    mediaType: 'video',
    revision: 10,
    runNumber: 1,
    uploaderId: UPLOADER_ID,
    claimId: '11111111-1111-4111-8111-111111111111',
    claimRequestId: '22222222-2222-4222-8222-222222222222',
    eventSequence: 1,
    expectedRenditions: [],
    checkpointReference: first.checkpointReference,
    state: 'vod',
    deadlineWallMs: 1,
    deadlineRecordedAtWallMs: 1,
    deadlineRemainingMs: 0,
    lastProgressPts: null,
    source: null,
    rungConnections: [],
    pendingReports: [],
  };
  runs.save(record);
  return { checkpoints, recording, runs };
}

describe('managed continuation polling', () => {
  it('prepares a durable cumulative checkpoint before acknowledging the operation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-continuation-poll-'));
    const checkpoints = new ManagedCheckpointStore(
      root,
      undefined,
      (() => {
        const ids = ['11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'];
        return () => ids.shift()!;
      })(),
    );
    const first = checkpoints.createRun({
      adminStreamId: STREAM_ID,
      runNumber: 1,
      topic: TOPIC,
      mediaType: 'video',
      expectedRenditions: [],
    });
    checkpoints.saveTrack(first.checkpointReference, {
      streamId: 'video/demo',
      rendition: null,
      state: streamState(),
      manifest: { topic: TOPIC, index: 2, reference: 'c'.repeat(64), duration: 2 },
    });
    const recording = checkpoints.complete(first.checkpointReference, {
      topic: TOPIC,
      index: 2,
      reference: 'c'.repeat(64),
      duration: 2,
    });
    const operation: ManagedContinuationOperation = {
      lifecycleVersion: 1,
      operationId: '44444444-4444-4444-8444-444444444444',
      requestId: '55555555-5555-4555-8555-555555555555',
      streamId: STREAM_ID,
      topic: TOPIC,
      mediaType: 'video',
      uploaderId: UPLOADER_ID,
      previousRunNumber: 1,
      nextRunNumber: 2,
      revision: 10,
      status: 'pending',
      retainedRecording: recording,
    };
    const attempted: ManagedContinuationPreparation[] = [];
    const adminApi = {
      listManagedContinuations: async () => [operation],
      reportManagedContinuationPreparation: async (
        _streamId: string,
        _operationId: string,
        preparation: ManagedContinuationPreparation,
      ) => {
        assert.equal(
          checkpoints.findRun(STREAM_ID, 2)?.checkpointReference,
          preparation.status === 'ready' ? preparation.checkpointReference : undefined,
        );
        attempted.push(structuredClone(preparation));
        if (attempted.length === 1) {
          throw new Error('injected lost preparation response');
        }
      },
    } as AdminApiClient;
    const target = makeTestOrchestrator({ adminApi, managedCheckpointStore: checkpoints });

    try {
      await assert.rejects(() => target.pollManagedContinuations(UPLOADER_ID), /lost preparation response/);
      await target.pollManagedContinuations(UPLOADER_ID);
      const expected = {
        lifecycleVersion: 1,
        uploaderId: UPLOADER_ID,
        expectedRevision: 10,
        status: 'ready',
        checkpointReference: '33333333-3333-4333-8333-333333333333',
      } as const;
      assert.deepEqual(attempted, [expected, expected]);
    } finally {
      await target.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a bounded failure when the predecessor cannot be proven', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-continuation-poll-'));
    const checkpoints = new ManagedCheckpointStore(root);
    const operation: ManagedContinuationOperation = {
      lifecycleVersion: 1,
      operationId: '44444444-4444-4444-8444-444444444444',
      requestId: '55555555-5555-4555-8555-555555555555',
      streamId: STREAM_ID,
      topic: TOPIC,
      mediaType: 'video',
      uploaderId: UPLOADER_ID,
      previousRunNumber: 1,
      nextRunNumber: 2,
      revision: 10,
      status: 'pending',
    };
    const reported: ManagedContinuationPreparation[] = [];
    const adminApi = {
      listManagedContinuations: async () => [operation],
      reportManagedContinuationPreparation: async (
        _streamId: string,
        _operationId: string,
        preparation: ManagedContinuationPreparation,
      ) => reported.push(preparation),
    } as AdminApiClient;
    const target = makeTestOrchestrator({ adminApi, managedCheckpointStore: checkpoints });

    try {
      await target.pollManagedContinuations(UPLOADER_ID);
      assert.equal(reported[0]?.status, 'failed');
      assert.ok(reported[0]?.status === 'failed' && reported[0].failure.length <= 500);
      assert.equal(checkpoints.findRun(STREAM_ID, 2), null);
    } finally {
      await target.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rehydrates prepared cumulative track history before the next run admits a source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-continuation-rehydrate-'));
    const ids = ['11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'];
    const checkpoints = new ManagedCheckpointStore(path.join(root, 'checkpoints'), undefined, () => ids.shift()!);
    const first = checkpoints.createRun({
      adminStreamId: STREAM_ID,
      runNumber: 1,
      topic: TOPIC,
      mediaType: 'video',
      expectedRenditions: [],
    });
    checkpoints.saveTrack(first.checkpointReference, {
      streamId: 'video/demo',
      rendition: null,
      state: streamState(),
      manifest: { topic: TOPIC, index: 2, reference: 'c'.repeat(64), duration: 2 },
    });
    const recording = checkpoints.complete(first.checkpointReference, {
      topic: TOPIC,
      index: 2,
      reference: 'c'.repeat(64),
      duration: 2,
    });
    checkpoints.prepare({
      lifecycleVersion: 1,
      operationId: '44444444-4444-4444-8444-444444444444',
      requestId: '55555555-5555-4555-8555-555555555555',
      streamId: STREAM_ID,
      topic: TOPIC,
      mediaType: 'video',
      uploaderId: UPLOADER_ID,
      previousRunNumber: 1,
      nextRunNumber: 2,
      revision: 10,
      status: 'pending',
      retainedRecording: recording,
    });
    const mediaStore = new ManagedMediaStore(path.join(root, 'media'));
    const target = makeTestOrchestrator({
      managedSourceReconnectMs: 60_000,
      managedCheckpointStore: checkpoints,
      managedMediaStore: mediaStore,
      managedRunStore: new ManagedRunStore(path.join(root, 'runs')),
    });

    try {
      assert.equal(
        target.prepareManagedRun({
          lifecycleVersion: 1,
          streamId: 'video/demo',
          adminStreamId: STREAM_ID,
          topic: TOPIC,
          mediaType: 'video',
          revision: 12,
          runNumber: 2,
          uploaderId: UPLOADER_ID,
          claimId: '66666666-6666-4666-8666-666666666666',
          eventSequence: 1,
          expectedRenditions: [],
        }),
        true,
      );
      const restored = mediaStore.readTrackState(STREAM_ID, 2, 'video/demo', null);
      assert.equal(restored?.segments.length, 1);
      assert.equal(restored?.segments[0]?.ref, 'b'.repeat(64));
    } finally {
      await target.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('admits a newer prepared run after an earlier pending continuation was cancelled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-continuation-skipped-'));
    const { checkpoints, recording, runs } = completedRun(root);
    const operation: ManagedContinuationOperation = {
      lifecycleVersion: 1,
      operationId: '33333333-3333-4333-8333-333333333333',
      requestId: '44444444-4444-4444-8444-444444444444',
      streamId: STREAM_ID,
      topic: TOPIC,
      mediaType: 'video',
      uploaderId: UPLOADER_ID,
      previousRunNumber: 1,
      nextRunNumber: 3,
      revision: 20,
      status: 'pending',
      retainedRecording: recording,
    };
    const prepared: ManagedContinuationPreparation[] = [];
    const adminApi = {
      listManagedContinuations: async () => [operation],
      reportManagedContinuationPreparation: async (
        _streamId: string,
        _operationId: string,
        preparation: ManagedContinuationPreparation,
      ) => void prepared.push(preparation),
    } as AdminApiClient;
    const target = makeTestOrchestrator({
      adminApi,
      managedSourceReconnectMs: 60_000,
      managedCheckpointStore: checkpoints,
      managedMediaStore: new ManagedMediaStore(path.join(root, 'media')),
      managedRunStore: runs,
    });

    try {
      await target.pollManagedContinuations(UPLOADER_ID);
      assert.equal(prepared[0]?.status, 'ready');
      const decision = target.beginManagedClaimAttempt({
        lifecycleVersion: 1,
        streamId: INGEST_ID,
        adminStreamId: STREAM_ID,
        topic: TOPIC,
        mediaType: 'video',
        revision: 21,
        runNumber: 3,
        uploaderId: UPLOADER_ID,
        expectedRenditions: [],
      });
      assert.equal(decision?.needsClaim, true);
    } finally {
      await target.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('seals a ready but never-claimed cancelled run before preparing its successor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-continuation-ready-cancel-'));
    const { checkpoints, recording, runs } = completedRun(root);
    const operationB: ManagedContinuationOperation = {
      lifecycleVersion: 1,
      operationId: '33333333-3333-4333-8333-333333333333',
      requestId: '44444444-4444-4444-8444-444444444444',
      streamId: STREAM_ID,
      topic: TOPIC,
      mediaType: 'video',
      uploaderId: UPLOADER_ID,
      previousRunNumber: 1,
      nextRunNumber: 2,
      revision: 20,
      status: 'pending',
      retainedRecording: recording,
    };
    let operations: ManagedContinuationOperation[] = [operationB];
    const prepared: ManagedContinuationPreparation[] = [];
    const adminApi = {
      listManagedContinuations: async () => operations,
      reportManagedContinuationPreparation: async (
        _streamId: string,
        _operationId: string,
        preparation: ManagedContinuationPreparation,
      ) => void prepared.push(preparation),
    } as AdminApiClient;
    const target = makeTestOrchestrator({
      adminApi,
      managedSourceReconnectMs: 60_000,
      managedCheckpointStore: checkpoints,
      managedMediaStore: new ManagedMediaStore(path.join(root, 'media')),
      managedRunStore: runs,
    });

    try {
      await target.pollManagedContinuations(UPLOADER_ID);
      const checkpointB = checkpoints.findRun(STREAM_ID, 2);
      assert.equal(prepared[0]?.status, 'ready');
      assert.equal(
        target.beginManagedClaimAttempt({
          lifecycleVersion: 1,
          streamId: INGEST_ID,
          adminStreamId: STREAM_ID,
          topic: TOPIC,
          mediaType: 'video',
          revision: 21,
          runNumber: 2,
          uploaderId: UPLOADER_ID,
          expectedRenditions: [],
        })?.needsClaim,
        true,
      );
      assert.ok(checkpointB);

      operations = [
        {
          lifecycleVersion: 1,
          operationId: '55555555-5555-4555-8555-555555555555',
          requestId: '66666666-6666-4666-8666-666666666666',
          streamId: STREAM_ID,
          topic: TOPIC,
          mediaType: 'video',
          uploaderId: UPLOADER_ID,
          previousRunNumber: 2,
          nextRunNumber: 3,
          revision: 30,
          status: 'pending',
          retainedRecording: recording,
          previousEmptyOutcome: {
            runNumber: 2,
            checkpointReference: checkpointB.checkpointReference,
            acceptedMediaCount: 0,
          },
        },
      ];
      await target.pollManagedContinuations(UPLOADER_ID);

      assert.equal(prepared[1]?.status, 'ready');
      assert.equal(checkpoints.findRun(STREAM_ID, 2)?.status, 'empty');
      assert.equal(
        target.beginManagedClaimAttempt({
          lifecycleVersion: 1,
          streamId: INGEST_ID,
          adminStreamId: STREAM_ID,
          topic: TOPIC,
          mediaType: 'video',
          revision: 31,
          runNumber: 3,
          uploaderId: UPLOADER_ID,
          expectedRenditions: [],
        })?.needsClaim,
        true,
      );
    } finally {
      await target.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
