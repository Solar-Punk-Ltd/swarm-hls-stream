import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { RecoveryStore } from '../src/libs/RecoveryStore.js';
import { StreamState } from '../src/types.js';

import { makeRecoveredState } from './helpers/fakes.js';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-store-'));
  tempRoots.push(root);
  return root;
}

/** A store over a directory that does not exist yet, which is how the uploader first meets one. */
function storeIn(root: string, ...segments: string[]): { store: RecoveryStore; dir: string } {
  const dir = path.join(root, ...segments);
  return { store: new RecoveryStore(dir), dir };
}

/** Everything the store said while it ran, so a test can assert on silence as well as on output. */
function capture(run: () => void): string[] {
  const { error, info } = console;
  const lines: string[] = [];
  const record = (...args: unknown[]): void => void lines.push(args.map(String).join(' '));
  console.error = record;
  console.info = record;
  try {
    run();
    return lines;
  } finally {
    console.error = error;
    console.info = info;
  }
}

/**
 * The class that carries a stream across a crash, executed for the first time.
 *
 * Every test in this package that touches recovery uses `makeFakeRecoveryStore`, so the real one had
 * never run: 48 mutants, 48 survivors, a mutation score of **0.00%**. That is not a thin patch in the
 * coverage, it is the whole file. A crash-recovery store is a poor thing to have never executed, and
 * two of the behaviours below are the reason — the write is atomic and the stream id is sanitized
 * before it reaches the filesystem, and neither had anything asserting it.
 */
