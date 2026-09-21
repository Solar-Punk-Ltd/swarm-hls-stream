import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';

import { AdminApiClient, LegacyAdoptionOperation, LegacyAdoptionPreparation } from '../src/libs/AdminApiClient.js';
import { LegacyRecordingAdopter } from '../src/libs/LegacyRecordingAdopter.js';
import { ManagedCheckpointStore } from '../src/libs/ManagedCheckpointStore.js';
import { MediaFormatFingerprint } from '../src/libs/MediaFormatProbe.js';

import { makeFakeRecoveryStore, makeRecoveredState, makeTestOrchestrator } from './helpers/fakes.js';

const STREAM_ID = '11111111-1111-4111-8111-111111111111';
const TOPIC = '22222222-2222-4222-8222-222222222222';
const SEGMENT = 'a'.repeat(64);
const VIDEO_FORMAT: MediaFormatFingerprint = {
  version: 1,
  container: 'mpegts',
  tracks: [
    {
      kind: 'video',
      codec: 'h264',
      profile: 'High',
      level: 40,
      width: 1280,
      height: 720,
      pixelFormat: 'yuv420p',
      chromaLocation: 'left',
      bitsPerRawSample: 8,
    },
  ],
};

const OPERATION: LegacyAdoptionOperation = {
  lifecycleVersion: 1,
  kind: 'legacy-adoption',
  operationId: '33333333-3333-4333-8333-333333333333',
  requestId: '44444444-4444-4444-8444-444444444444',
  streamId: STREAM_ID,
  topic: TOPIC,
  mediaType: 'video',
  uploaderId: 'srs-uploader-a',
  candidateDigest: 'c'.repeat(64),
  revision: 4,
  status: 'pending',
  candidate: {
    streamId: STREAM_ID,
    topic: TOPIC,
    mediaType: 'video',
    master: { topic: TOPIC, index: 12, duration: 2 },
    renditions: [],
  },
};

describe('legacy adoption polling', () => {
  it('seals and acknowledges only an admin-assigned immutable recording', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-adoption-runtime-'));
    const preparations: LegacyAdoptionPreparation[] = [];
    const adminApi = {
      listManagedContinuations: async () => [],
      listLegacyAdoptions: async () => [OPERATION],
      reportLegacyAdoptionPreparation: async (
        _operation: LegacyAdoptionOperation,
        preparation: LegacyAdoptionPreparation,
      ) => {
        preparations.push(preparation);
      },
    } as unknown as AdminApiClient;
    const playlist = `#EXTM3U\n#EXTINF:2,\n${SEGMENT}\n#EXT-X-ENDLIST\n`;
    const readFeed = mock.fn(async () => ({ playlist, reference: 'b'.repeat(64) }));
    const checkpoints = new ManagedCheckpointStore(path.join(root, 'checkpoints'));
    const target = makeTestOrchestrator({
      adminApi,
      managedCheckpointStore: checkpoints,
      legacyRecordingAdopter: new LegacyRecordingAdopter(
        {
          owner: '0'.repeat(40),
          readFeed,
          readSegment: async () => Buffer.from('mpeg-ts'),
        },
        { inspect: async () => ({ kind: 'valid', fingerprint: VIDEO_FORMAT }) },
      ),
    });

    try {
      await target.pollManagedContinuations(OPERATION.uploaderId);

      assert.equal(readFeed.mock.callCount(), 1);
      assert.equal(preparations.length, 1);
      assert.equal(preparations[0].status, 'ready');
      assert.equal(checkpoints.findRun(STREAM_ID, 1)?.status, 'complete');
      if (preparations[0].status === 'ready') {
        assert.equal(
          preparations[0].completedRecording.checkpointReference,
          checkpoints.findRun(STREAM_ID, 1)?.checkpointReference,
        );
        assert.deepEqual(preparations[0].validation.tracks, [{ topic: TOPIC, formatFingerprint: VIDEO_FORMAT }]);
      }
    } finally {
      await target.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not block adoption on a retained recovery entry for another topic', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-adoption-unrelated-recovery-'));
    const preparations: LegacyAdoptionPreparation[] = [];
    const adminApi = {
      listManagedContinuations: async () => [],
      listLegacyAdoptions: async () => [OPERATION],
      reportLegacyAdoptionPreparation: async (
        _operation: LegacyAdoptionOperation,
        preparation: LegacyAdoptionPreparation,
      ) => {
        preparations.push(preparation);
      },
    } as unknown as AdminApiClient;
    const unrelatedState = {
      ...makeRecoveredState('video/unrelated'),
      streamRawTopic: 'unrelated-topic',
    };
    const recoveryStore = makeFakeRecoveryStore({
      listActive: () => [unrelatedState.streamId],
      load: () => unrelatedState,
    });
    const readFeed = mock.fn(async () => ({
      playlist: `#EXTM3U\n#EXTINF:2,\n${SEGMENT}\n#EXT-X-ENDLIST\n`,
      reference: 'b'.repeat(64),
    }));
    const target = makeTestOrchestrator(
      {
        adminApi,
        managedCheckpointStore: new ManagedCheckpointStore(path.join(root, 'checkpoints')),
        legacyRecordingAdopter: new LegacyRecordingAdopter(
          {
            owner: '0'.repeat(40),
            readFeed,
            readSegment: async () => Buffer.from('mpeg-ts'),
          },
          { inspect: async () => ({ kind: 'valid', fingerprint: VIDEO_FORMAT }) },
        ),
      },
      {},
      recoveryStore,
    );

    try {
      await target.pollManagedContinuations(OPERATION.uploaderId);

      assert.equal(readFeed.mock.callCount(), 1);
      assert.equal(preparations.length, 1);
      assert.equal(preparations[0].status, 'ready');
    } finally {
      await target.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds the assigned stream read-only across asynchronous media validation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-adoption-reservation-'));
    let assigned: readonly LegacyAdoptionOperation[] = [OPERATION];
    let releaseRead!: () => void;
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const adminApi = {
      listManagedContinuations: async () => [],
      listLegacyAdoptions: async () => assigned,
      reportLegacyAdoptionPreparation: async () => undefined,
    } as unknown as AdminApiClient;
    const target = makeTestOrchestrator({
      adminApi,
      managedCheckpointStore: new ManagedCheckpointStore(path.join(root, 'checkpoints')),
      legacyRecordingAdopter: new LegacyRecordingAdopter(
        {
          owner: '0'.repeat(40),
          readFeed: async () => {
            signalRead();
            await readReleased;
            return {
              playlist: `#EXTM3U\n#EXTINF:2,\n${SEGMENT}\n#EXT-X-ENDLIST\n`,
              reference: 'b'.repeat(64),
            };
          },
          readSegment: async () => Buffer.from('mpeg-ts'),
        },
        { inspect: async () => ({ kind: 'valid', fingerprint: VIDEO_FORMAT }) },
      ),
    });

    try {
      const polling = target.pollManagedContinuations(OPERATION.uploaderId);
      await readStarted;
      assert.equal(
        target.startStream(
          `video/${TOPIC}`,
          'video',
          { address: '198.51.100.1', isAuthenticated: true },
          { id: STREAM_ID, topic: TOPIC },
        ),
        false,
      );
      releaseRead();
      await polling;

      assigned = [];
      await target.pollManagedContinuations(OPERATION.uploaderId);
      assert.equal(
        target.startStream(
          `video/${TOPIC}`,
          'video',
          { address: '198.51.100.1', isAuthenticated: true },
          { id: STREAM_ID, topic: TOPIC },
        ),
        true,
      );
    } finally {
      releaseRead();
      await target.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
