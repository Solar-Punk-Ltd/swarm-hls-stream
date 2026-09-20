import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  ManagedMediaFileOps,
  ManagedMediaInput,
  ManagedMediaStore,
} from '../src/libs/ManagedMediaStore.js';
import { StreamState } from '../src/types.js';

const roots: string[] = [];
const ADMIN_STREAM_ID = '22222222-2222-4222-8222-222222222222';
const STREAM_ID = 'video/11111111-1111-4111-8111-111111111111_360p';

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-media-store-'));
  roots.push(root);
  return root;
}

function input(overrides: Partial<ManagedMediaInput> = {}): ManagedMediaInput {
  return {
    lifecycleVersion: 1,
    adminStreamId: ADMIN_STREAM_ID,
    runNumber: 2,
    streamId: STREAM_ID,
    source: {
      serverId: 'server-a',
      serviceId: 'service-a',
      clientId: 'client-a',
      generation: 1,
    },
    rendition: '360p',
    sequence: 7,
    duration: 2,
    discontinuity: false,
    ...overrides,
  };
}

function state(reference = 'a'.repeat(64)): StreamState {
  return {
    streamId: STREAM_ID,
    streamRawTopic: 'b'.repeat(64),
    mediatype: 'video',
    socIndex: 3,
    segments: [{ index: 7, duration: 2, ref: reference, sequence: 7 }],
    hlsHeaders: ['#EXTM3U'],
    isFirstSegmentReady: true,
    isFirstManifestReady: true,
    updatedAt: 1_000_000,
  };
}

describe('ManagedMediaStore durability', () => {
  it('persists accepted bytes and identity before acknowledging the callback', () => {
    const root = tempRoot();
    const accepted = new ManagedMediaStore(root).accept(input(), Buffer.from('segment-a'));
    assert.equal(accepted.kind, 'accepted');
    if (accepted.kind !== 'accepted') {return;}

    const recovered = new ManagedMediaStore(root);
    assert.deepEqual(recovered.readBytes(accepted.record.token), Buffer.from('segment-a'));
    assert.deepEqual(recovered.listRun(ADMIN_STREAM_ID, 2), [accepted.record]);
  });

  for (const fault of ['byte-file-flush', 'metadata-replace', 'directory-flush'] as const) {
    it(`refuses acknowledgement when ${fault} fails`, () => {
      const root = tempRoot();
      const store = new ManagedMediaStore(root, faultingOps(fault));

      assert.throws(() => store.accept(input(), Buffer.from('segment-a')), /injected/);
    });
  }

  it('deduplicates identical callbacks before and after raw-byte cleanup and refuses conflicting content', () => {
    const root = tempRoot();
    const store = new ManagedMediaStore(root);
    const accepted = store.accept(input(), Buffer.from('segment-a'));
    assert.equal(accepted.kind, 'accepted');
    if (accepted.kind !== 'accepted') {return;}

    assert.equal(store.accept(input(), Buffer.from('segment-a')).kind, 'duplicate');
    assert.equal(store.accept(input(), Buffer.from('segment-b')).kind, 'conflict');

    store.commitUploaded(accepted.record.token, 'a'.repeat(64), state());
    assert.equal(store.readBytes(accepted.record.token), null);
    assert.equal(new ManagedMediaStore(root).accept(input(), Buffer.from('segment-a')).kind, 'duplicate');
    assert.equal(new ManagedMediaStore(root).accept(input(), Buffer.from('segment-b')).kind, 'conflict');
  });

  it('recovers one logical pending item after a fresh process', () => {
    const root = tempRoot();
    const first = new ManagedMediaStore(root).accept(input(), Buffer.from('segment-a'));
    assert.equal(first.kind, 'accepted');

    const second = new ManagedMediaStore(root);
    const pending = second.listPending(ADMIN_STREAM_ID, 2);
    assert.equal(pending.length, 1);
    assert.deepEqual(second.readBytes(pending[0].token), Buffer.from('segment-a'));
  });

  it('keeps late completion from an old run out of the next run', () => {
    const root = tempRoot();
    const store = new ManagedMediaStore(root);
    const oldRun = store.accept(input({ runNumber: 2 }), Buffer.from('old'));
    const newRun = store.accept(input({ runNumber: 3 }), Buffer.from('new'));
    assert.equal(oldRun.kind, 'accepted');
    assert.equal(newRun.kind, 'accepted');
    if (oldRun.kind !== 'accepted' || newRun.kind !== 'accepted') {return;}

    store.commitUploaded(oldRun.record.token, 'a'.repeat(64), state('a'.repeat(64)));

    assert.equal(store.listPending(ADMIN_STREAM_ID, 2).length, 0);
    assert.deepEqual(store.listPending(ADMIN_STREAM_ID, 3).map((record) => record.token), [newRun.record.token]);
  });

  it('keeps committed history when the process dies before raw cleanup', () => {
    const root = tempRoot();
    const store = new ManagedMediaStore(root, faultingOps('raw-cleanup'));
    const accepted = store.accept(input(), Buffer.from('segment-a'));
    assert.equal(accepted.kind, 'accepted');
    if (accepted.kind !== 'accepted') {return;}

    store.commitUploaded(accepted.record.token, 'a'.repeat(64), state());

    const recovered = new ManagedMediaStore(root);
    const record = recovered.listRun(ADMIN_STREAM_ID, 2)[0];
    assert.equal(record.status, 'committed');
    assert.equal(record.reference, 'a'.repeat(64));
    assert.deepEqual(record.trackState, state());
    assert.equal(recovered.readBytes(record.token), null, 'committed media was offered for upload twice');
    assert.equal(recovered.accept(input(), Buffer.from('segment-a')).kind, 'duplicate');
  });
});

function faultingOps(
  fault: 'byte-file-flush' | 'metadata-replace' | 'directory-flush' | 'raw-cleanup',
): ManagedMediaFileOps {
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
      if (fault === 'byte-file-flush' && target.endsWith('.bin.tmp')) {
        throw new Error('injected byte file flush failure');
      }
      if (fault === 'directory-flush' && target === tempRootPath(target)) {
        throw new Error('injected directory flush failure');
      }
      fs.fsyncSync(fd);
    },
    closeSync: (fd) => {
      opened.delete(fd);
      fs.closeSync(fd);
    },
    renameSync: (from, to) => {
      if (fault === 'metadata-replace' && from.endsWith('.json.tmp')) {
        throw new Error('injected metadata replace failure');
      }
      fs.renameSync(from, to);
    },
    rmSync: (target) => {
      if (fault === 'raw-cleanup' && target.endsWith('.bin')) {
        throw new Error('injected raw cleanup failure');
      }
      fs.rmSync(target, { force: true });
    },
  };
}

function tempRootPath(target: string): string {
  return path.extname(target) === '' ? target : '';
}
