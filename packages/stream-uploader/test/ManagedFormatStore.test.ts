import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { ManagedFormatInput, ManagedFormatStore } from '../src/libs/ManagedFormatStore.js';
import { DurableFileOps } from '../src/libs/ManagedRunStore.js';
import { MediaFormatFingerprint } from '../src/libs/MediaFormatProbe.js';

const roots: string[] = [];
const INPUT: ManagedFormatInput = {
  adminStreamId: '11111111-1111-4111-8111-111111111111',
  runNumber: 2,
  streamId: 'live/camera',
  topic: 'camera-topic',
  rendition: null,
  source: { serverId: 'server', serviceId: 'service', clientId: 'client-a', generation: 1 },
  sequence: 4,
};
const FINGERPRINT: MediaFormatFingerprint = {
  version: 1,
  container: 'mpegts',
  tracks: [{ kind: 'audio', codec: 'aac', profile: 'LC', sampleRate: 48_000, channels: 2, channelLayout: 'stereo' }],
};

function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-formats-'));
  roots.push(directory);
  return directory;
}

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

afterEach(() => {
  for (const directory of roots.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('ManagedFormatStore', () => {
  it('durably accumulates bounded opening bytes and deduplicates an exact callback', () => {
    const directory = root();
    const store = new ManagedFormatStore(directory, 8);
    assert.deepEqual(store.stage(INPUT, Buffer.from('abc')), { kind: 'ready', bytes: Buffer.from('abc') });
    assert.deepEqual(new ManagedFormatStore(directory, 8).stage(INPUT, Buffer.from('abc')), {
      kind: 'ready',
      bytes: Buffer.from('abc'),
    });
    assert.deepEqual(store.stage({ ...INPUT, sequence: 5 }, Buffer.from('de')), {
      kind: 'ready',
      bytes: Buffer.from('abcde'),
    });
    assert.deepEqual(store.stage({ ...INPUT, sequence: 6 }, Buffer.from('fghi')), {
      kind: 'ready',
      bytes: Buffer.from('abcdefgh'),
    });
    assert.deepEqual(store.stage({ ...INPUT, sequence: 7 }, Buffer.from('j')), {
      kind: 'ready',
      bytes: Buffer.from('abcdefgh'),
    });
    store.recordIncomplete({ ...INPUT, sequence: 7 });
    assert.deepEqual(store.stage({ ...INPUT, sequence: 8 }, Buffer.from('k')), { kind: 'limit' });
    assert.deepEqual(store.stage(INPUT, Buffer.from('changed')), { kind: 'conflict' });
  });

  it('retains only the bounded inspection prefix of a larger valid segment', () => {
    const store = new ManagedFormatStore(root(), 4);
    assert.deepEqual(store.stage(INPUT, Buffer.from('abcdefgh')), {
      kind: 'ready',
      bytes: Buffer.from('abcd'),
    });
    assert.deepEqual(store.stage(INPUT, Buffer.from('abcdefgh')), {
      kind: 'ready',
      bytes: Buffer.from('abcd'),
    });
  });

  it('seals a canonical fingerprint and reloads it without retaining raw opening bytes', () => {
    const directory = root();
    const store = new ManagedFormatStore(directory);
    store.stage(INPUT, Buffer.from('opening'));
    assert.deepEqual(store.commit(INPUT, FINGERPRINT), FINGERPRINT);

    const restarted = new ManagedFormatStore(directory);
    assert.deepEqual(restarted.stage(INPUT, Buffer.from('ignored after validation')), {
      kind: 'validated',
      fingerprint: FINGERPRINT,
    });
    const record = restarted.read(INPUT);
    assert.equal(record?.openingBytes, '');
    assert.deepEqual(record?.openingParts, []);
  });

  it('retains the baseline across a new source generation and refuses a changed format', () => {
    const store = new ManagedFormatStore(root());
    store.stage(INPUT, Buffer.from('a'));
    store.commit(INPUT, FINGERPRINT);
    const sourceB = {
      ...INPUT,
      source: { serverId: 'server', serviceId: 'service', clientId: 'client-b', generation: 2 },
      sequence: 0,
    };
    assert.deepEqual(store.stage(sourceB, Buffer.from('b')), { kind: 'ready', bytes: Buffer.from('b') });
    assert.throws(
      () => store.commit(sourceB, { ...FINGERPRINT, tracks: [{ ...FINGERPRINT.tracks[0], channels: 1 }] }),
      /changed from its durable fingerprint/,
    );
    assert.deepEqual(store.commit(sourceB, FINGERPRINT), FINGERPRINT);
  });

  it('does not acknowledge staged opening bytes until a renamed record is durably flushed', () => {
    const directory = root();
    const store = new ManagedFormatStore(directory, 1024, failDirectoryFlushOnce(directory));

    assert.throws(() => store.stage(INPUT, Buffer.from('opening')), /injected directory fsync failure/);
    assert.deepEqual(store.stage(INPUT, Buffer.from('opening')), {
      kind: 'ready',
      bytes: Buffer.from('opening'),
    });
  });
});
