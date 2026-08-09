import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { RecoveryStore } from '../src/libs/RecoveryStore.js';
import { RECOVERY_ENTRY_LOADED, RECOVERY_ENTRY_MISSING, RECOVERY_ENTRY_UNREADABLE, StreamState } from '../src/types.js';

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
   * the crash it was recording is the expected shape here, not an exotic one.
   *
   * ⛔ This is `load`'s answer and it is deliberately lossy: absence and damage collapse to `null`.
   * That collapse is what task #38 was — recovery read `null` and deleted the file. Anything deciding
   * what to *do* with an entry asks {@link RecoveryStore.read} instead, which keeps them apart.
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

  /**
   * ⛔ Task #38, at the layer that caused it.
   *
   * `load` answers `null` for a stream that was never saved and for one whose file is damaged, and
   * the recovery pass read that single `null` as permission to delete. A recovery entry is the only
   * record that a broadcast was live and the only route back to the recording it was building, so
   * deleting it strands the recording, leaves the catalog saying `live` for good, and destroys the
   * evidence that any of it happened.
   */
  describe('telling damage apart from absence', () => {
    it('reports a stream it never saved as missing', () => {
      const { store } = storeIn(makeTempRoot(), 'state');

      assert.deepEqual(store.read('never-seen'), { kind: RECOVERY_ENTRY_MISSING });
    });

    it('reports a state it cannot parse as unreadable, not as missing', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');
      fs.writeFileSync(path.join(dir, 'stream-1.json'), '{"streamId":"stream-1","segm');

      capture(() => {
        assert.deepEqual(store.read('stream-1'), { kind: RECOVERY_ENTRY_UNREADABLE });
      });
    });

    it('hands back the state it holds', () => {
      const { store } = storeIn(makeTempRoot(), 'state');
      const state = makeRecoveredState('stream-1');
      store.save('stream-1', state);

      assert.deepEqual(store.read('stream-1'), { kind: RECOVERY_ENTRY_LOADED, state });
    });
  });

  describe('quarantining an entry that cannot be read', () => {
    /** A damaged entry that is still on disk can be repaired by hand. A deleted one cannot. */
    it('keeps every byte of the entry it moves aside', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');
      const damaged = '{"streamId":"stream-1","segm';
      fs.writeFileSync(path.join(dir, 'stream-1.json'), damaged);

      capture(() => store.quarantine('stream-1'));

      const kept = fs.readdirSync(dir);
      assert.equal(kept.length, 1, 'the damaged entry was deleted rather than kept');
      assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf-8'), damaged);
      assert.notEqual(kept[0], 'stream-1.json', 'the entry was left where the next boot reads it again');
    });

    it('answers with the path it moved the entry to', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');
      fs.writeFileSync(path.join(dir, 'stream-1.json'), 'not json');

      const moved: (string | null)[] = [];
      capture(() => void moved.push(store.quarantine('stream-1')));

      assert.deepEqual(moved, [path.join(dir, 'stream-1.json.corrupt')]);
    });

    /**
     * The move has to take it out of the listing as well as off the recovery path, or the next boot
     * reads it, fails again, and quarantines a file that is already quarantined.
     */
    it('takes the entry out of the recovery listing', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');
      fs.writeFileSync(path.join(dir, 'stream-1.json'), 'not json');
      store.save('stream-2', makeRecoveredState('stream-2'));

      capture(() => store.quarantine('stream-1'));

      assert.deepEqual(store.listActive(), ['stream-2']);
    });

    it('says which stream it quarantined and where it put it', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');
      fs.writeFileSync(path.join(dir, 'stream-1.json'), 'not json');

      const said = capture(() => store.quarantine('stream-1')).join(' ');

      assert.match(said, /stream-1/, 'an operator was told an entry was quarantined but not which one');
    });

    /**
     * A second damaged entry under the same id must not land on top of the first. Overwriting would
     * destroy exactly the evidence this whole path exists to keep.
     */
    it('does not overwrite a damaged copy it already kept', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');
      fs.writeFileSync(path.join(dir, 'stream-1.json'), 'first');
      capture(() => store.quarantine('stream-1'));
      fs.writeFileSync(path.join(dir, 'stream-1.json'), 'second');

      capture(() => store.quarantine('stream-1'));

      const kept = fs
        .readdirSync(dir)
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'))
        .sort();
      assert.deepEqual(kept, ['first', 'second'], 'a damaged entry landed on top of the one kept before it');
    });

    /**
     * ⛔ Leaves the original where it is rather than deleting it. Refusing to move it means the next
     * boot reads it and complains again, which is the correct end state for a directory an operator
     * has stopped looking after: loud and lossless, rather than quiet and lossy.
     */
    it('leaves the entry in place once it has kept as many damaged copies as it will', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');
      for (let attempt = 0; attempt < 12; attempt++) {
        fs.writeFileSync(path.join(dir, 'stream-1.json'), `damaged ${attempt}`);
        capture(() => store.quarantine('stream-1'));
      }

      assert.equal(fs.existsSync(path.join(dir, 'stream-1.json')), true, 'the ceiling deleted what it would not move');
      assert.deepEqual(store.listActive(), ['stream-1']);
    });

    /**
     * Read off disk rather than remembered, so the alarm survives the restart that would otherwise
     * erase it: the entry is still damaged and the broadcast it stands for is still unfinalized.
     */
    it('lists what it is holding, including copies an earlier process put there', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');
      store.save('stream-2', makeRecoveredState('stream-2'));
      fs.writeFileSync(path.join(dir, 'stream-1.json.corrupt'), 'left by an earlier boot');
      fs.writeFileSync(path.join(dir, 'stream-1.json.corrupt.2'), 'and the boot after that');

      assert.deepEqual(store.listQuarantined().sort(), ['stream-1.json.corrupt', 'stream-1.json.corrupt.2']);
    });

    it('holds nothing on a directory where every entry is readable', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');
      store.save('stream-1', makeRecoveredState('stream-1'));
      fs.writeFileSync(path.join(dir, 'stream-2.json.tmp'), 'a save caught in flight');
      fs.writeFileSync(path.join(dir, 'corrupt-notes.txt'), 'a name that merely mentions it');

      assert.deepEqual(store.listQuarantined(), []);
    });

    it('reports nothing, rather than throwing, when its directory is taken away underneath it', () => {
      const { store, dir } = storeIn(makeTempRoot(), 'state');
      fs.rmSync(dir, { recursive: true, force: true });

      assert.deepEqual(store.listQuarantined(), []);
    });

    it('answers null rather than throwing when there is nothing to quarantine', () => {
      const { store } = storeIn(makeTempRoot(), 'state');

      const answered: (string | null)[] = [];
      const said = capture(() => void answered.push(store.quarantine('never-seen')));

      assert.deepEqual(answered, [null]);
      assert.notDeepEqual(said, [], 'a quarantine that could not happen passed in silence');
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