describe('RecoveryStore', () => {
  after(() => {
    for (const root of tempRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('brings a stream back exactly as it went in', () => {
    const { store } = storeIn(makeTempRoot(), 'state');
    const state = makeRecoveredState('stream-1');

    store.save('stream-1', state);

    assert.deepEqual(store.load('stream-1'), state);
  });

  it('knows nothing about a stream it never saved', () => {
    const { store } = storeIn(makeTempRoot(), 'state');

    assert.equal(store.load('never-seen'), null);
  });

  it('creates the directory it was pointed at, however deep', () => {
    const { store, dir } = storeIn(makeTempRoot(), 'deeply', 'nested', 'state');

    assert.equal(fs.existsSync(dir), true, 'a store that does not create its own directory cannot save');
    store.save('stream-1', makeRecoveredState('stream-1'));
    assert.notEqual(store.load('stream-1'), null);
  });

  it('leaves a directory that already holds state alone', () => {
    const root = makeTempRoot();
    const first = storeIn(root, 'state');
    first.store.save('stream-1', makeRecoveredState('stream-1'));

    const second = new RecoveryStore(first.dir);

    assert.notEqual(second.load('stream-1'), null, 'constructing a second store over the same directory wiped it');
  });

  /**
   * ⭐ Why the write goes to a temporary name first. The uploader is killed mid-broadcast by the very
   * fault this file exists for, and a `writeFileSync` interrupted partway leaves a truncated document
   * that `load` will parse as damaged and discard. A rename inside one directory is atomic, so the
   * destination only ever holds a whole state or the previous one.
   */
  it('never leaves its temporary file behind, so a crash cannot find a half-written state', () => {
    const { store, dir } = storeIn(makeTempRoot(), 'state');

    store.save('stream-1', makeRecoveredState('stream-1'));

    assert.deepEqual(fs.readdirSync(dir), ['stream-1.json'], 'the temporary file outlived the save that made it');
  });

  it('overwrites the previous state rather than accumulating files', () => {
    const { store, dir } = storeIn(makeTempRoot(), 'state');
    store.save('stream-1', makeRecoveredState('stream-1'));

    store.save('stream-1', { ...makeRecoveredState('stream-1'), socIndex: 99 });

    assert.equal(fs.readdirSync(dir).length, 1);
    assert.equal(store.load('stream-1')?.socIndex, 99);
  });

  /**
   * The branch that keeps a damaged file from taking the uploader down with it. A state truncated by
   * the crash it was recording is the expected shape here, not an exotic one, and the caller's only
   * useful answer is the same one it gets for a stream it never saw.
   */
  it('treats a state it cannot parse as no state at all', () => {
    const { store, dir } = storeIn(makeTempRoot(), 'state');
    fs.writeFileSync(path.join(dir, 'stream-1.json'), '{"streamId":"stream-1","segm');

    const said = capture(() => {
      assert.equal(store.load('stream-1'), null);
    });

    assert.match(said.join(' '), /stream-1/, 'an operator was told a state failed to load but not which one');
  });

  /**
   * Absence and damage are the same answer to the caller and must not be the same event in the log.
   * Every start asks about streams it has never held, and a store that reported each one as a failure
   * would bury the single line that matters behind a wall of ordinary ones.
   */
  it('does not complain about a stream it simply never had', () => {
    const { store } = storeIn(makeTempRoot(), 'state');

    const said = capture(() => {
      assert.equal(store.load('never-seen'), null);
    });

    assert.deepEqual(said, []);
  });

  it('says nothing when asked to forget a stream that was never there', () => {
    const { store } = storeIn(makeTempRoot(), 'state');

    assert.deepEqual(
      capture(() => store.remove('never-seen')),
      [],
      'the store announced removing a state file that did not exist',
    );
  });

  it('names the stream whose state it removed', () => {
    const { store } = storeIn(makeTempRoot(), 'state');
    store.save('stream-1', makeRecoveredState('stream-1'));

    assert.match(capture(() => store.remove('stream-1')).join(' '), /stream-1/);
  });

  it('forgets a stream on request', () => {
    const { store, dir } = storeIn(makeTempRoot(), 'state');
    store.save('stream-1', makeRecoveredState('stream-1'));

    store.remove('stream-1');

    assert.equal(store.load('stream-1'), null);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('is untroubled by being asked to forget a stream twice', () => {
    const { store } = storeIn(makeTempRoot(), 'state');
    store.save('stream-1', makeRecoveredState('stream-1'));
    store.remove('stream-1');

    assert.doesNotThrow(() => store.remove('stream-1'));
  });

  describe('listing what is there to recover', () => {
    it('names every stream it holds and nothing else', () => {
      const { store } = storeIn(makeTempRoot(), 'state');
      store.save('stream-1', makeRecoveredState('stream-1'));
      store.save('stream-2', makeRecoveredState('stream-2'));

      assert.deepEqual(store.listActive().sort(), ['stream-1', 'stream-2']);
    });

    it('reports nothing before its directory has been written to', () => {
      const { store } = storeIn(makeTempRoot(), 'state');

      assert.deepEqual(store.listActive(), []);
    });

    /**
     * A `save` interrupted between the write and the rename leaves `<id>.json.tmp` on disk. Recovering
     * from it would mean parsing whatever fraction of the document reached the file, so the listing has
     * to exclude it by name rather than by hoping it is absent.
     */
    it('does not offer a half-written state as something to recover', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');
      store.save('stream-1', makeRecoveredState('stream-1'));
      fs.writeFileSync(path.join(dir, 'stream-2.json.tmp'), '{"streamId":"stream-2","segm');

      assert.deepEqual(store.listActive(), ['stream-1']);
    });

    it('ignores anything in the directory that is not a state file', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');
      store.save('stream-1', makeRecoveredState('stream-1'));
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a state');
      fs.mkdirSync(path.join(dir, 'subdir'));

      assert.deepEqual(store.listActive(), ['stream-1']);
    });

    it('hands back stream ids, not file names', () => {
      const { store } = storeIn(makeTempRoot(), 'state');
      store.save('stream-1', makeRecoveredState('stream-1'));

      assert.deepEqual(store.listActive(), ['stream-1'], 'the .json suffix reached the caller as part of the id');
    });

    /** Only the suffix. An id that happens to contain the same text is not a file extension. */
    it('strips the suffix from the end and nowhere else', () => {
      const { store } = storeIn(makeTempRoot(), 'state');
      store.save('recording.jsonb', makeRecoveredState('recording.jsonb'));

      assert.deepEqual(store.listActive(), ['recording.jsonb']);
    });

    /**
     * The directory can be taken away while the process is running — an operator clearing state, a
     * container remount, a tmpfs that did not survive. Listing is called on the recovery path at
     * startup, so throwing here would turn a wiped state directory into a service that cannot start
     * rather than one with nothing to recover.
     */
    it('reports nothing, rather than throwing, when its directory is taken away underneath it', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');
      store.save('stream-1', makeRecoveredState('stream-1'));
      fs.rmSync(dir, { recursive: true, force: true });

      assert.deepEqual(store.listActive(), []);
    });
  });

  /**
   * ⛔ The security seam, and the one that had least business being unasserted.
   *
   * A stream id reaches this class from the streaming engine, which takes it from whatever the
   * publisher put in the SRT or RTMP url. Joined onto the state directory unsanitized it is a path
   * traversal: `../../something` would write outside the directory the uploader owns, under an
   * attacker's choice of name, with the uploader's own permissions.
   */
  describe('a stream id is a file name, and is treated as hostile', () => {
    it('cannot be talked into writing outside the directory it was given', () => {
      const root = makeTempRoot();
      const { store, dir } = storeIn(root, 'state');

      store.save('../../escaped', makeRecoveredState('../../escaped'));

      assert.equal(fs.existsSync(path.join(root, 'escaped.json')), false, 'a stream id climbed out of the state dir');
      assert.equal(fs.existsSync(path.join(path.dirname(root), 'escaped.json')), false);
      assert.deepEqual(fs.readdirSync(dir), ['.._.._escaped.json']);
    });

    it('flattens every separator in an id, not only the first', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');

      store.save('live/app/stream', makeRecoveredState('live/app/stream'));

      assert.deepEqual(fs.readdirSync(dir), ['live_app_stream.json'], 'a separator survived into the path');
      assert.notEqual(store.load('live/app/stream'), null, 'the id it was saved under no longer loads it');
    });

    it('flattens a windows separator the same way', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');

      store.save('live\\stream', makeRecoveredState('live\\stream'));

      assert.deepEqual(fs.readdirSync(dir), ['live_stream.json']);
    });

    /**
     * ⚠️ The cost of that flattening, pinned rather than fixed. Sanitizing is not reversible, so a
     * stream saved as `live/stream` is listed as `live_stream`, and recovery resumes it under an id
     * that is not the one it was broadcast with. Two distinct ids also collide onto one file. Neither
     * is reachable today — engine stream keys carry no separator — and both would be silent if that
     * ever changed, which is the reason to write them down here.
     */
    it('lists a sanitized id, which is not the id the stream was saved under', () => {
      const { store } = storeIn(makeTempRoot(), 'state');

      store.save('live/stream', makeRecoveredState('live/stream'));

      assert.deepEqual(store.listActive(), ['live_stream']);
      assert.equal(store.load('live/stream')?.streamId, 'live/stream');
    });

    it('collides two ids that differ only by a separator onto one state', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');

      store.save('live/stream', makeRecoveredState('live/stream'));
      store.save('live_stream', makeRecoveredState('live_stream'));

      assert.equal(fs.readdirSync(dir).length, 1);
      assert.equal(store.load('live/stream')?.streamId, 'live_stream', 'the second save took the first one over');
    });
  });

  /** The state is JSON on disk, so anything the uploader keeps in it has to survive a round trip. */
  it('carries the whole state through, including the fields that are optional', () => {
    const { store } = storeIn(makeTempRoot(), 'state');
    const state: StreamState = {
      ...makeRecoveredState('stream-1'),
      socIndex: null,
      pendingDiscontinuity: true,
      liveManifestStale: true,
      segments: [
        { index: 0, duration: 2.004, ref: 'ref0', discontinuity: false },
        { index: 1, duration: 1.996, ref: 'ref1', discontinuity: true },
      ],
    };

    store.save('stream-1', state);

    assert.deepEqual(store.load('stream-1'), state);
  });
});
