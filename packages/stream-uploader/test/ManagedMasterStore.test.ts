import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { ManagedMasterBinding, ManagedMasterStore } from '../src/libs/ManagedMasterStore.js';

const BINDING: ManagedMasterBinding = {
  streamId: '11111111-1111-4111-8111-111111111111',
  runNumber: 2,
  uploaderId: 'srs-uploader-a',
  claimId: '22222222-2222-4222-8222-222222222222',
  group: '33333333-3333-4333-8333-333333333333',
};

describe('ManagedMasterStore', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains an exact pending write across restart and seals its reference once', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-master-store-'));
    roots.push(root);
    const prepared = new ManagedMasterStore(root).prepare({
      ...BINDING,
      eventId: 'rendition:4',
      index: 12,
      playlist: '#EXTM3U\n',
    });
    const restarted = new ManagedMasterStore(root);
    assert.deepEqual(restarted.read(BINDING), prepared);

    const committed = restarted.commit(prepared, 'a'.repeat(64));
    assert.equal(committed.status, 'committed');
    assert.deepEqual(new ManagedMasterStore(root).commit(prepared, 'a'.repeat(64)), committed);
    assert.throws(() => restarted.commit(prepared, 'b'.repeat(64)), /another reference/);
  });

  it('does not replace an unsettled write with a later event', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-master-store-'));
    roots.push(root);
    const store = new ManagedMasterStore(root);
    store.prepare({ ...BINDING, eventId: 'rendition:4', index: 12, playlist: '#EXTM3U\n' });
    assert.throws(
      () => store.prepare({ ...BINDING, eventId: 'rendition:5', index: 13, playlist: '#EXTM3U\nnext' }),
      /must settle/,
    );
  });
});
