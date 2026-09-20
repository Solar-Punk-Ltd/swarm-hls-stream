import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';

import { ManagedMediaFileOps, ManagedMediaStore } from '../src/libs/ManagedMediaStore.js';
import {
  MANAGED_RUN_LOADED,
  MANAGED_RUN_MISSING,
  ManagedRunEntry,
  ManagedRunPersistence,
  ManagedRunRecord,
} from '../src/libs/ManagedRunStore.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { StreamUploader } from '../src/libs/StreamUploader.js';
import {
  MEDIA_TYPE_AUDIO,
  MEDIA_TYPE_VIDEO,
  MediaType,
  SourceConnectionIdentity,
  STREAM_STATUS_VOD,
  StreamState,
} from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import { makeFakeRecoveryStore, makeRecordingCatalog, makeTestOrchestrator } from './helpers/fakes.js';
import { MemoryManagedCheckpoints } from './helpers/managedCheckpoint.js';
import { audioOnlySegment, FRAME_TICKS, videoSegment } from './helpers/transportStream.js';
import { waitFor } from './helpers/waiting.js';

const STREAM_ID = 'video/managed-stream';
const RECONNECT_MS = 60_000;
const SETTLE_CEILING_MS = 4_000;
const ADMIN_SESSION = { id: '22222222-2222-4222-8222-222222222222', topic: 'a'.repeat(64) };
const CLAIMANT = { address: '198.51.100.7', isAuthenticated: true };
const SOURCE_A: SourceConnectionIdentity = {
  serverId: 'srs-1',
  serviceId: 'service-1',
  clientId: 'client-a',
  generation: 1,
};
const SOURCE_B: SourceConnectionIdentity = {
  serverId: 'srs-1',
  serviceId: 'service-1',
  clientId: 'client-b',
  generation: 2,
};
const SOURCE_C: SourceConnectionIdentity = {
  serverId: 'srs-2',
  serviceId: 'service-2',
  clientId: 'client-c',
  generation: 3,
};

interface OrchestratorInternals {
  activeStreams: Map<string, StreamUploader>;
}

class MemoryManagedRuns implements ManagedRunPersistence {
  private records = new Map<string, ManagedRunRecord>();

  public save(record: ManagedRunRecord): void {
    this.records.set(record.streamId, structuredClone(record));
  }

  public read(streamId: string): ManagedRunEntry {
    const record = this.records.get(streamId);
    return record ? { kind: MANAGED_RUN_LOADED, record } : { kind: MANAGED_RUN_MISSING };
  }

  public list(): string[] {
    return [...this.records.keys()];
  }

  public current(streamId: string): ManagedRunRecord | undefined {
    return this.records.get(streamId);
  }
}

const checkpointsByRunStore = new WeakMap<ManagedRunPersistence, MemoryManagedCheckpoints>();

function activeUploader(orchestrator: StreamOrchestrator): StreamUploader | undefined {
  return (orchestrator as unknown as OrchestratorInternals).activeStreams.get(STREAM_ID);
}

function makeManagedOrchestrator(
  clock: FakeClock,
  published: unknown[] = [],
  saved: StreamState[] = [],
  maxQueueSize = 100,
  mediaType: MediaType = MEDIA_TYPE_VIDEO,
  managedMediaStore?: ManagedMediaStore,
  uploads: Parameters<typeof makeTestOrchestrator>[1] = {},
  managedRunStore: ManagedRunPersistence = new MemoryManagedRuns(),
): StreamOrchestrator {
  let managedCheckpointStore = checkpointsByRunStore.get(managedRunStore);
  if (!managedCheckpointStore) {
    managedCheckpointStore = new MemoryManagedCheckpoints();
    checkpointsByRunStore.set(managedRunStore, managedCheckpointStore);
  }
  const orchestrator = makeTestOrchestrator(
    {
      clock,
      wallClock: () => 1_000_000 + clock.now(),
      managedSourceReconnectMs: RECONNECT_MS,
      managedRunStore,
      managedCheckpointStore,
      managedMediaStore,
      maxQueueSize,
    },
    uploads,
    makeFakeRecoveryStore({
      save: (_streamId: string, state: StreamState) => saved.push(state),
    }),
    makeRecordingCatalog(published),
  );
  assert.equal(
    orchestrator.prepareManagedRun({
      lifecycleVersion: 1,
      streamId: STREAM_ID,
      adminStreamId: ADMIN_SESSION.id,
      topic: ADMIN_SESSION.topic,
      mediaType,
      revision: 8,
      runNumber: 2,
      uploaderId: 'srs-157-90-34-105',
      claimId: '44444444-4444-4444-8444-444444444444',
      eventSequence: 1,
      expectedRenditions: [],
    }),
    true,
  );
  return orchestrator;
}

