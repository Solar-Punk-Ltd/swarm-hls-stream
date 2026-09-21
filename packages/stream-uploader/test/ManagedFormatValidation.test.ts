import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { AbrLadder } from '../src/libs/AbrLadder.js';
import { ManagedFormatStore } from '../src/libs/ManagedFormatStore.js';
import {
  MANAGED_RUN_LOADED,
  MANAGED_RUN_MISSING,
  ManagedRunEntry,
  ManagedRunPersistence,
  ManagedRunRecord,
} from '../src/libs/ManagedRunStore.js';
import {
  AudioFormatTrack,
  MediaFormatFingerprint,
  MediaFormatInspector,
  MediaFormatProbeResult,
  VideoFormatTrack,
} from '../src/libs/MediaFormatProbe.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { MEDIA_TYPE_VIDEO, SourceConnectionIdentity } from '../src/types.js';
import { rungTopicFor } from '../src/utils/rungTopic.js';

import { FakeClock } from './helpers/fakeClock.js';
import { makeTestOrchestrator } from './helpers/fakes.js';
import { MemoryManagedCheckpoints } from './helpers/managedCheckpoint.js';
import { FRAME_TICKS, videoSegment } from './helpers/transportStream.js';

const STREAM_ID = 'video/managed-format';
const ADMIN_STREAM_ID = '11111111-1111-4111-8111-111111111111';
const RECONNECT_MS = 60_000;
const SOURCE_A: SourceConnectionIdentity = {
  serverId: 'server',
  serviceId: 'service',
  clientId: 'client-a',
  generation: 1,
};
const SOURCE_B: SourceConnectionIdentity = {
  serverId: 'server',
  serviceId: 'service',
  clientId: 'client-b',
  generation: 2,
};
const AUDIO_FORMAT_TRACK: AudioFormatTrack = {
  kind: 'audio',
  codec: 'aac',
  profile: 'LC',
  sampleRate: 48_000,
  channels: 2,
  channelLayout: 'stereo',
};
const VIDEO_FORMAT_TRACK: VideoFormatTrack = {
  kind: 'video',
  codec: 'h264',
  profile: 'High',
  level: 40,
  width: 1280,
  height: 720,
  pixelFormat: 'yuv420p',
  chromaLocation: 'left',
  bitsPerRawSample: 8,
};
const FORMAT: MediaFormatFingerprint = {
  version: 1,
  container: 'mpegts',
  tracks: [AUDIO_FORMAT_TRACK, VIDEO_FORMAT_TRACK],
};
const roots: string[] = [];

class MemoryManagedRuns implements ManagedRunPersistence {
  private readonly records = new Map<string, ManagedRunRecord>();
  save(record: ManagedRunRecord): void {
    this.records.set(record.streamId, structuredClone(record));
  }
  read(streamId: string): ManagedRunEntry {
    const record = this.records.get(streamId);
    return record ? { kind: MANAGED_RUN_LOADED, record: structuredClone(record) } : { kind: MANAGED_RUN_MISSING };
  }
  list(): string[] {
    return [...this.records.keys()];
  }
}

class DeferredInspector implements MediaFormatInspector {
  public calls = 0;
  private resolves: Array<(result: MediaFormatProbeResult) => void> = [];
  inspect(): Promise<MediaFormatProbeResult> {
    this.calls++;
    return new Promise((resolve) => this.resolves.push(resolve));
  }
  resolve(result: MediaFormatProbeResult): void {
    const resolve = this.resolves.shift();
    assert.ok(resolve, 'no format inspection is pending');
    resolve(result);
  }
}

function create(inspector: MediaFormatInspector, clock = new FakeClock(), maxOpeningBytes?: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-format-validation-'));
  roots.push(root);
  const formatStore = new ManagedFormatStore(path.join(root, 'formats'), maxOpeningBytes);
  const orchestrator = makeTestOrchestrator({
    clock,
    wallClock: () => 1_000_000 + clock.now(),
    managedSourceReconnectMs: RECONNECT_MS,
    managedRunStore: new MemoryManagedRuns(),
    managedCheckpointStore: new MemoryManagedCheckpoints(),
    managedFormatStore: formatStore,
    mediaFormatInspector: inspector,
  });
  assert.equal(
    orchestrator.prepareManagedRun({
      lifecycleVersion: 1,
      streamId: STREAM_ID,
      adminStreamId: ADMIN_STREAM_ID,
      topic: 'managed-format-topic',
      mediaType: MEDIA_TYPE_VIDEO,
      revision: 1,
      runNumber: 1,
      uploaderId: 'uploader-a',
      claimId: '22222222-2222-4222-8222-222222222222',
      eventSequence: 1,
      expectedRenditions: [],
    }),
    true,
  );
  return { orchestrator, formatStore, clock };
}

