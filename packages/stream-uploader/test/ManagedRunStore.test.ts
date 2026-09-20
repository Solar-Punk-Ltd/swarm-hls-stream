import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  DurableFileOps,
  MANAGED_RUN_LOADED,
  MANAGED_RUN_MISSING,
  MANAGED_RUN_UNREADABLE,
  ManagedRunRecord,
  ManagedRunStore,
  remainingManagedDeadline,
} from '../src/libs/ManagedRunStore.js';

const roots: string[] = [];
const STREAM_ID = 'video/11111111-1111-4111-8111-111111111111';

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-run-store-'));
  roots.push(root);
  return root;
}

function record(overrides: Partial<ManagedRunRecord> = {}): ManagedRunRecord {
  return {
    lifecycleVersion: 1,
    streamId: STREAM_ID,
    adminStreamId: '22222222-2222-4222-8222-222222222222',
    topic: 'a'.repeat(64),
    mediaType: 'video',
    revision: 8,
    runNumber: 2,
    uploaderId: 'srs-157-90-34-105',
    claimId: '44444444-4444-4444-8444-444444444444',
    claimRequestId: '33333333-3333-4333-8333-333333333333',
    eventSequence: 1,
    state: 'live',
    deadlineWallMs: 1_060_000,
    deadlineRecordedAtWallMs: 1_000_000,
    deadlineRemainingMs: 60_000,
    lastProgressPts: 9_000,
    source: {
      serverId: 'server-a',
      serviceId: 'service-a',
      clientId: 'client-a',
      generation: 1,
    },
    pendingReports: [],
    ...overrides,
  };
}

function faultingOps(fault: 'write' | 'file-flush' | 'directory-flush', calls: string[]): DurableFileOps {
  const opened = new Map<number, string>();
  return {
    mkdirSync: (target, options) => fs.mkdirSync(target, options),
    existsSync: (target) => fs.existsSync(target),
    readdirSync: (target) => fs.readdirSync(target),
    readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
    openSync: (target, flags, mode) => {
      const fd = fs.openSync(target, flags, mode);
      opened.set(fd, target);
      calls.push(`open:${path.basename(target)}`);
      return fd;
    },
    writeFileSync: (fd, data) => {
      calls.push('write');
      if (fault === 'write') {throw new Error('injected write failure');}
      fs.writeFileSync(fd, data);
    },
    fsyncSync: (fd) => {
      const target = opened.get(fd) ?? '';
      const directory = path.extname(target) === '';
      calls.push(directory ? 'flush-directory' : 'flush-file');
      if (fault === 'file-flush' && !directory) {throw new Error('injected file flush failure');}
      if (fault === 'directory-flush' && directory) {throw new Error('injected directory flush failure');}
      fs.fsyncSync(fd);
    },
    closeSync: (fd) => {
      calls.push(`close:${path.basename(opened.get(fd) ?? '')}`);
      opened.delete(fd);
      fs.closeSync(fd);
    },
    renameSync: (from, to) => {
      calls.push('rename');
      fs.renameSync(from, to);
    },
  };
}

describe('ManagedRunStore durability', () => {
  it('flushes the file, renames it, and flushes the directory before save acknowledges', () => {
    const root = tempRoot();
    const calls: string[] = [];
    const store = new ManagedRunStore(root, faultingOps('directory-flush', calls));

    assert.throws(() => store.save(record()), /directory flush failure/);
    assert.deepEqual(calls.slice(-6), [
      'flush-file',
      expectClose('.tmp'),
      'rename',
      `open:${path.basename(root)}`,
      'flush-directory',
      `close:${path.basename(root)}`,
    ]);
  });

  it('flushes the parent before a newly created store can acknowledge a save', () => {
    const parent = tempRoot();
    const stateDir = path.join(parent, 'managed-runs');
    const calls: string[] = [];
    const ops = faultingOps('directory-flush', calls);

    assert.throws(() => new ManagedRunStore(stateDir, ops), /directory flush failure/);
    assert.deepEqual(calls.slice(-3), [`open:${path.basename(parent)}`, 'flush-directory', `close:${path.basename(parent)}`]);
    assert.equal(calls.includes('write'), false, 'a run could be saved before its store directory was durable');
  });

  for (const fault of ['write', 'file-flush'] as const) {
    it(`keeps the previous durable run when the next ${fault} fails`, () => {
      const root = tempRoot();
      const original = record({ revision: 8, state: 'waiting' });
      new ManagedRunStore(root).save(original);
      const store = new ManagedRunStore(root, faultingOps(fault, []));

      assert.throws(() => store.save(record({ revision: 9, state: 'closed' })), /injected/);
      assert.deepEqual(new ManagedRunStore(root).read(STREAM_ID), { kind: MANAGED_RUN_LOADED, record: original });
    });
  }

  it('restores waiting before closure and the closed tombstone after its durable save', () => {
    const root = tempRoot();
    const waiting = record({ state: 'waiting', eventSequence: 2 });
    const closed = record({ state: 'closed', revision: 9, eventSequence: 3, deadlineRemainingMs: 0 });
    const store = new ManagedRunStore(root);

    store.save(waiting);
    assert.deepEqual(new ManagedRunStore(root).read(STREAM_ID), { kind: MANAGED_RUN_LOADED, record: waiting });
    store.save(closed);
    assert.deepEqual(new ManagedRunStore(root).read(STREAM_ID), { kind: MANAGED_RUN_LOADED, record: closed });
  });

  it('keeps missing and corrupt managed admission distinct so recovery can refuse both', () => {
    const root = tempRoot();
    const store = new ManagedRunStore(root);
    assert.deepEqual(store.read(STREAM_ID), { kind: MANAGED_RUN_MISSING });

    fs.writeFileSync(path.join(root, `${encodeURIComponent(STREAM_ID)}.json`), '{"runNumber":2');
    assert.deepEqual(store.read(STREAM_ID), { kind: MANAGED_RUN_UNREADABLE });
  });

  it('never grants a fresh timeout after wall-clock rollback or time spent stopped', () => {
    const saved = record();

    assert.equal(remainingManagedDeadline(saved, 1_030_000), 30_000);
    assert.equal(remainingManagedDeadline(saved, 1_060_000), 0);
    assert.equal(remainingManagedDeadline(saved, 999_999), 0, 'clock rollback granted a fresh timeout');
  });
});

function expectClose(suffix: string): string {
  return `close:${encodeURIComponent(STREAM_ID)}.json${suffix}`;
}
