import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  ManagedRenditionBinding,
  ManagedRenditionStore,
} from '../src/libs/ManagedRenditionStore.js';
import { DurableFileOps } from '../src/libs/ManagedRunStore.js';
import { Rendition } from '../src/types.js';

const BINDING: ManagedRenditionBinding = {
  streamId: '11111111-1111-4111-8111-111111111111',
  runNumber: 2,
  uploaderId: 'srs-uploader-a',
  claimId: '22222222-2222-4222-8222-222222222222',
};
const LIVE: Rendition = {
  name: '360p',
  topic: '33333333-3333-4333-8333-333333333333',
  width: 640,
  height: 360,
  bandwidth: 800_000,
  avgBandwidth: 700_000,
};

function failDirectoryFlushOnce(target: string): DurableFileOps {
  const paths = new Map<number, string>();
  let failed = false;
  return {
    mkdirSync: (entry, options) => fs.mkdirSync(entry, options),
    existsSync: (entry) => fs.existsSync(entry),
    readdirSync: (entry) => fs.readdirSync(entry),
    readFileSync: (entry, encoding) => fs.readFileSync(entry, encoding),
    openSync: (entry, flags, mode) => {
      const fd = fs.openSync(entry, flags, mode);
      paths.set(fd, entry);
      return fd;
    },
    writeFileSync: (fd, data) => fs.writeFileSync(fd, data),
    fsyncSync: (fd) => {
      if (!failed && paths.get(fd) === target) {
        failed = true;
        throw new Error('injected directory fsync failure');
      }
      fs.fsyncSync(fd);
    },
    closeSync: (fd) => {
      paths.delete(fd);
      fs.closeSync(fd);
    },
    renameSync: (from, to) => fs.renameSync(from, to),
  };
}

describe('ManagedRenditionStore', () => {
  const roots: string[] = [];
  const makeRoot = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-rendition-store-'));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries the exact persisted sequence and observed time after restart', () => {
    const root = makeRoot();
    const first = new ManagedRenditionStore(root).prepare(BINDING, LIVE, '2026-09-20T10:00:00.000Z');
    const retried = new ManagedRenditionStore(root).prepare(BINDING, LIVE, '2026-09-20T10:01:00.000Z');

    assert.equal(first.target, true);
    assert.equal(first.report.renditionSequence, 1);
    assert.deepEqual(retried, first);
  });

  it('serializes a final update behind an unresolved live event', () => {
    const root = makeRoot();
    const store = new ManagedRenditionStore(root);
    const live = store.prepare(BINDING, LIVE, '2026-09-20T10:00:00.000Z');
    const blocked = store.prepare(BINDING, { ...LIVE, index: 12, duration: 61 }, '2026-09-20T10:01:00.000Z');

    assert.equal(blocked.target, false);
    assert.deepEqual(blocked.report, live.report);

    store.accept(BINDING, live.report, 4);
    const final = store.prepare(BINDING, { ...LIVE, index: 12, duration: 61 }, '2026-09-20T10:01:00.000Z');
    assert.equal(final.target, true);
    assert.equal(final.report.renditionSequence, 2);
    assert.equal(final.report.observedAt, '2026-09-20T10:01:00.000Z');
  });

  it('keeps the accepted event for exact duplicate recovery and remembers the aggregate revision', () => {
    const root = makeRoot();
    const first = new ManagedRenditionStore(root);
    const prepared = first.prepare(BINDING, LIVE, '2026-09-20T10:00:00.000Z');
    first.accept(BINDING, prepared.report, 7);

    const restarted = new ManagedRenditionStore(root);
    assert.deepEqual(restarted.prepare(BINDING, LIVE, '2026-09-20T10:05:00.000Z'), prepared);
    assert.equal(restarted.latestRevision(BINDING.streamId, BINDING.runNumber), 7);
  });

  it('refuses corrupt retained state instead of allocating a fresh sequence', () => {
    const root = makeRoot();
    const store = new ManagedRenditionStore(root);
    store.prepare(BINDING, LIVE, '2026-09-20T10:00:00.000Z');
    const file = fs.readdirSync(root).find((name) => name.endsWith('.json'))!;
    fs.writeFileSync(path.join(root, file), '{broken');

    assert.throws(
      () => new ManagedRenditionStore(root).prepare(BINDING, LIVE, '2026-09-20T10:01:00.000Z'),
      /unreadable/,
    );
  });

  it('flushes a renamed event successfully before a retry may return it', () => {
    const root = makeRoot();
    const store = new ManagedRenditionStore(root, failDirectoryFlushOnce(root));

    assert.throws(
      () => store.prepare(BINDING, LIVE, '2026-09-20T10:00:00.000Z'),
      /injected directory fsync failure/,
    );
    const retried = store.prepare(BINDING, LIVE, '2026-09-20T10:01:00.000Z');
    assert.equal(retried.report.observedAt, '2026-09-20T10:00:00.000Z');
    assert.equal(retried.report.renditionSequence, 1);
  });

  it('retries the parent directory flush when store creation was not acknowledged', () => {
    const parent = makeRoot();
    const root = path.join(parent, 'events');
    const fileOps = failDirectoryFlushOnce(parent);

    assert.throws(() => new ManagedRenditionStore(root, fileOps), /injected directory fsync failure/);
    const reopened = new ManagedRenditionStore(root, fileOps);
    assert.equal(
      reopened.prepare(BINDING, LIVE, '2026-09-20T10:00:00.000Z').report.renditionSequence,
      1,
    );
  });
});