function provision(orchestrator: StreamOrchestrator, source: SourceConnectionIdentity): boolean {
  return orchestrator.provisionManagedSource(
    STREAM_ID,
    MEDIA_TYPE_VIDEO,
    source,
    { address: '198.51.100.7', isAuthenticated: true },
    { id: ADMIN_STREAM_ID, topic: 'managed-format-topic' },
  );
}

function media(orchestrator: StreamOrchestrator, source: SourceConnectionIdentity, sequence: number) {
  return orchestrator.handleManagedSegment(
    STREAM_ID,
    source,
    sequence,
    0.1,
    videoSegment(4, sequence * 4 * FRAME_TICKS),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('managed actual opening format validation', () => {
  it('rechecks the original source deadline after the asynchronous inspection', async () => {
    const inspector = new DeferredInspector();
    const { orchestrator, clock } = create(inspector);
    assert.equal(provision(orchestrator, SOURCE_A), true);
    const pending = media(orchestrator, SOURCE_A, 0);

    await clock.advance(RECONNECT_MS);
    inspector.resolve({ kind: 'valid', fingerprint: FORMAT });

    assert.deepEqual(await pending, { accepted: false, reason: 'stale_source' });
    assert.equal(orchestrator.getActiveStreamCount(), 0);
    await orchestrator.cleanup();
  });

  it('rechecks source generation after inspection and never binds a displaced candidate', async () => {
    const inspector = new DeferredInspector();
    const { orchestrator } = create(inspector);
    assert.equal(provision(orchestrator, SOURCE_A), true);
    const pending = media(orchestrator, SOURCE_A, 0);
    assert.equal(orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    assert.equal(provision(orchestrator, SOURCE_B), true);
    inspector.resolve({ kind: 'valid', fingerprint: FORMAT });

    assert.deepEqual(await pending, { accepted: false, reason: 'stale_source' });
    assert.equal(orchestrator.getActiveStreamCount(), 0);
    await orchestrator.cleanup();
  });

  it('does not let a displaced incomplete inspection mutate the replacement opening', async () => {
    const inspector = new DeferredInspector();
    const { orchestrator, formatStore } = create(inspector);
    assert.equal(provision(orchestrator, SOURCE_A), true);
    const pendingA = media(orchestrator, SOURCE_A, 0);
    assert.equal(orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    assert.equal(provision(orchestrator, SOURCE_B), true);
    const pendingB = media(orchestrator, SOURCE_B, 0);

    inspector.resolve({ kind: 'incomplete' });
    assert.deepEqual(await pendingA, { accepted: false, reason: 'stale_source' });
    assert.deepEqual(
      formatStore.read({
        adminStreamId: ADMIN_STREAM_ID,
        runNumber: 1,
        streamId: STREAM_ID,
        topic: 'managed-format-topic',
        rendition: null,
      })?.source,
      SOURCE_B,
    );
    inspector.resolve({ kind: 'valid', fingerprint: FORMAT });
    assert.deepEqual(await pendingB, { accepted: true });
    await orchestrator.cleanup();
  });

  it('shares one in-flight inspection and durably refuses a changed reconnect format', async () => {
    const inspector = new DeferredInspector();
    const { orchestrator, formatStore } = create(inspector);
    assert.equal(provision(orchestrator, SOURCE_A), true);
    const first = media(orchestrator, SOURCE_A, 0);
    const second = media(orchestrator, SOURCE_A, 1);
    assert.deepEqual(await media(orchestrator, SOURCE_A, 2), {
      accepted: false,
      reason: 'unverified_source_media',
    });
    assert.equal(inspector.calls, 1);
    inspector.resolve({ kind: 'valid', fingerprint: FORMAT });
    assert.deepEqual(await first, { accepted: true });
    assert.deepEqual(await second, { accepted: true });

    assert.equal(orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    assert.equal(provision(orchestrator, SOURCE_B), true);
    const changed = media(orchestrator, SOURCE_B, 0);
    inspector.resolve({
      kind: 'valid',
      fingerprint: {
        ...FORMAT,
        tracks: [AUDIO_FORMAT_TRACK, { ...VIDEO_FORMAT_TRACK, width: 1920 }],
      },
    });
    assert.deepEqual(await changed, { accepted: false, reason: 'unverified_source_media' });
    assert.deepEqual(
      formatStore.read({
        adminStreamId: ADMIN_STREAM_ID,
        runNumber: 1,
        streamId: STREAM_ID,
        topic: 'managed-format-topic',
        rendition: null,
      })?.baseline,
      FORMAT,
    );
    await orchestrator.cleanup();
  });

  it('retries a full retained opening after the bounded probe pool was busy', async () => {
    let calls = 0;
    const inspector: MediaFormatInspector = {
      inspect: async () => (++calls === 1 ? { kind: 'busy' } : { kind: 'valid', fingerprint: FORMAT }),
    };
    const opening = videoSegment(4, 0);
    const { orchestrator } = create(inspector, new FakeClock(), opening.length);
    assert.equal(provision(orchestrator, SOURCE_A), true);

    assert.deepEqual(await media(orchestrator, SOURCE_A, 0), {
      accepted: false,
      reason: 'unverified_source_media',
    });
    assert.deepEqual(await media(orchestrator, SOURCE_A, 1), { accepted: true });
    assert.equal(calls, 2);
    await orchestrator.cleanup();
  });

  it('checks an ABR source opening and each rung against its frozen dimensions', async () => {
    const inspected: MediaFormatFingerprint[] = [
      FORMAT,
      {
        ...FORMAT,
        tracks: [AUDIO_FORMAT_TRACK, { ...VIDEO_FORMAT_TRACK, width: 854, height: 480 }],
      },
    ];
    const inspector: MediaFormatInspector = {
      inspect: async () => ({ kind: 'valid', fingerprint: inspected.shift() as MediaFormatFingerprint }),
    };
    const clock = new FakeClock();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-format-validation-'));
    roots.push(root);
    const formatStore = new ManagedFormatStore(path.join(root, 'formats'));
    const orchestrator = makeTestOrchestrator({
      clock,
      wallClock: () => 1_000_000 + clock.now(),
      managedSourceReconnectMs: RECONNECT_MS,
      managedRunStore: new MemoryManagedRuns(),
      managedCheckpointStore: new MemoryManagedCheckpoints(),
      managedFormatStore: formatStore,
      mediaFormatInspector: inspector,
      ladder: AbrLadder.parse('360p:640:360:700'),
    });
    const topic = 'managed-format-topic';
    assert.equal(
      orchestrator.prepareManagedRun({
        lifecycleVersion: 1,
        streamId: STREAM_ID,
        adminStreamId: ADMIN_STREAM_ID,
        topic,
        mediaType: MEDIA_TYPE_VIDEO,
        revision: 1,
        runNumber: 1,
        uploaderId: 'uploader-a',
        claimId: '22222222-2222-4222-8222-222222222222',
        eventSequence: 1,
        expectedRenditions: [
          {
            name: '360p',
            topic: rungTopicFor(topic, '360p'),
            width: 640,
            height: 360,
            bandwidth: 700_000,
            avgBandwidth: 700_000,
          },
        ],
      }),
      true,
    );
    assert.equal(provision(orchestrator, SOURCE_A), true);
    assert.deepEqual(await orchestrator.handleManagedSourceProgress(STREAM_ID, SOURCE_A, 0.1, videoSegment(4, 0), 0), {
      accepted: true,
    });
    const rungId = `${STREAM_ID}_360p`;
    assert.equal(
      orchestrator.provisionManagedRendition(
        rungId,
        STREAM_ID,
        SOURCE_A,
        MEDIA_TYPE_VIDEO,
        { address: '127.0.0.1', isAuthenticated: true },
        { id: ADMIN_STREAM_ID, topic },
      ),
      true,
    );
    assert.deepEqual(
      await orchestrator.handleManagedRenditionSegment(rungId, STREAM_ID, SOURCE_A, 0, 0.1, videoSegment(4, 0)),
      { accepted: false, reason: 'unverified_source_media' },
    );
    await orchestrator.cleanup();
  });
});