function provision(
  orchestrator: StreamOrchestrator,
  source: SourceConnectionIdentity,
  mediatype = MEDIA_TYPE_VIDEO,
): boolean {
  return orchestrator.provisionManagedSource(STREAM_ID, mediatype, source, CLAIMANT, ADMIN_SESSION);
}

function media(orchestrator: StreamOrchestrator, source: SourceConnectionIdentity, index: number, firstPts?: number) {
  return orchestrator.handleManagedSegment(
    STREAM_ID,
    source,
    index,
    0.1,
    videoSegment(4, firstPts ?? index * 4 * FRAME_TICKS),
  );
}

describe('managed SRS source reconnect foundation', () => {
  it('does not create or replace an uploader from a provisional publish callback alone', async () => {
    const clock = new FakeClock();
    const orchestrator = makeManagedOrchestrator(clock);

    assert.equal(provision(orchestrator, SOURCE_A), true);
    assert.equal(orchestrator.getActiveStreamCount(), 0, 'on_publish alone was treated as source acquisition');

    await clock.advance(RECONNECT_MS);

    assert.equal(orchestrator.getActiveStreamCount(), 0);
    assert.deepEqual(
      media(orchestrator, SOURCE_A, 0),
      { accepted: false, reason: 'stale_source' },
      'media from a provisional source was accepted after its bounded acquisition window',
    );
    await orchestrator.cleanup();
  });

  it('releases a disconnected provisional source without resetting the original acquisition budget', async () => {
    const clock = new FakeClock();
    const runs = new MemoryManagedRuns();
    const orchestrator = makeManagedOrchestrator(clock, [], [], 100, MEDIA_TYPE_VIDEO, undefined, {}, runs);

    assert.equal(provision(orchestrator, SOURCE_A), true);
    await clock.advance(10_000);
    assert.equal(orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    assert.equal(provision(orchestrator, SOURCE_B), true);
    assert.equal(runs.current(STREAM_ID)?.deadlineWallMs, 1_000_000 + RECONNECT_MS);
    assert.deepEqual(media(orchestrator, SOURCE_B, 0), { accepted: true });
    assert.equal(runs.current(STREAM_ID)?.deadlineWallMs, 1_000_000 + 10_000 + RECONNECT_MS);

    await orchestrator.cleanup();
  });

  it('keeps one uploader and its history when B returns with media inside A\'s grace window', async () => {
    const clock = new FakeClock();
    const published: { state?: string }[] = [];
    const saved: StreamState[] = [];
    const orchestrator = makeManagedOrchestrator(clock, published, saved);

    assert.equal(provision(orchestrator, SOURCE_A), true);
    assert.deepEqual(media(orchestrator, SOURCE_A, 0), { accepted: true });
    const uploaderA = activeUploader(orchestrator);
    assert.ok(uploaderA, 'verified media must create the first uploader');
    const notifyStop = mock.method(uploaderA, 'notifyStop');

    assert.equal(orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    await clock.advance(RECONNECT_MS - 1);

    assert.equal(provision(orchestrator, SOURCE_B), true);
    assert.equal(activeUploader(orchestrator), uploaderA, 'a provisional reconnect replaced the incumbent uploader');
    assert.deepEqual(media(orchestrator, SOURCE_B, 0), { accepted: true });

    assert.equal(activeUploader(orchestrator), uploaderA, 'verified reconnect media did not reuse the uploader');
    assert.equal(notifyStop.mock.callCount(), 0, 'the in-grace interruption called notifyStop early');
    assert.equal(
      published.filter((entry) => entry.state === STREAM_STATUS_VOD).length,
      0,
      'the in-grace interruption finalized an early VOD',
    );
    await waitFor(() => saved.length >= 2, SETTLE_CEILING_MS);
    assert.ok(saved.length >= 2, 'both sides of the interruption must persist through the same uploader history');
    assert.equal(new Set(saved.map((state) => state.streamRawTopic)).size, 1, 'the reconnect changed feed history');
    await orchestrator.cleanup();
  });

  it('ignores a busy-refused B and its provisional unpublish, then lets A enter waiting', async () => {
    const clock = new FakeClock();
    const orchestrator = makeManagedOrchestrator(clock);

    assert.equal(provision(orchestrator, SOURCE_A), true);
    assert.deepEqual(media(orchestrator, SOURCE_A, 0), { accepted: true });
    const uploaderA = activeUploader(orchestrator);
    assert.ok(uploaderA);
    const notifyStop = mock.method(uploaderA, 'notifyStop');

    assert.equal(provision(orchestrator, SOURCE_B), false, 'an overlap was admitted while A was still attached');
    assert.equal(activeUploader(orchestrator), uploaderA, 'the refused B retired or replaced A');
    assert.equal(notifyStop.mock.callCount(), 0, 'the refused B finalized A');
    assert.equal(
      orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_B),
      false,
      'a provisional SRT unpublish was mistaken for the incumbent source leaving',
    );
    assert.equal(activeUploader(orchestrator), uploaderA, 'the provisional B unpublish retired A');

    assert.equal(orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    await clock.advance(RECONNECT_MS - 1);

    assert.equal(activeUploader(orchestrator), uploaderA, 'A was retired before its reconnect deadline');
    assert.equal(notifyStop.mock.callCount(), 0, 'A was finalized before its reconnect deadline');
    await orchestrator.cleanup();
  });

  it('finalizes once when the confirmed source reaches its reconnect deadline', async () => {
    const clock = new FakeClock();
    const published: { state?: string }[] = [];
    const orchestrator = makeManagedOrchestrator(clock, published);

    assert.equal(provision(orchestrator, SOURCE_A), true);
    assert.deepEqual(media(orchestrator, SOURCE_A, 0), { accepted: true });
    const uploaderA = activeUploader(orchestrator);
    assert.ok(uploaderA);
    const notifyStop = mock.method(uploaderA, 'notifyStop');

    assert.equal(orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    await clock.advance(RECONNECT_MS - 1);
    assert.equal(notifyStop.mock.callCount(), 0);

    await clock.advance(1);
    await waitFor(() => orchestrator.getActiveStreamCount() === 0, SETTLE_CEILING_MS);

    assert.equal(notifyStop.mock.callCount(), 1, 'the deadline finalized the source more than once');
    assert.equal(published.filter((entry) => entry.state === STREAM_STATUS_VOD).length, 1);
    assert.equal(provision(orchestrator, SOURCE_B), false, 'a closed managed run admitted a new source');
    await orchestrator.cleanup();
  });

  it('does not confirm a reconnect or renew its deadline from unusable source media', async () => {
    const clock = new FakeClock();
    const orchestrator = makeManagedOrchestrator(clock);

    assert.equal(provision(orchestrator, SOURCE_A), true);
    assert.deepEqual(media(orchestrator, SOURCE_A, 0), { accepted: true });
    const uploaderA = activeUploader(orchestrator);
    assert.ok(uploaderA);
    const notifyStop = mock.method(uploaderA, 'notifyStop');

    assert.equal(orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    assert.equal(provision(orchestrator, SOURCE_B), true);
    assert.deepEqual(
      orchestrator.handleManagedSegment(STREAM_ID, SOURCE_B, 0, 0, videoSegment(4)),
      { accepted: false, reason: 'unverified_source_media' },
      'a zero-duration callback confirmed the provisional source',
    );
    assert.deepEqual(
      orchestrator.handleManagedSegment(STREAM_ID, SOURCE_B, 0, 0.1, Buffer.alloc(188)),
      { accepted: false, reason: 'unverified_source_media' },
      'malformed bytes confirmed the provisional source',
    );

    await clock.advance(RECONNECT_MS);
    await waitFor(() => orchestrator.getActiveStreamCount() === 0, SETTLE_CEILING_MS);
    assert.equal(notifyStop.mock.callCount(), 1, 'invalid media renewed the original source deadline');
    assert.equal(provision(orchestrator, SOURCE_B), false, 'the expired run reopened after invalid media');
    await orchestrator.cleanup();
  });

  it('does not confirm a reconnect while the incumbent uploader queue refuses its media', async () => {
    const clock = new FakeClock();
    const orchestrator = makeManagedOrchestrator(clock, [], [], 1);

    assert.equal(provision(orchestrator, SOURCE_A), true);
    assert.deepEqual(media(orchestrator, SOURCE_A, 0), { accepted: true });
    const uploaderA = activeUploader(orchestrator);
    assert.ok(uploaderA);
    await uploaderA.segmentQueue.onIdle();
    const notifyStop = mock.method(uploaderA, 'notifyStop');

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = uploaderA.segmentQueue.add(() => held);
    const queued = uploaderA.segmentQueue.add(() => held);
    await waitFor(() => uploaderA.segmentQueue.size === 1, SETTLE_CEILING_MS);

    assert.equal(orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    assert.equal(provision(orchestrator, SOURCE_B), true);
    assert.deepEqual(
      media(orchestrator, SOURCE_B, 0),
      { accepted: false, reason: 'queue_full' },
      'a queue-refused segment confirmed the provisional source',
    );

    release();
    await Promise.all([running, queued]);
    await clock.advance(RECONNECT_MS);
    await waitFor(() => orchestrator.getActiveStreamCount() === 0, SETTLE_CEILING_MS);
    assert.equal(notifyStop.mock.callCount(), 1, 'a queue refusal renewed the original source deadline');
    await orchestrator.cleanup();
  });

  it('anchors the cutoff to the last verified media instead of a delayed unpublish callback', async () => {
    const clock = new FakeClock();
    const orchestrator = makeManagedOrchestrator(clock);

    assert.equal(provision(orchestrator, SOURCE_A), true);
    assert.deepEqual(media(orchestrator, SOURCE_A, 0), { accepted: true });
    const uploaderA = activeUploader(orchestrator);
    assert.ok(uploaderA);
    const notifyStop = mock.method(uploaderA, 'notifyStop');

    await clock.advance(20_000);
    assert.deepEqual(media(orchestrator, SOURCE_A, 1), { accepted: true });
    await clock.advance(24_000);
    assert.equal(orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);

    await clock.advance(35_999);
    assert.equal(notifyStop.mock.callCount(), 0, 'the source closed before 60 seconds without verified media');

    await clock.advance(1);
    await waitFor(() => orchestrator.getActiveStreamCount() === 0, SETTLE_CEILING_MS);
    assert.equal(notifyStop.mock.callCount(), 1, 'delayed unpublish extended the no-media cutoff');
    await orchestrator.cleanup();
  });

  it('does not renew the source deadline when later callbacks repeat the same timestamps', async () => {
    const clock = new FakeClock();
    const orchestrator = makeManagedOrchestrator(clock);

    assert.equal(provision(orchestrator, SOURCE_A), true);
    assert.deepEqual(media(orchestrator, SOURCE_A, 0, 0), { accepted: true });
    const uploaderA = activeUploader(orchestrator);
    assert.ok(uploaderA);
    const notifyStop = mock.method(uploaderA, 'notifyStop');

    await clock.advance(20_000);
    assert.deepEqual(media(orchestrator, SOURCE_A, 1, 0), {
      accepted: false,
      reason: 'unverified_source_media',
    });
    await clock.advance(20_000);
    assert.deepEqual(media(orchestrator, SOURCE_A, 2, 0), {
      accepted: false,
      reason: 'unverified_source_media',
    });

    await clock.advance(19_999);
    assert.equal(notifyStop.mock.callCount(), 0);
    await clock.advance(1);
    await waitFor(() => orchestrator.getActiveStreamCount() === 0, SETTLE_CEILING_MS);
    assert.equal(notifyStop.mock.callCount(), 1, 'repeated timestamps renewed the source deadline');
    await orchestrator.cleanup();
  });

  it('uses audio timestamps to verify an audio-only managed source', async () => {
    const clock = new FakeClock();
    const orchestrator = makeManagedOrchestrator(clock, [], [], 100, MEDIA_TYPE_AUDIO);

    assert.equal(provision(orchestrator, SOURCE_A, MEDIA_TYPE_AUDIO), true);
    assert.deepEqual(
      orchestrator.handleManagedSegment(STREAM_ID, SOURCE_A, 0, 0.1, audioOnlySegment(4, 0)),
      { accepted: true },
    );
    assert.deepEqual(
      orchestrator.handleManagedSegment(STREAM_ID, SOURCE_A, 1, 0.1, audioOnlySegment(4, 4 * FRAME_TICKS)),
      { accepted: true },
    );
    assert.ok(activeUploader(orchestrator), 'advancing audio did not acquire the source');
    await orchestrator.cleanup();
  });

  it('keeps advancing source timestamps valid across the 33-bit PTS wrap', async () => {
    const clock = new FakeClock();
    const orchestrator = makeManagedOrchestrator(clock);
    const ptsModulus = 2 ** 33;

    assert.equal(provision(orchestrator, SOURCE_A), true);
    assert.deepEqual(media(orchestrator, SOURCE_A, 0, ptsModulus - 4 * FRAME_TICKS), { accepted: true });
    assert.deepEqual(media(orchestrator, SOURCE_A, 1, 0), { accepted: true });
    await orchestrator.cleanup();
  });

  it('durably accepts managed bytes before acknowledging and removes them only after placed history is durable', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'managed-media-runtime-'));
    const clock = new FakeClock();
    const store = new ManagedMediaStore(root);
    const reference = 'a'.repeat(64);
    let finishUpload!: (value: unknown) => void;
    const upload = new Promise((resolve) => {
      finishUpload = resolve;
    });
    const orchestrator = makeManagedOrchestrator(clock, [], [], 100, MEDIA_TYPE_VIDEO, store, {
      uploadData: async () => upload,
    });

    try {
      assert.equal(provision(orchestrator, SOURCE_A), true);
      assert.deepEqual(media(orchestrator, SOURCE_A, 0), { accepted: true });

      const pending = store.listPending(ADMIN_SESSION.id, 2);
      assert.equal(pending.length, 1, 'the callback was acknowledged before its bytes were durable');
      assert.ok(store.readBytes(pending[0].token)?.equals(videoSegment(4, 0)));

      finishUpload({ reference: { toHex: () => reference } });
      const uploader = activeUploader(orchestrator);
      assert.ok(uploader);
      await uploader.segmentQueue.onIdle();

      const committed = store.listRun(ADMIN_SESSION.id, 2);
      assert.equal(committed[0].status, 'committed');
      assert.equal(committed[0].reference, reference);
      assert.equal(store.readBytes(committed[0].token), null, 'raw bytes survived durable placement');
      assert.equal(store.readTrackState(ADMIN_SESSION.id, 2, STREAM_ID, null)?.segments[0].ref, reference);
    } finally {
      await orchestrator.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns a durability failure when the raw callback cannot be flushed', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'managed-media-runtime-'));
    const opened = new Map<number, string>();
    const ops: ManagedMediaFileOps = {
      mkdirSync: (target, options) => fs.mkdirSync(target, options),
      existsSync: (target) => fs.existsSync(target),
      readdirSync: (target) => fs.readdirSync(target),
      readFileSync: (target) => fs.readFileSync(target),
      openSync: (target, flags, mode) => {
        const fd = fs.openSync(target, flags, mode);
        opened.set(fd, target);
        return fd;
      },
      writeFileSync: (fd, data) => fs.writeFileSync(fd, data),
      fsyncSync: (fd) => {
        if (opened.get(fd)?.endsWith('.bin.tmp')) {
          throw new Error('injected raw byte flush failure');
        }
        fs.fsyncSync(fd);
      },
      closeSync: (fd) => {
        opened.delete(fd);
        fs.closeSync(fd);
      },
      renameSync: (from, to) => fs.renameSync(from, to),
      rmSync: (target) => fs.rmSync(target, { force: true }),
    };
    const clock = new FakeClock();
    const runs = new MemoryManagedRuns();
    const orchestrator = makeManagedOrchestrator(
      clock,
      [],
      [],
      100,
      MEDIA_TYPE_VIDEO,
      new ManagedMediaStore(root, ops),
      {},
      runs,
    );
    const disconnected: SourceConnectionIdentity[] = [];
    orchestrator.registerManagedSourceDisconnector((source) => disconnected.push(source));

    try {
      assert.equal(provision(orchestrator, SOURCE_A), true);
      assert.deepEqual(media(orchestrator, SOURCE_A, 0), {
        accepted: false,
        reason: 'durability_failed',
      });
      assert.equal(orchestrator.failManagedSource(STREAM_ID, SOURCE_A), true);
      assert.equal(runs.current(STREAM_ID)?.state, 'closed');
      assert.deepEqual(disconnected, [SOURCE_A]);
      assert.deepEqual(media(orchestrator, SOURCE_A, 0), {
        accepted: false,
        reason: 'stale_source',
      });
    } finally {
      await orchestrator.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps failed managed uploads pending and does not upload an exact duplicate twice', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'managed-media-runtime-'));
    const clock = new FakeClock();
    const store = new ManagedMediaStore(root);
    let attempts = 0;
    let refuseUpload!: (reason: unknown) => void;
    const upload = new Promise((_, reject) => {
      refuseUpload = reject;
    });
    const orchestrator = makeManagedOrchestrator(clock, [], [], 100, MEDIA_TYPE_VIDEO, store, {
      uploadData: async () => {
        attempts++;
        return upload;
      },
    });

    try {
      assert.equal(provision(orchestrator, SOURCE_A), true);
      assert.deepEqual(media(orchestrator, SOURCE_A, 0), { accepted: true });
      const uploader = activeUploader(orchestrator);
      assert.ok(uploader);
      assert.deepEqual(media(orchestrator, SOURCE_A, 0), { accepted: true });
      assert.equal(attempts, 1, 'an exact duplicate callback was uploaded twice while the first was queued');

      refuseUpload({ status: 400, message: 'refused' });
      await uploader.segmentQueue.onIdle();
      assert.equal(store.listPending(ADMIN_SESSION.id, 2).length, 1, 'a failed upload was treated as empty');
    } finally {
      await orchestrator.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replays pending A before reconnect B in a fresh process and keeps one cumulative track', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'managed-media-runtime-'));
    const clockA = new FakeClock();
    const runs = new MemoryManagedRuns();
    const storeA = new ManagedMediaStore(root);
    const processA = makeManagedOrchestrator(clockA, [], [], 100, MEDIA_TYPE_VIDEO, storeA, {
      uploadData: async () => {
        throw { status: 400, message: 'refused' };
      },
    }, runs);

    const uploaded: string[] = [];
    let reference = 0;
    const clockB = new FakeClock();
    const storeB = new ManagedMediaStore(root);
    const processB = makeTestOrchestrator(
      {
        clock: clockB,
        wallClock: () => 1_000_000 + clockB.now(),
        managedSourceReconnectMs: RECONNECT_MS,
        managedRunStore: runs,
        managedCheckpointStore: checkpointsByRunStore.get(runs),
        managedMediaStore: storeB,
      },
      {
        uploadData: async (_stamp, data) => {
          uploaded.push(Buffer.from(data).toString('hex'));
          return { reference: { toHex: () => String(++reference).padStart(64, '0') } };
        },
      },
      makeFakeRecoveryStore(),
      makeRecordingCatalog([]),
    );

    try {
      assert.equal(provision(processA, SOURCE_A), true);
      assert.deepEqual(media(processA, SOURCE_A, 0, 0), { accepted: true });
      const uploaderA = activeUploader(processA);
      assert.ok(uploaderA);
      await uploaderA.segmentQueue.onIdle();
      assert.equal(storeA.listPending(ADMIN_SESSION.id, 2).length, 1);

      assert.equal(processB.restoreManagedRun(STREAM_ID), MANAGED_RUN_LOADED);
      assert.equal(provision(processB, SOURCE_B), true);
      assert.deepEqual(media(processB, SOURCE_B, 0, 4 * FRAME_TICKS), { accepted: true });
      const uploaderB = activeUploader(processB);
      assert.ok(uploaderB);
      await uploaderB.segmentQueue.onIdle();

      assert.equal(uploaded.length, 2, 'the fresh process did not replay A before accepting B');
      assert.equal(storeB.listPending(ADMIN_SESSION.id, 2).length, 0);
      const history = storeB.readTrackState(ADMIN_SESSION.id, 2, STREAM_ID, null)?.segments;
      assert.equal(history?.length, 2);
      assert.equal(history?.[1].discontinuity, true, 'the recovered A to B seam was not marked');
    } finally {
      await processA.cleanup();
      await processB.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores committed A then appends B and C across fresh uploader processes', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'managed-media-runtime-'));
    const runs = new MemoryManagedRuns();
    let reference = 0;
    const uploads = {
      uploadData: async () => ({ reference: { toHex: () => String(++reference).padStart(64, '0') } }),
    };
    let finalProcess: StreamOrchestrator | undefined;

    const fresh = (clock: FakeClock, store: ManagedMediaStore) =>
      makeTestOrchestrator(
        {
          clock,
          wallClock: () => 1_000_000 + clock.now(),
          managedSourceReconnectMs: RECONNECT_MS,
          managedRunStore: runs,
          managedCheckpointStore: checkpointsByRunStore.get(runs),
          managedMediaStore: store,
        },
        uploads,
        makeFakeRecoveryStore(),
        makeRecordingCatalog([]),
      );

    try {
      const clockA = new FakeClock();
      const processA = makeManagedOrchestrator(
        clockA,
        [],
        [],
        100,
        MEDIA_TYPE_VIDEO,
        new ManagedMediaStore(root),
        uploads,
        runs,
      );
      assert.equal(provision(processA, SOURCE_A), true);
      assert.deepEqual(media(processA, SOURCE_A, 0, 0), { accepted: true });
      await activeUploader(processA)!.segmentQueue.onIdle();
      await waitFor(() => runs.current(STREAM_ID)?.state === 'live', SETTLE_CEILING_MS);

      const clockB = new FakeClock();
      const processB = fresh(clockB, new ManagedMediaStore(root));
      assert.equal(processB.restoreManagedRun(STREAM_ID), MANAGED_RUN_LOADED);
      assert.equal(processB.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
      assert.equal(provision(processB, SOURCE_B), true);
      assert.deepEqual(media(processB, SOURCE_B, 0, 4 * FRAME_TICKS), { accepted: true });
      await activeUploader(processB)!.segmentQueue.onIdle();
      await waitFor(
        () => runs.current(STREAM_ID)?.state === 'live' && runs.current(STREAM_ID)?.source?.clientId === 'client-b',
        SETTLE_CEILING_MS,
      );

      const clockC = new FakeClock();
      const storeC = new ManagedMediaStore(root);
      const processC = fresh(clockC, storeC);
      finalProcess = processC;
      assert.equal(processC.restoreManagedRun(STREAM_ID), MANAGED_RUN_LOADED);
      assert.equal(processC.markManagedSourceUnpublished(STREAM_ID, SOURCE_B), true);
      assert.equal(provision(processC, SOURCE_C), true);
      assert.deepEqual(media(processC, SOURCE_C, 0, 8 * FRAME_TICKS), { accepted: true });
      await activeUploader(processC)!.segmentQueue.onIdle();

      const history = storeC.readTrackState(ADMIN_SESSION.id, 2, STREAM_ID, null)?.segments;
      assert.equal(history?.length, 3);
      assert.deepEqual(history?.map((segment) => segment.ref), [
        '1'.padStart(64, '0'),
        '2'.padStart(64, '0'),
        '3'.padStart(64, '0'),
      ]);
      assert.equal(history?.[1].discontinuity, true);
      assert.equal(history?.[2].discontinuity, true);
    } finally {
      await finalProcess?.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
