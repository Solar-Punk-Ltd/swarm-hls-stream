import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { LadderGroupStore } from '../src/libs/LadderGroupStore.js';

const BASE = 'video/livestream';
const OTHER_BASE = 'video/second';
const GROUP = 'ladder-1';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-group-'));
  tempRoots.push(root);
  return root;
}

/** A store over a directory that does not exist yet, which is how the uploader first meets one. */
function storeIn(root: string): { store: LadderGroupStore; filePath: string } {
  const filePath = path.join(root, 'ladder', 'groups.json');
  return { store: new LadderGroupStore(filePath), filePath };
}

/**
 * A path whose parent is an ordinary file, so `mkdirSync` fails with ENOTDIR. A real filesystem
 * refusal rather than a stubbed `fs`, because the branch under test is the catch around it.
 */
function unwritablePath(root: string): string {
  const blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  return path.join(blocker, 'ladder', 'groups.json');
}

/**
 * Runs `run` with the error log captured rather than printed, so a test can assert on what was
 * reported without the suite output filling with expected failures.
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

describe('LadderGroupStore', () => {
  after(() => {
    for (const root of tempRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('remembers nothing before anything has been written', () => {
    const { store } = storeIn(makeTempRoot());

    assert.equal(store.load(BASE), null);
  });

  it('hands back the group a base was last remembered under', () => {
    const { store } = storeIn(makeTempRoot());

    store.remember(BASE, GROUP);

    assert.equal(store.load(BASE), GROUP);
  });

  /**
   * The whole reason this class exists. A crash takes the orchestrator's in-memory map with it, and
   * a second store over the same file is what the next boot has instead.
   */
  it('hands the group to a store built fresh over the same file, which is what a restart is', () => {
    const root = makeTempRoot();
    storeIn(root).store.remember(BASE, GROUP);

    assert.equal(storeIn(root).store.load(BASE), GROUP);
  });

  it('keeps one base group apart from another', () => {
    const root = makeTempRoot();
    const { store } = storeIn(root);

    store.remember(BASE, GROUP);
    store.remember(OTHER_BASE, 'ladder-2');

    assert.equal(storeIn(root).store.load(BASE), GROUP);
    assert.equal(storeIn(root).store.load(OTHER_BASE), 'ladder-2');
  });

  it('forgets a base once its ladder is done, so the next broadcast on it is a new recording', () => {
    const root = makeTempRoot();
    const { store } = storeIn(root);
    store.remember(BASE, GROUP);
    store.remember(OTHER_BASE, 'ladder-2');

    store.forget(BASE);

    assert.equal(storeIn(root).store.load(BASE), null);
    assert.equal(storeIn(root).store.load(OTHER_BASE), 'ladder-2', 'forgetting one base took another with it');
  });

  it('forgets a base it never held without complaining', () => {
    const { store } = storeIn(makeTempRoot());

    const { lines } = capturingErrors(() => store.forget(BASE));

    assert.deepEqual(lines, []);
    assert.equal(store.load(BASE), null);
  });

  /**
   * A damaged file must not take the boot down. Losing the identity costs one broadcast a duplicate
   * entry; refusing to start costs every broadcast, and an operator has nothing to repair from.
   */
  it('reads a damaged file as nothing remembered, loudly, rather than throwing', () => {
    const root = makeTempRoot();
    const { store, filePath } = storeIn(root);
    store.remember(BASE, GROUP);
    fs.writeFileSync(filePath, '{ this is not json');

    const { result, lines } = capturingErrors(() => storeIn(root).store.load(BASE));

    assert.equal(result, null);
    assert.equal(lines.length, 1, `a damaged file must be reported exactly once, got ${lines.length} line(s)`);
  });

  it('reads a file holding the wrong shape as nothing remembered', () => {
    const root = makeTempRoot();
    const { store, filePath } = storeIn(root);
    store.remember(BASE, GROUP);
    fs.writeFileSync(filePath, JSON.stringify({ [BASE]: { group: GROUP } }));

    const { result } = capturingErrors(() => storeIn(root).store.load(BASE));

    assert.equal(result, null);
  });

  it('reports a write it could not land instead of throwing into the announce path', () => {
    const store = new LadderGroupStore(unwritablePath(makeTempRoot()));

    const { lines } = capturingErrors(() => store.remember(BASE, GROUP));

    assert.equal(lines.length, 1, `a refused write must be reported exactly once, got ${lines.length} line(s)`);
  });
});
