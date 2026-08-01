import { FeedIndex } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { CatalogIndexStore } from '../src/libs/CatalogIndexStore.js';

const OWNER = '0xabc';
const TOPIC_HEX = '0xdef';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-index-'));
  tempRoots.push(root);
  return root;
}

/**
 * A path whose parent is an ordinary file, so `mkdirSync` fails with ENOTDIR. A real filesystem
 * refusal rather than a stubbed `fs`, because the branch under test is the catch around it.
 */
function unwritablePath(root: string): string {
  const blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  return path.join(blocker, 'catalog', 'feed-index.json');
}

function silently(run: () => void): void {
  const { error } = console;
  console.error = () => {};
  try {
    run();
  } finally {
    console.error = error;
  }
}

describe('CatalogIndexStore save failures (OBS-5)', () => {
  after(() => {
    for (const root of tempRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports nothing before anything has been written', () => {
    const store = new CatalogIndexStore(path.join(makeTempRoot(), 'feed-index.json'));

    assert.equal(store.getMsSinceSaveFailed(), null);
  });

  /**
   * Swallowing this was invisible by construction: the running process keeps the right index in
   * memory, so the service is healthy and stays healthy until it restarts. Then `init` resumes from
   * whatever the file last held, which is the fork this class exists to prevent, written back into
   * the feed at indices readers have already passed.
   */
  it('reports how long the persisted index has been stale after a refused write', () => {
    const store = new CatalogIndexStore(unwritablePath(makeTempRoot()));

    silently(() => store.save(OWNER, TOPIC_HEX, FeedIndex.fromBigInt(BigInt(7))));

    const age = store.getMsSinceSaveFailed();
    assert.ok(age !== null && age >= 0, `a stale persisted index must be reportable, got ${age}`);
  });

  it('clears the report once a write lands', () => {
    const root = makeTempRoot();
    const store = new CatalogIndexStore(unwritablePath(root));
    silently(() => store.save(OWNER, TOPIC_HEX, FeedIndex.fromBigInt(BigInt(7))));
    assert.notEqual(store.getMsSinceSaveFailed(), null, 'the failure has to be recorded for this to mean anything');

    const writable = new CatalogIndexStore(path.join(root, 'ok', 'feed-index.json'));
    silently(() => writable.save(OWNER, TOPIC_HEX, FeedIndex.fromBigInt(BigInt(7))));

    assert.equal(writable.getMsSinceSaveFailed(), null);
    assert.deepEqual(
      writable.load(OWNER, TOPIC_HEX)?.toString(),
      FeedIndex.fromBigInt(BigInt(7)).toString(),
      'a save that reports success must have actually landed',
    );
  });
});
