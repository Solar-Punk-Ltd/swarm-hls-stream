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

/**
 * Runs `run` with the error log captured rather than printed, so a test can assert on what was
 * reported, and on nothing being reported, without the suite output filling with expected failures.
 */
function capturingErrors<T>(run: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const { error } = console;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    return { result: run(), lines };
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

    const before = Date.now();
    capturingErrors(() => store.save(OWNER, TOPIC_HEX, FeedIndex.fromBigInt(BigInt(7))));
    const age = store.getMsSinceSaveFailed();

    assert.ok(age !== null, 'a stale persisted index must be reportable');
    // Bounded by the wall time the save took, because an unbounded "positive number" is also what a
    // raw clock reading is, and that is the shape this report must never have.
    assert.ok(age >= 0 && age <= Date.now() - before, `an age, not a clock reading, got ${age}`);
  });

  it('clears the report once a write lands', () => {
    const root = makeTempRoot();
    const store = new CatalogIndexStore(unwritablePath(root));
    capturingErrors(() => store.save(OWNER, TOPIC_HEX, FeedIndex.fromBigInt(BigInt(7))));
    assert.notEqual(store.getMsSinceSaveFailed(), null, 'the failure has to be recorded for this to mean anything');

    const writable = new CatalogIndexStore(path.join(root, 'ok', 'feed-index.json'));
    capturingErrors(() => writable.save(OWNER, TOPIC_HEX, FeedIndex.fromBigInt(BigInt(7))));

    assert.equal(writable.getMsSinceSaveFailed(), null);
    assert.deepEqual(
      writable.load(OWNER, TOPIC_HEX)?.toString(),
      FeedIndex.fromBigInt(BigInt(7)).toString(),
      'a save that reports success must have actually landed',
    );
  });

  it('creates however many directories the configured index path needs', () => {
    const file = path.join(makeTempRoot(), 'state', 'catalog', 'feed-index.json');
    const store = new CatalogIndexStore(file);

    const { lines } = capturingErrors(() => store.save(OWNER, TOPIC_HEX, FeedIndex.fromBigInt(BigInt(7))));

    assert.deepEqual(lines, [], 'a path more than one directory deep is a configuration, not a failure');
    assert.equal(store.getMsSinceSaveFailed(), null);
    assert.equal(store.load(OWNER, TOPIC_HEX)?.toString(), FeedIndex.fromBigInt(BigInt(7)).toString());
  });
});

/**
 * Every refusal here returns the same `null` the caller reads as "nothing is persisted", and the
 * caller answers that by resuming from whatever the boot lookup says. So a `null` that should have
 * been an index is the fork this class exists to prevent, and a load that cannot tell a foreign file
 * from a missing one hands one over.
 */
describe('CatalogIndexStore refuses an index it cannot vouch for', () => {
  after(() => {
    for (const root of tempRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports nothing, and no failure, before an index has ever been persisted', () => {
    const store = new CatalogIndexStore(path.join(makeTempRoot(), 'feed-index.json'));

    const { result, lines } = capturingErrors(() => store.load(OWNER, TOPIC_HEX));

    assert.equal(result, null);
    assert.deepEqual(lines, [], 'a first boot has nothing to resume from, which is not a failure');
  });

  it('refuses an index persisted by a different owner', () => {
    const store = new CatalogIndexStore(path.join(makeTempRoot(), 'feed-index.json'));
    store.save(OWNER, TOPIC_HEX, FeedIndex.fromBigInt(BigInt(7)));

    assert.equal(store.load('0xsomebodyelse', TOPIC_HEX), null, 'another key writes another feed');
  });

  it('refuses an index persisted under a different topic', () => {
    const store = new CatalogIndexStore(path.join(makeTempRoot(), 'feed-index.json'));
    store.save(OWNER, TOPIC_HEX, FeedIndex.fromBigInt(BigInt(7)));

    assert.equal(store.load(OWNER, '0xanothertopic'), null, 'another topic is another feed');
  });

  it('refuses, and reports, a persisted index it cannot parse', () => {
    const file = path.join(makeTempRoot(), 'feed-index.json');
    fs.writeFileSync(file, '{"owner": "0xabc"');
    const store = new CatalogIndexStore(file);

    const { result, lines } = capturingErrors(() => store.load(OWNER, TOPIC_HEX));

    assert.equal(result, null, 'a half-written file must not resume anything');
    assert.match(lines.join('\n'), /feed-index\.json/, 'and the file that has to be repaired must be named');
  });
});
