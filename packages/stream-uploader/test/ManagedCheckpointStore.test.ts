import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  ManagedCheckpointFileOps,
  ManagedCheckpointStore,
  ManagedCompletedRecording,
  ManagedContinuationOperation,
  ManagedEmptyOutcome,
  ManagedTrackFinalization,
} from '../src/libs/ManagedCheckpointStore.js';
import { StreamState } from '../src/types.js';

const roots: string[] = [];
const ADMIN_STREAM_ID = '22222222-2222-4222-8222-222222222222';
const TOPIC = 'a'.repeat(64);
const RUNG_TOPIC = 'b'.repeat(64);
const REFERENCES = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64), '5'.repeat(64)];
const CHECKPOINT_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222223',
  '33333333-3333-4333-8333-333333333333',
];

afterEach(() => {
  for (const root of roots.splice(0)) {fs.rmSync(root, { recursive: true, force: true });}
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-checkpoint-store-'));
  roots.push(root);
  return root;
}

function trackState(run: number, preceding: StreamState | undefined, reference: string): StreamState {
  const previous = preceding?.segments ?? [];
  const index = previous.length;
  return {
    streamId: 'video/11111111-1111-4111-8111-111111111111_360p',
    streamRawTopic: RUNG_TOPIC,
    mediatype: 'video',
    socIndex: run * 10,
    segments: [...previous, { index, sequence: index, duration: 2, ref: reference, discontinuity: index > 0 }],
    hlsHeaders: ['#EXTM3U'],
    isFirstSegmentReady: true,
    isFirstManifestReady: true,
    updatedAt: run * 1_000,
  };
}

function finalized(run: number, state: StreamState, reference: string): ManagedTrackFinalization {
  return {
    streamId: state.streamId,
    rendition: '360p',
    state,
    manifest: {
      name: '360p',
      topic: RUNG_TOPIC,
      index: run * 10,
      reference,
      duration: state.segments.reduce((total, segment) => total + segment.duration, 0),
      width: 640,
      height: 360,
      bandwidth: 800_000,
      avgBandwidth: 700_000,
    },
  };
}

function operation(
  previousRunNumber: number,
  retainedRecording?: ManagedCompletedRecording,
  previousEmptyOutcome?: ManagedEmptyOutcome,
): ManagedContinuationOperation {
  return {
    lifecycleVersion: 1,
    operationId: '88888888-8888-4888-8888-888888888888',
    requestId: '77777777-7777-4777-8777-777777777777',
    streamId: ADMIN_STREAM_ID,
    topic: TOPIC,
    mediaType: 'video',
    uploaderId: 'srs-157-90-34-105',
    previousRunNumber,
    nextRunNumber: previousRunNumber + 1,
    revision: previousRunNumber + 10,
    status: 'pending',
    retainedRecording,
    previousEmptyOutcome,
  };
}

describe('ManagedCheckpointStore', () => {
  it('rebuilds cumulative A+B+C state in three fresh processes with stable feed topics', () => {
    const root = tempRoot();
    const ids = [...CHECKPOINT_IDS];
    const storeA = new ManagedCheckpointStore(root, undefined, () => ids.shift()!);
    const checkpointA = storeA.createRun({
      adminStreamId: ADMIN_STREAM_ID,
      runNumber: 1,
      topic: TOPIC,
      mediaType: 'video',
      expectedRenditions: [
        { name: '360p', topic: RUNG_TOPIC, width: 640, height: 360, bandwidth: 800_000, avgBandwidth: 700_000 },
      ],
    });
    const stateA = trackState(1, undefined, REFERENCES[0]);
    storeA.saveTrack(checkpointA.checkpointReference, finalized(1, stateA, REFERENCES[1]));
    const recordingA = storeA.complete(checkpointA.checkpointReference, {
      topic: TOPIC,
      index: 11,
      reference: REFERENCES[2],
      duration: 2,
    });

    const storeB = new ManagedCheckpointStore(root, undefined, () => ids.shift()!);
    const checkpointB = storeB.prepare(operation(1, recordingA));
    assert.notEqual(checkpointB.checkpointReference, checkpointA.checkpointReference);
    assert.equal(checkpointB.tracks[0].state.streamRawTopic, RUNG_TOPIC);
    assert.throws(
      () =>
        storeB.complete(checkpointB.checkpointReference, {
          topic: TOPIC,
          index: 20,
          reference: REFERENCES[2],
          duration: 2,
        }),
      /expected rendition 360p/i,
      'the predecessor final reference counted as the new run finalization',
    );
    const stateB = trackState(2, checkpointB.tracks[0].state, REFERENCES[3]);
    storeB.saveTrack(checkpointB.checkpointReference, finalized(2, stateB, REFERENCES[1]));
    const recordingB = storeB.complete(checkpointB.checkpointReference, {
      topic: TOPIC,
      index: 21,
      reference: REFERENCES[2],
      duration: 4,
    });

    const storeC = new ManagedCheckpointStore(root, undefined, () => ids.shift()!);
    const checkpointC = storeC.prepare(operation(2, recordingB));
    const stateC = trackState(3, checkpointC.tracks[0].state, REFERENCES[4]);
    storeC.saveTrack(checkpointC.checkpointReference, finalized(3, stateC, REFERENCES[1]));
    const recordingC = storeC.complete(checkpointC.checkpointReference, {
      topic: TOPIC,
      index: 31,
      reference: REFERENCES[2],
      duration: 6,
    });

    assert.deepEqual(
      new ManagedCheckpointStore(root).read(checkpointC.checkpointReference)?.tracks[0].state.segments.map((s) => s.ref),
      [REFERENCES[0], REFERENCES[3], REFERENCES[4]],
    );
    assert.equal(recordingC.runNumber, 3);
    assert.equal(recordingC.master.topic, TOPIC);
    assert.equal(recordingC.renditions[0].topic, RUNG_TOPIC);
  });

  it('refuses continuation when the retained public snapshot does not match the frozen checkpoint', () => {
    const root = tempRoot();
    const store = new ManagedCheckpointStore(root, undefined, () => CHECKPOINT_IDS[0]);
    const checkpoint = store.createRun({
      adminStreamId: ADMIN_STREAM_ID,
      runNumber: 1,
      topic: TOPIC,
      mediaType: 'video',
      expectedRenditions: [
        { name: '360p', topic: RUNG_TOPIC, width: 640, height: 360, bandwidth: 800_000, avgBandwidth: 700_000 },
      ],
    });
    const stateA = trackState(1, undefined, REFERENCES[0]);
    store.saveTrack(checkpoint.checkpointReference, finalized(1, stateA, REFERENCES[1]));
    const recording = store.complete(checkpoint.checkpointReference, {
      topic: TOPIC,
      index: 11,
      reference: REFERENCES[2],
      duration: 2,
    });

    assert.throws(
      () =>
        store.prepare(
          operation(1, {
            ...recording,
            renditions: [{ ...recording.renditions[0], reference: REFERENCES[4] }],
          }),
        ),
      /does not match/i,
    );
  });

  it('refuses completion until every expected rendition has a final reference', () => {
    const root = tempRoot();
    const store = new ManagedCheckpointStore(root, undefined, () => CHECKPOINT_IDS[0]);
    const checkpoint = store.createRun({
      adminStreamId: ADMIN_STREAM_ID,
      runNumber: 1,
      topic: TOPIC,
      mediaType: 'video',
      expectedRenditions: [
        { name: '360p', topic: RUNG_TOPIC, width: 640, height: 360, bandwidth: 800_000, avgBandwidth: 700_000 },
        {
          name: '720p',
          topic: 'c'.repeat(64),
          width: 1280,
          height: 720,
          bandwidth: 2_800_000,
          avgBandwidth: 2_800_000,
        },
      ],
    });
    const stateA = trackState(1, undefined, REFERENCES[0]);
    store.saveTrack(checkpoint.checkpointReference, finalized(1, stateA, REFERENCES[1]));

    assert.throws(
      () =>
        store.complete(checkpoint.checkpointReference, {
          topic: TOPIC,
          index: 11,
          reference: REFERENCES[2],
          duration: 2,
        }),
      /expected rendition 720p/i,
    );
  });

  it('does not reuse a run checkpoint with different frozen rendition input', () => {
    const root = tempRoot();
    const store = new ManagedCheckpointStore(root, undefined, () => CHECKPOINT_IDS[0]);
    const input = {
      adminStreamId: ADMIN_STREAM_ID,
      runNumber: 1,
      topic: TOPIC,
      mediaType: 'video' as const,
      expectedRenditions: [
        { name: '360p', topic: RUNG_TOPIC, width: 640, height: 360, bandwidth: 800_000, avgBandwidth: 700_000 },
      ],
    };
    store.createRun(input);

    assert.throws(
      () => store.createRun({ ...input, expectedRenditions: [{ ...input.expectedRenditions[0], topic: 'c'.repeat(64) }] }),
      /different immutable input/i,
    );
  });

  it('does not acknowledge a checkpoint whose durable save fails', () => {
    const root = tempRoot();
    const store = new ManagedCheckpointStore(root, faultingOps('checkpoint'), () => CHECKPOINT_IDS[0]);

    assert.throws(
      () =>
        store.createRun({
          adminStreamId: ADMIN_STREAM_ID,
          runNumber: 1,
          topic: TOPIC,
          mediaType: 'video',
          expectedRenditions: [],
        }),
      /injected checkpoint flush failure/,
    );
  });

  it('does not acknowledge a new run until its durable lookup index is flushed', () => {
    const root = tempRoot();
    const input = {
      adminStreamId: ADMIN_STREAM_ID,
      runNumber: 1,
      topic: TOPIC,
      mediaType: 'video' as const,
      expectedRenditions: [],
    };
    const store = new ManagedCheckpointStore(root, faultingOps('index'), () => CHECKPOINT_IDS[0]);

    assert.throws(() => store.createRun(input), /injected run index flush failure/);
    assert.equal(
      new ManagedCheckpointStore(root, undefined, () => CHECKPOINT_IDS[1]).createRun(input).checkpointReference,
      CHECKPOINT_IDS[0],
      'a retry found the unacknowledged checkpoint instead of allocating another one',
    );
  });

  it('keeps a completed checkpoint immutable under delayed finalization callbacks', () => {
    const root = tempRoot();
    const store = new ManagedCheckpointStore(root, undefined, () => CHECKPOINT_IDS[0]);
    const checkpoint = store.createRun({
      adminStreamId: ADMIN_STREAM_ID,
      runNumber: 1,
      topic: TOPIC,
      mediaType: 'video',
      expectedRenditions: [
        { name: '360p', topic: RUNG_TOPIC, width: 640, height: 360, bandwidth: 800_000, avgBandwidth: 700_000 },
      ],
    });
    const stateA = trackState(1, undefined, REFERENCES[0]);
    const trackA = finalized(1, stateA, REFERENCES[1]);
    store.saveTrack(checkpoint.checkpointReference, trackA);
    const recording = store.complete(checkpoint.checkpointReference, {
      topic: TOPIC,
      index: 11,
      reference: REFERENCES[2],
      duration: 2,
    });
    const sealedBytes = fs.readFileSync(path.join(root, `${checkpoint.checkpointReference}.json`));

    assert.equal(store.saveTrack(checkpoint.checkpointReference, trackA).status, 'complete');
    assert.deepEqual(
      store.complete(checkpoint.checkpointReference, recording.master),
      recording,
      'an exact completion retry returns the sealed result',
    );
    assert.throws(
      () =>
        store.saveTrack(
          checkpoint.checkpointReference,
          finalized(2, trackState(2, stateA, REFERENCES[3]), REFERENCES[4]),
        ),
      /complete/i,
    );
    assert.throws(
      () => store.complete(checkpoint.checkpointReference, { ...recording.master, reference: REFERENCES[4] }),
      /complete/i,
    );
    assert.deepEqual(fs.readFileSync(path.join(root, `${checkpoint.checkpointReference}.json`)), sealedBytes);
  });

  it('compares retained snapshots and exact retries independently of object key order', () => {
    const root = tempRoot();
    const ids = [...CHECKPOINT_IDS];
    const first = new ManagedCheckpointStore(root, undefined, () => ids.shift()!);
    const runA = first.createRun({
      adminStreamId: ADMIN_STREAM_ID,
      runNumber: 1,
      topic: TOPIC,
      mediaType: 'video',
      expectedRenditions: [
        { name: '360p', topic: RUNG_TOPIC, width: 640, height: 360, bandwidth: 800_000, avgBandwidth: 700_000 },
      ],
    });
    const stateA = trackState(1, undefined, REFERENCES[0]);
    first.saveTrack(runA.checkpointReference, finalized(1, stateA, REFERENCES[1]));
    const recordingA = first.complete(runA.checkpointReference, {
      topic: TOPIC,
      index: 11,
      reference: REFERENCES[2],
      duration: 2,
    });
    const reorderedRecording: ManagedCompletedRecording = {
      renditions: recordingA.renditions.map((rendition) => ({
        avgBandwidth: rendition.avgBandwidth,
        bandwidth: rendition.bandwidth,
        height: rendition.height,
        width: rendition.width,
        duration: rendition.duration,
        reference: rendition.reference,
        index: rendition.index,
        topic: rendition.topic,
        name: rendition.name,
      })),
      expectedRenditions: [...recordingA.expectedRenditions],
      master: {
        duration: recordingA.master.duration,
        reference: recordingA.master.reference,
        index: recordingA.master.index,
        topic: recordingA.master.topic,
      },
      checkpointReference: recordingA.checkpointReference,
      runNumber: recordingA.runNumber,
    };

    const second = new ManagedCheckpointStore(root, undefined, () => ids.shift()!);
    const runB = second.prepare(operation(1, reorderedRecording));
    second.saveTrack(runB.checkpointReference, finalized(1, stateA, REFERENCES[1]));
    const recordingB = second.complete(runB.checkpointReference, recordingA.master);

    assert.deepEqual(
      second.complete(runB.checkpointReference, {
        duration: recordingB.master.duration,
        reference: recordingB.master.reference,
        index: recordingB.master.index,
        topic: recordingB.master.topic,
      }),
      recordingB,
    );
  });

  it('refuses to allocate fresh state when a known run checkpoint is corrupt', () => {
    const root = tempRoot();
    const store = new ManagedCheckpointStore(root, undefined, () => CHECKPOINT_IDS[0]);
    const input = {
      adminStreamId: ADMIN_STREAM_ID,
      runNumber: 1,
      topic: TOPIC,
      mediaType: 'video' as const,
      expectedRenditions: [],
    };
    const checkpoint = store.createRun(input);
    fs.writeFileSync(path.join(root, `${checkpoint.checkpointReference}.json`), '{broken');

    assert.throws(
      () => new ManagedCheckpointStore(root, undefined, () => CHECKPOINT_IDS[1]).createRun(input),
      /missing or unreadable|corrupt/i,
    );
  });

  it('prepares after a first verified-empty run without inventing a recording', () => {
    const root = tempRoot();
    const ids = [...CHECKPOINT_IDS];
    const first = new ManagedCheckpointStore(root, undefined, () => ids.shift()!);
    const run1 = first.createRun({
      adminStreamId: ADMIN_STREAM_ID,
      runNumber: 1,
      topic: TOPIC,
      mediaType: 'video',
      expectedRenditions: [
        { name: '360p', topic: RUNG_TOPIC, width: 640, height: 360, bandwidth: 800_000, avgBandwidth: 700_000 },
      ],
    });
    const empty = first.sealEmpty(run1.checkpointReference, 0);

    const run2 = new ManagedCheckpointStore(root, undefined, () => ids.shift()!).prepare(operation(1, undefined, empty));

    assert.equal(run2.runNumber, 2);
    assert.equal(run2.previousCheckpointReference, run1.checkpointReference);
    assert.equal(run2.tracks.length, 0);
    assert.equal(run2.expectedRenditions[0].topic, RUNG_TOPIC);
  });

  it('keeps A as the retained replay after an empty B when preparing C', () => {
    const root = tempRoot();
    const ids = [...CHECKPOINT_IDS];
    const first = new ManagedCheckpointStore(root, undefined, () => ids.shift()!);
    const runA = first.createRun({
      adminStreamId: ADMIN_STREAM_ID,
      runNumber: 1,
      topic: TOPIC,
      mediaType: 'video',
      expectedRenditions: [
        { name: '360p', topic: RUNG_TOPIC, width: 640, height: 360, bandwidth: 800_000, avgBandwidth: 700_000 },
      ],
    });
    const stateA = trackState(1, undefined, REFERENCES[0]);
    first.saveTrack(runA.checkpointReference, finalized(1, stateA, REFERENCES[1]));
    const recordingA = first.complete(runA.checkpointReference, {
      topic: TOPIC,
      index: 11,
      reference: REFERENCES[2],
      duration: 2,
    });

    const second = new ManagedCheckpointStore(root, undefined, () => ids.shift()!);
    const runB = second.prepare(operation(1, recordingA));
    const emptyB = second.sealEmpty(runB.checkpointReference, 0);
    const runC = new ManagedCheckpointStore(root, undefined, () => ids.shift()!).prepare(
      operation(2, recordingA, emptyB),
    );

    assert.equal(runC.previousCheckpointReference, runB.checkpointReference);
    assert.deepEqual(runC.tracks[0].state.segments.map((segment) => segment.ref), [REFERENCES[0]]);
    assert.deepEqual(runC.retainedRecording, recordingA);
  });

  it('does not seal accepted media as empty when every upload failed', () => {
    const root = tempRoot();
    const store = new ManagedCheckpointStore(root, undefined, () => CHECKPOINT_IDS[0]);
    const run = store.createRun({
      adminStreamId: ADMIN_STREAM_ID,
      runNumber: 1,
      topic: TOPIC,
      mediaType: 'video',
      expectedRenditions: [],
    });

    assert.throws(() => store.sealEmpty(run.checkpointReference, 1), /accepted media/i);
    assert.equal(store.read(run.checkpointReference)?.status, 'prepared');
  });
});

function faultingOps(fault: 'checkpoint' | 'index'): ManagedCheckpointFileOps {
  const opened = new Map<number, string>();
  return {
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
      const target = opened.get(fd) ?? '';
      if (fault === 'checkpoint' && target.endsWith('.json.tmp')) {
        throw new Error('injected checkpoint flush failure');
      }
      if (fault === 'index' && target.endsWith('.index.tmp')) {
        throw new Error('injected run index flush failure');
      }
      fs.fsyncSync(fd);
    },
    closeSync: (fd) => {
      opened.delete(fd);
      fs.closeSync(fd);
    },
    renameSync: (from, to) => fs.renameSync(from, to),
  };
}
