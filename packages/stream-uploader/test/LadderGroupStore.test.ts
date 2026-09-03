import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { LadderGroupStore, RememberedLadder } from '../src/libs/LadderGroupStore.js';

const BASE = 'video/livestream';
const OTHER_BASE = 'video/second';
const GROUP = 'ladder-1';
const STARTED_AT_MS = Date.UTC(2026, 8, 1, 12, 0, 0);
const LADDER: RememberedLadder = { group: GROUP, startedAtMs: STARTED_AT_MS };
const OTHER_LADDER: RememberedLadder = { group: 'ladder-2', startedAtMs: STARTED_AT_MS + 60_000 };

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

  it('hands back the ladder a base was last remembered under', () => {
    const { store } = storeIn(makeTempRoot());

    store.remember(BASE, LADDER);

    assert.deepEqual(store.load(BASE), LADDER);
  });

  /**
   * The whole reason this class exists. A crash takes the orchestrator's in-memory map with it, and
   * a second store over the same file is what the next boot has instead.
   */
  it('hands the ladder to a store built fresh over the same file, which is what a restart is', () => {
    const root = makeTempRoot();
    storeIn(root).store.remember(BASE, LADDER);

    assert.deepEqual(storeIn(root).store.load(BASE), LADDER);
  });

  /**
   * The start instant is why the group survives a restart at all now: it is what dates every segment
   * of the recovered broadcast, so a boot that recovered the group and lost the clock would restamp
   * the whole recording at the moment of the restart.
   */
  it('carries the broadcast start across a restart, not only the group', () => {
    const root = makeTempRoot();
    storeIn(root).store.remember(BASE, LADDER);

    assert.equal(storeIn(root).store.load(BASE)?.startedAtMs, STARTED_AT_MS);
  });

  /**
   * A file written before this store kept a start instant. Read as a group with no clock, so the
   * caller mints a late-but-honest one, rather than as nothing, which would mint a second group and
   * list one broadcast twice.
   */
  it('reads a bare group string as that group with no start recorded', () => {
    const root = makeTempRoot();
    const { filePath } = storeIn(root);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ [BASE]: GROUP }));

    assert.deepEqual(storeIn(root).store.load(BASE), { group: GROUP, startedAtMs: null });
  });

  it('keeps one base group apart from another', () => {
    const root = makeTempRoot();
    const { store } = storeIn(root);

    store.remember(BASE, LADDER);
    store.remember(OTHER_BASE, OTHER_LADDER);

    assert.deepEqual(storeIn(root).store.load(BASE), LADDER);
    assert.deepEqual(storeIn(root).store.load(OTHER_BASE), OTHER_LADDER);
  });

  it('forgets a base once its ladder is done, so the next broadcast on it is a new recording', () => {
    const root = makeTempRoot();
    const { store } = storeIn(root);
    store.remember(BASE, LADDER);
    store.remember(OTHER_BASE, OTHER_LADDER);

    store.forget(BASE);

    assert.equal(storeIn(root).store.load(BASE), null);
    assert.deepEqual(storeIn(root).store.load(OTHER_BASE), OTHER_LADDER, 'forgetting one base took another with it');
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
    store.remember(BASE, LADDER);
    fs.writeFileSync(filePath, '{ this is not json');

    const { result, lines } = capturingErrors(() => storeIn(root).store.load(BASE));

    assert.equal(result, null);
    assert.equal(lines.length, 1, `a damaged file must be reported exactly once, got ${lines.length} line(s)`);
  });

  it('reads a file holding the wrong shape as nothing remembered', () => {
    const root = makeTempRoot();
    const { store, filePath } = storeIn(root);
    store.remember(BASE, LADDER);
    fs.writeFileSync(filePath, JSON.stringify({ [BASE]: { startedAtMs: STARTED_AT_MS } }));

    const { result } = capturingErrors(() => storeIn(root).store.load(BASE));

    assert.equal(result, null);
  });

  it('reports a write it could not land instead of throwing into the announce path', () => {
    const store = new LadderGroupStore(unwritablePath(makeTempRoot()));

    const { lines } = capturingErrors(() => store.remember(BASE, LADDER));

    assert.equal(lines.length, 1, `a refused write must be reported exactly once, got ${lines.length} line(s)`);
  });
});
