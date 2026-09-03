import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BroadcastDating, reanchorEpoch, withEpoch } from '../src/libs/broadcastDating.js';
import { LIVE_WINDOW_MAX_BYTES, ManifestManager } from '../src/libs/ManifestManager.js';
import { BroadcastAnchor } from '../src/types.js';

import { TEST_ANCHOR } from './helpers/fakes.js';

const DISCONTINUITY_TAG = '#EXT-X-DISCONTINUITY';
const PROGRAM_DATE_TIME_TAG = '#EXT-X-PROGRAM-DATE-TIME';

/** The wall clock {@link TEST_ANCHOR} puts on the segment at this playlist sequence. */
function pdtLineAt(sequence: number): string {
  return pdtLineAtMs(TEST_ANCHOR.startedAtMs + sequence * TEST_ANCHOR.fragmentSeconds * 1000);
}

function pdtLineAtMs(epochMs: number): string {
  return `${PROGRAM_DATE_TIME_TAG}:${new Date(epochMs).toISOString()}`;
}

/**
 * A restart's dating pinned to one instant, standing in for the one the orchestrator shares across
 * a ladder, and recording what it was asked so a test can read the floor the manager offered.
 */
function pinnedDating(atMs: number): BroadcastDating & { asked: { resumeAt: number; notBeforeMs: number }[] } {
  const asked: { resumeAt: number; notBeforeMs: number }[] = [];
  return {
    asked,
    epochFrom(resumeAt, notBeforeMs) {
      asked.push({ resumeAt, notBeforeMs });
      return { fromSequence: resumeAt, atMs };
    },
  };
}

/**
 * A dating two managers share the way a ladder's rungs share the orchestrator's: the first rung to
 * re-anchor mints the restart's line and every other rung lands on it.
 */
function ladderDating(anchor: BroadcastAnchor, nowMs: () => number): BroadcastDating {
  let held = anchor;
  return {
    epochFrom(resumeAt, notBeforeMs) {
      const epoch = reanchorEpoch(held, { resumeAt, nowMs: nowMs(), notBeforeMs });
      held = withEpoch(held, epoch);
      return epoch;
    },
  };
}

/** Every `#EXT-X-PROGRAM-DATE-TIME` a manifest carries, in playlist order, as epoch milliseconds. */
function programDateTimesOf(manifest: string): number[] {
  return manifest
    .split('\n')
    .filter((line) => line.startsWith(`${PROGRAM_DATE_TIME_TAG}:`))
    .map((line) => Date.parse(line.slice(PROGRAM_DATE_TIME_TAG.length + 1)));
}

/**
 * Every segment length this project has published a profile for, shortest first.
 *
 * The window is a byte budget, so what it holds in seconds is different at every one of these, and
 * a test fixing on a single length would miss exactly the case the budget exists for.
 */
const SHIPPED_SEGMENT_DURATIONS_S = [0.25, 0.5, 1, 2];

/** The shortest of them, which is the winning profile of `docs/bench/quarter-second-2026-08-05.md`. */
const SHORTEST_SEGMENT_DURATION_S = SHIPPED_SEGMENT_DURATIONS_S[0];

const PLAYER_CONFIG_PATH = '../../client/src/components/SwarmHlsPlayer/playerConfig.ts';
const LIVE_SYNC_DURATION_EXPORT = 'LIVE_SYNC_DURATION_S';

/** The engine's own sequence number for a segment, which is what `addSegment` is handed. */
function feed(manager: ManifestManager, from: number, count: number, duration = 1.5): void {
  for (let i = 0; i < count; i++) {
    manager.addSegment(from + i, duration, `ref-${from + i}`);
  }
}

function mediaSequenceOf(manifest: string): number {
  const line = manifest.split('\n').find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
  assert.ok(line, 'manifest must carry an EXT-X-MEDIA-SEQUENCE');
  return Number.parseInt(line!.split(':')[1], 10);
}

function segmentUris(manifest: string): string[] {
  return manifest
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.trim());
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** A Swarm reference as the uploader writes one: `result.reference.toHex()`, 64 hex characters. */
function ref(index: number): string {
  return index.toString(16).padStart(64, '0');
}

function withSegments(count: number, duration: number): ManifestManager {
  const manager = new ManifestManager(TEST_ANCHOR);
  for (let i = 0; i < count; i++) {
    manager.addSegment(i, duration, ref(i));
  }
  return manager;
}

describe('ManifestManager media sequence', () => {
  it('starts the broadcast at zero', () => {
    const manager = new ManifestManager(TEST_ANCHOR);
    feed(manager, 0, 3);

    assert.equal(mediaSequenceOf(manager.buildLiveManifest()), 0);
  });

  /**
   * The whole of the sequence-zero decision. SRS's counter runs on across broadcasts for as long as
   * its process lives, so a warm engine opens a broadcast at whatever number the previous one ended
   * on: six recordings of this stage opened at 210, 317, 416, 580, 707 and 850. Abel's player wants
   * a history starting at 0, and only the uploader knows where a broadcast began.
   */
  it('starts at zero however high the engine’s own counter has climbed', () => {
    const manager = new ManifestManager(TEST_ANCHOR);
    feed(manager, 850, 3);

    assert.equal(mediaSequenceOf(manager.buildLiveManifest()), 0);
  });

  it('starts the VOD manifest at zero too, on the same numbering as the live playlists', () => {
    // The two have to agree. A viewer whose live playlist ends is handed the closing playlist and
    // then the recording, and hls.js reports a media sequence that moves between them as a parsing
    // error rather than as a change of resource, which the client answers by remounting the player.
    const manager = new ManifestManager(TEST_ANCHOR);
    feed(manager, 4, 3);

    assert.equal(mediaSequenceOf(manager.buildVODManifest()), 0);
    assert.equal(mediaSequenceOf(manager.buildLiveManifest()), 0);
  });

  // The sliding-window case is covered by 'names the count it dropped as the media sequence' in the
  // live-window suite above. ABR's version asserted a media sequence of 4 after 14 segments, which
  // assumes a window bounded at ten segments. This branch bounds the window by BYTES, at one bee
  // chunk, so fourteen short refs all fit and it never slides. The surviving test derives its
  // expectation from what the window actually kept rather than hard-coding a length.

  it('moves the rungs of one ladder together, all of them starting at zero', () => {
    // Both rungs of one broadcast, whose engines number their own streams independently: SRS runs a
    // counter per rung stream, so 1080p can be at 850 while 360p is at 12. They must still advertise
    // the same sequence for the same media, because that number is what tells hls.js the two levels
    // share a timeline, and a switch lands wherever the two disagree.
    const tall = new ManifestManager(TEST_ANCHOR);
    const short = new ManifestManager(TEST_ANCHOR);

    feed(tall, 850, 5);
    feed(short, 12, 5);

    assert.equal(mediaSequenceOf(tall.buildLiveManifest()), 0);
    assert.equal(mediaSequenceOf(short.buildLiveManifest()), 0);
  });

  it('uses the first segment it holds even when segments arrive out of order', () => {
    const manager = new ManifestManager(TEST_ANCHOR);
    manager.addSegment(7, 1.5, 'ref-7');
    manager.addSegment(5, 1.5, 'ref-5');
    manager.addSegment(6, 1.5, 'ref-6');

    const manifest = manager.buildLiveManifest();

    assert.equal(mediaSequenceOf(manifest), 0);
    assert.deepEqual(segmentUris(manifest), ['ref-5', 'ref-6', 'ref-7']);
  });

  it('survives a restore, which is where the sequence numbers come back from disk', () => {
    const manager = new ManifestManager(TEST_ANCHOR);
    manager.restoreState(
      [
        { index: 11, duration: 1.5, ref: 'ref-11', sequence: 4 },
        { index: 12, duration: 1.5, ref: 'ref-12', sequence: 5 },
      ],
      ['#EXTM3U', '#EXT-X-VERSION:3'],
    );

    // Restored rather than recomputed. These two numbers were already published, so renumbering them
    // to 0 would move what every sequence a viewer already holds refers to.
    assert.equal(mediaSequenceOf(manager.buildLiveManifest()), 4);
  });

  it('recovers the numbering of an entry written before the sequence was persisted', () => {
    const manager = new ManifestManager(TEST_ANCHOR);
    manager.restoreState(
      [
        { index: 11, duration: 1.5, ref: 'ref-11' },
        { index: 12, duration: 1.5, ref: 'ref-12' },
      ],
      ['#EXTM3U', '#EXT-X-VERSION:3'],
    );

    assert.equal(mediaSequenceOf(manager.buildLiveManifest()), 0);
  });

  it('returns nothing at all before the first segment, rather than a headers-only playlist', () => {
    const manager = new ManifestManager(TEST_ANCHOR);

    assert.equal(manager.buildLiveManifest(), '');
    assert.equal(manager.buildVODManifest(), '');
  });
});

/**
 * The engine restarting inside one broadcast, which resets its counter to 0.
 *
 * ⛔ `#EXT-X-MEDIA-SEQUENCE` must never move backwards. hls.js reports one that does as a parsing
 * error, escalates it to fatal on a single-variant stream, and the client answers a fatal parsing
 * error by remounting the player, which restarts playback at the beginning.
 */
describe('an engine that restarts mid-broadcast and starts counting again', () => {
  const STEP_MS = TEST_ANCHOR.fragmentSeconds * 1000;
  /** When the engine came back, well past where the pre-restart dating had reached. */
  const RESTARTED_AT_MS = TEST_ANCHOR.startedAtMs + 600_000;

  /** A session that has been live long enough to have published its numbering. */
  function livePast(count: number, dating: BroadcastDating = pinnedDating(RESTARTED_AT_MS)): ManifestManager {
    const manager = new ManifestManager(TEST_ANCHOR, dating);
    feed(manager, 0, count, 2);
    manager.buildLiveManifest();
    return manager;
  }

  it('continues the sequence forwards rather than repeating a published number', () => {
    const manager = livePast(5);

    manager.addSegment(0, 2, 'after-restart-0', true);

    assert.equal(mediaSequenceOf(manager.buildLiveManifest()), 0);
    assert.deepEqual(segmentUris(manager.buildLiveManifest()).at(-1), 'after-restart-0');
  });

  it('keeps the numbering rising across the whole restart', () => {
    const manager = livePast(5);

    manager.addSegment(0, 2, 'after-restart-0', true);
    manager.addSegment(1, 2, 'after-restart-1');

    assert.deepEqual(
      manager.getState().segments.map((seg) => seg.sequence),
      [0, 1, 2, 3, 4, 5, 6],
    );
  });

  it('files the post-restart media after the media it follows, not in front of it', () => {
    const manager = livePast(3);

    manager.addSegment(0, 2, 'after-restart-0', true);

    assert.deepEqual(segmentUris(manager.buildLiveManifest()), ['ref-0', 'ref-1', 'ref-2', 'after-restart-0']);
  });

  it('dates the post-restart media from the restart’s own wall clock, not from the reset engine index', () => {
    const manager = livePast(5);

    manager.addSegment(0, 2, 'after-restart-0', true);
    manager.addSegment(1, 2, 'after-restart-1');

    assert.deepEqual(programDateTimesOf(manager.buildLiveManifest()).slice(-2), [
      RESTARTED_AT_MS,
      RESTARTED_AT_MS + STEP_MS,
    ]);
  });

  it('marks the restart as a discontinuity, as the caller asked', () => {
    const manager = livePast(3);

    manager.addSegment(0, 2, 'after-restart-0', true);

    const manifest = manager.buildLiveManifest();

    assert.ok(
      manifest.includes(`${DISCONTINUITY_TAG}\n${pdtLineAtMs(RESTARTED_AT_MS)}\n#EXTINF:2,\nafter-restart-0`),
      `the restart lost its break or its wall clock, got:\n${manifest}`,
    );
  });

  /**
   * A recovered session is settled the moment it is restored: its numbers are on disk and, for all
   * this session can tell, in a feed a viewer is reading. So the engine's reset is read as a reset
   * rather than as an out-of-order arrival, which is what the same index means before anything has
   * been published.
   */
  it('reads the reset as a reset in a session rebuilt from a recovery entry', () => {
    const manager = new ManifestManager(TEST_ANCHOR, pinnedDating(RESTARTED_AT_MS));
    manager.restoreState(
      [
        { index: 100, duration: 2, ref: 'ref-100', sequence: 0 },
        { index: 101, duration: 2, ref: 'ref-101', sequence: 1 },
      ],
      ['#EXTM3U', '#EXT-X-VERSION:3'],
    );

    manager.addSegment(0, 2, 'after-restart-0', true);

    assert.deepEqual(segmentUris(manager.buildLiveManifest()), ['ref-100', 'ref-101', 'after-restart-0']);
    assert.equal(programDateTimesOf(manager.buildLiveManifest()).at(-1), RESTARTED_AT_MS);
  });

  it('keeps the recording on the same numbering as the live playlists after a restart', () => {
    const manager = livePast(3);
    manager.addSegment(0, 2, 'after-restart-0', true);

    const vod = manager.buildVODManifest();

    assert.equal(mediaSequenceOf(vod), 0);
    assert.deepEqual(segmentUris(vod), ['ref-0', 'ref-1', 'ref-2', 'after-restart-0']);
  });
});

/**
 * The dating a restart moves on to, which is the owner's decision of 2026-09-03.
 *
 * ⛔ Before it, the date kept stepping from the instant the broadcast was admitted, so the media
 * after an engine restart carried a time behind real time by the whole length of the gap, without
 * bound. It re-anchors now: the first segment after the restart is dated at the wall clock it
 * arrived at, and the segments after it step one fragment from there.
 *
 * ⛔ What must not change is that every rung of one ladder dates a given sequence identically, so
 * the restart's dating is minted once for the whole ladder and each rung lands on that one line
 * wherever its own numbering had reached. See `broadcastDating.ts`.
 */
describe('the dating a broadcast re-anchors to when the engine restarts inside it', () => {
  const STEP_MS = TEST_ANCHOR.fragmentSeconds * 1000;
  const RESTARTED_AT_MS = TEST_ANCHOR.startedAtMs + 600_000;

  function livePast(count: number, dating: BroadcastDating): ManifestManager {
    const manager = new ManifestManager(TEST_ANCHOR, dating);
    feed(manager, 0, count, 2);
    manager.buildLiveManifest();
    return manager;
  }

  it('leaves the media published before the restart on the dates it went out with', () => {
    const manager = livePast(3, pinnedDating(RESTARTED_AT_MS));

    manager.addSegment(0, 2, 'after-restart-0', true);

    assert.deepEqual(programDateTimesOf(manager.buildLiveManifest()), [
      TEST_ANCHOR.startedAtMs,
      TEST_ANCHOR.startedAtMs + STEP_MS,
      TEST_ANCHOR.startedAtMs + 2 * STEP_MS,
      RESTARTED_AT_MS,
    ]);
  });

  /**
   * The floor the manager offers is the date the resuming sequence would have carried, which is one
   * fragment past the newest segment it has dated. A dating that had run ahead of the wall clock
   * cannot then be pulled backwards, which hls.js reads as a parsing error rather than as a restart.
   */
  it('offers the date the resuming sequence would have carried as the floor', () => {
    const dating = pinnedDating(RESTARTED_AT_MS);
    const manager = livePast(3, dating);

    manager.addSegment(0, 2, 'after-restart-0', true);

    assert.deepEqual(dating.asked, [{ resumeAt: 3, notBeforeMs: TEST_ANCHOR.startedAtMs + 3 * STEP_MS }]);
  });

  it('asks its dating once per restart rather than once per segment', () => {
    const dating = pinnedDating(RESTARTED_AT_MS);
    const manager = livePast(3, dating);

    manager.addSegment(0, 2, 'after-restart-0', true);
    manager.addSegment(1, 2, 'after-restart-1');
    manager.addSegment(2, 2, 'after-restart-2');

    assert.equal(dating.asked.length, 1);
  });

  it('dates the recording from the same line the live playlists used', () => {
    const manager = livePast(3, pinnedDating(RESTARTED_AT_MS));
    manager.addSegment(0, 2, 'after-restart-0', true);
    manager.addSegment(1, 2, 'after-restart-1');

    assert.deepEqual(programDateTimesOf(manager.buildVODManifest()), [
      TEST_ANCHOR.startedAtMs,
      TEST_ANCHOR.startedAtMs + STEP_MS,
      TEST_ANCHOR.startedAtMs + 2 * STEP_MS,
      RESTARTED_AT_MS,
      RESTARTED_AT_MS + STEP_MS,
    ]);
  });

  it('dates the closing playlist a live viewer is handed from it too', () => {
    const manager = livePast(3, pinnedDating(RESTARTED_AT_MS));
    manager.addSegment(0, 2, 'after-restart-0', true);

    assert.equal(programDateTimesOf(manager.buildClosingLiveManifest()).at(-1), RESTARTED_AT_MS);
  });

  /**
   * The one thing a rung has to carry out of a restart, because a crash after one would otherwise
   * restore the dating the broadcast opened on and re-date every post-restart segment back into the
   * lag. See `StreamUploader.getStreamState`.
   */
  it('carries the re-anchoring on the anchor it hands out for persistence', () => {
    const manager = livePast(3, pinnedDating(RESTARTED_AT_MS));

    manager.addSegment(0, 2, 'after-restart-0', true);

    assert.deepEqual(manager.broadcastAnchor(), {
      ...TEST_ANCHOR,
      epochs: [{ fromSequence: 3, atMs: RESTARTED_AT_MS }],
    });
  });

  it('dates a session rebuilt from an entry that already re-anchored from the same line', () => {
    const restored = new ManifestManager(
      { ...TEST_ANCHOR, epochs: [{ fromSequence: 3, atMs: RESTARTED_AT_MS }] },
      pinnedDating(RESTARTED_AT_MS),
    );
    restored.restoreState(
      [
        { index: 0, duration: 2, ref: 'ref-0', sequence: 0 },
        { index: 0, duration: 2, ref: 'after-restart-0', sequence: 3, discontinuity: true },
      ],
      ['#EXTM3U', '#EXT-X-VERSION:3'],
    );

    restored.addSegment(1, 2, 'after-restart-1');

    assert.deepEqual(programDateTimesOf(restored.buildLiveManifest()), [
      TEST_ANCHOR.startedAtMs,
      RESTARTED_AT_MS,
      RESTARTED_AT_MS + STEP_MS,
    ]);
  });

  /**
   * ⛔ The property the whole shape exists for. Two rungs of one ladder cross the same restart with
   * their own numbering at their own places, and they must still put the same date on the same
   * sequence, because hls.js reads four rungs disagreeing about one segment as four rungs covering
   * different media.
   */
  describe('two rungs of one ladder crossing the same restart', () => {
    /** The 1080p rung is the slow one, so it is the rung that gets one fewer segment out before the engine dies. */
    function twoRungs(behindBy: number, secondsApart: number) {
      let nowMs = RESTARTED_AT_MS;
      const dating = ladderDating(TEST_ANCHOR, () => nowMs);

      const fast = livePast(5, dating);
      const slow = livePast(5 - behindBy, dating);

      fast.addSegment(0, 2, 'fast-after-restart', true);
      nowMs += secondsApart * 1000;
      slow.addSegment(0, 2, 'slow-after-restart', true);

      return { fast, slow };
    }

    it('dates the same sequence identically when both resume at the same one', () => {
      const { fast, slow } = twoRungs(0, 2);

      assert.deepEqual(
        programDateTimesOf(slow.buildLiveManifest()),
        programDateTimesOf(fast.buildLiveManifest()),
        'the rungs took two readings of the clock, so a level switch lands on media dated somewhere else',
      );
    });

    it('puts the rung that is one sequence behind one fragment earlier on that same line', () => {
      const { fast, slow } = twoRungs(1, 2);

      assert.equal(programDateTimesOf(fast.buildLiveManifest()).at(-1), RESTARTED_AT_MS);
      assert.equal(programDateTimesOf(slow.buildLiveManifest()).at(-1), RESTARTED_AT_MS - STEP_MS);
    });

    it('keeps the rung that is one behind moving forwards from the segment in front of it', () => {
      const { slow } = twoRungs(1, 2);

      const stamps = programDateTimesOf(slow.buildLiveManifest());

      assert.ok(
        stamps.every((stamp, i) => i === 0 || stamp > stamps[i - 1]),
        `the rung dated its resuming segment at or before the one in front of it: ${stamps.join(', ')}`,
      );
    });

    it('agrees on the sequences they both publish after the restart', () => {
      const { fast, slow } = twoRungs(1, 2);

      fast.addSegment(1, 2, 'fast-1');
      slow.addSegment(1, 2, 'slow-1');
      slow.addSegment(2, 2, 'slow-2');

      const fastStamps = programDateTimesOf(fast.buildLiveManifest());
      const slowStamps = programDateTimesOf(slow.buildLiveManifest());

      assert.equal(fastStamps.at(-1), slowStamps.at(-1), 'sequence 6 is dated differently on the two rungs');
    });
  });
});

describe('ManifestManager discontinuity handling', () => {
  it('emits a discontinuity tag before a flagged segment in the VOD manifest', () => {
    const manager = new ManifestManager(TEST_ANCHOR);
    manager.addSegment(0, 2, 'ref0');
    manager.addSegment(1, 2, 'ref1', true);
    manager.addSegment(2, 2, 'ref2');

    const manifest = manager.buildVODManifest();

    // The break comes first and the wall clock after it, which is the order RFC 8216 §4.3.2.6 wants:
    // the stamp dates the media that resumes, so it belongs on the far side of the break.
    assert.ok(manifest.includes(`${DISCONTINUITY_TAG}\n${pdtLineAt(1)}\n#EXTINF:2,\nref1`));
    assert.equal(countOccurrences(manifest, DISCONTINUITY_TAG), 1);
    assert.ok(!manifest.includes(`${DISCONTINUITY_TAG}\n${pdtLineAt(0)}\n#EXTINF:2,\nref0`));
  });

  it('emits a discontinuity tag before a flagged segment in the live manifest', () => {
    const manager = new ManifestManager(TEST_ANCHOR);
    manager.addSegment(0, 2, 'ref0');
    manager.addSegment(1, 2, 'ref1', true);

    const manifest = manager.buildLiveManifest();

    assert.ok(manifest.includes(`${DISCONTINUITY_TAG}\n${pdtLineAt(1)}\n#EXTINF:2,\nref1`));
    assert.equal(countOccurrences(manifest, DISCONTINUITY_TAG), 1);
  });

  it('does not emit a discontinuity tag when no segment is flagged', () => {
    const manager = new ManifestManager(TEST_ANCHOR);
    manager.addSegment(0, 2, 'ref0');
    manager.addSegment(1, 2, 'ref1');

    assert.equal(countOccurrences(manager.buildVODManifest(), DISCONTINUITY_TAG), 0);
    assert.equal(countOccurrences(manager.buildLiveManifest(), DISCONTINUITY_TAG), 0);
  });
});

describe('the live window is bounded by bytes rather than by a segment count', () => {
  for (const duration of SHIPPED_SEGMENT_DURATIONS_S) {
    it(`fits in one single-owner chunk at a ${duration}s segment, however long the broadcast runs`, () => {
      const manifest = withSegments(500, duration).buildLiveManifest();

      assert.ok(
        Buffer.byteLength(manifest, 'utf-8') <= LIVE_WINDOW_MAX_BYTES,
        `a ${Buffer.byteLength(manifest, 'utf-8')} byte manifest costs three round trips per publish ` +
          `instead of one, ${LIVE_WINDOW_MAX_BYTES} times per second`,
      );
    });

    it(`spends most of the chunk it is given at a ${duration}s segment`, () => {
      const used = Buffer.byteLength(withSegments(500, duration).buildLiveManifest(), 'utf-8');

      assert.ok(
        used > LIVE_WINDOW_MAX_BYTES * 0.9,
        `the window used ${used} of ${LIVE_WINDOW_MAX_BYTES} bytes, so a viewer is being given less ` +
          'catch-up media than the same single chunk would carry for free',
      );
    });
  }

  it('keeps the newest segments and drops the oldest', () => {
    const uris = segmentUris(withSegments(500, 2).buildLiveManifest());

    assert.equal(uris[uris.length - 1], ref(499));
    assert.deepEqual(
      uris,
      Array.from({ length: uris.length }, (_, i) => ref(500 - uris.length + i)),
    );
  });

  it('names the count it dropped as the media sequence', () => {
    const manifest = withSegments(500, 2).buildLiveManifest();

    assert.equal(mediaSequenceOf(manifest), 500 - segmentUris(manifest).length);
  });

  it('holds every segment while they still fit, and starts at media sequence zero', () => {
    const manifest = withSegments(3, 2).buildLiveManifest();

    assert.deepEqual(segmentUris(manifest), [ref(0), ref(1), ref(2)]);
    assert.equal(mediaSequenceOf(manifest), 0);
  });

  it('holds more media at a shorter segment than the ten it replaced', () => {
    const held = segmentUris(withSegments(500, SHORTEST_SEGMENT_DURATION_S).buildLiveManifest()).length;

    assert.ok(held > 10, `held ${held} segments, which is no better than the fixed count it replaces`);
  });

  /**
   * A segment line is a duration and a reference, so no live sequence can spend the whole budget on
   * one. `restoreState` can, because it takes its headers from a manifest recovered off disk, and a
   * header that spends the budget leaves every segment overrunning what is left.
   *
   * This used to reach the same state through a 4KB `MANIFEST_ACCESS_URL`. That variable is gone,
   * and the path that remains is the one external input can actually reach.
   */
  it('still emits a segment when the header alone overruns the budget', () => {
    const manager = withSegments(3, 2);
    const { segments } = manager.getState();
    manager.restoreState(segments, ['#EXTM3U', `#EXT-X-SESSION-DATA:${'p'.repeat(LIVE_WINDOW_MAX_BYTES)}`]);

    assert.equal(segmentUris(manager.buildLiveManifest()).length, 1);
  });

  it('leaves the VOD manifest whole, since it is published once rather than per segment', () => {
    assert.equal(segmentUris(withSegments(500, 2).buildVODManifest()).length, 500);
  });
});

/**
 * The window is also the client's gap-repair budget, and nothing measured it.
 *
 * A viewer only ever learns of a segment that appears in some manifest it reads, and it reads every
 * feed slot. `uploadLiveManifest` coalesces behind `liveManifestQueued` while a publish is in flight,
 * and `MANIFEST_UPLOAD_RETRY_WINDOW_MS` lets one publish occupy 15 seconds, so segments can be
 * produced and uploaded faster than the window that names them advances. The bytes are in Swarm and
 * perfectly retrievable. No viewer is ever told the address.
 */
describe('segments the window slid past before anything named them', () => {
  it('reports none while every segment still fits', () => {
    assert.equal(withSegments(3, 2).segmentsNeverNamed(0), 0);
  });

  it('counts the segments between the last announced one and the window', () => {
    const manager = withSegments(500, 2);
    const held = segmentUris(manager.buildLiveManifest()).length;

    // Announced through segment 100, and the window now starts at 500 - held.
    assert.equal(manager.segmentsNeverNamed(100), 500 - held - 101);
  });

  it('reports none when the last announced segment is still inside the window', () => {
    const manager = withSegments(500, 2);
    const first = 500 - segmentUris(manager.buildLiveManifest()).length;

    assert.equal(manager.segmentsNeverNamed(first), 0);
    assert.equal(manager.segmentsNeverNamed(499), 0);
  });

  // A segment whose own upload failed was never added, and `recordSegmentDropped` already owns it.
  // Counting the hole it left here would report the same loss twice under two different causes.
  it('counts only segments it actually holds, so a dropped one is not counted twice', () => {
    const manager = new ManifestManager(TEST_ANCHOR);
    for (let i = 0; i < 500; i++) {
      if (i !== 50 && i !== 51) {
        manager.addSegment(i, 2, ref(i));
      }
    }
    const held = segmentUris(manager.buildLiveManifest()).length;
    const total = 498;

    assert.equal(manager.segmentsNeverNamed(0), total - held - 1);
  });

  it('names the newest segment the window reaches, which is what was announced', () => {
    assert.equal(withSegments(500, 2).liveWindowNewestIndex(), 499);
    assert.equal(new ManifestManager(TEST_ANCHOR).liveWindowNewestIndex(), null);
  });
});

/**
 * The one number this side does not own.
 *
 * hls.js holds playback `liveSyncDuration` behind the live edge, and clamps that position to the
 * start of the playlist, so a first manifest holding less media than the client asks for puts every
 * joining viewer at the live edge with no runway. The two constants live in different packages and
 * nothing at runtime relates them, which is how a segment count and a seconds target drifted into
 * opposite directions in the first place.
 *
 * Read out of the client's own source rather than mirrored, for the reason
 * `e2e/test/clientTuning.test.ts` records: a constant asserted against a second copy of itself
 * cannot fail.
 */
describe('the window covers the buffer the client asks for', () => {
  const source = readFileSync(join(import.meta.dirname, PLAYER_CONFIG_PATH), 'utf8');
  const declared = new RegExp(`export const ${LIVE_SYNC_DURATION_EXPORT}\\s*=\\s*([0-9.]+)\\s*;`).exec(source);

  it('finds the target the client configures', () => {
    assert.ok(declared, `could not read a numeric ${LIVE_SYNC_DURATION_EXPORT} out of ${PLAYER_CONFIG_PATH}`);
  });

  it('holds that many seconds at the shortest segment length shipped', () => {
    const target = Number(declared?.[1]);
    const held = segmentUris(withSegments(500, SHORTEST_SEGMENT_DURATION_S).buildLiveManifest()).length;
    const seconds = held * SHORTEST_SEGMENT_DURATION_S;

    assert.ok(
      seconds >= target,
      `at a ${SHORTEST_SEGMENT_DURATION_S}s segment the window holds ${seconds}s of media and the ` +
        `client asks to sit ${target}s behind the live edge, so it cannot reach its own target. ` +
        'Shorten the segment length the deployment runs, or lower the client target.',
    );
  });
});

/**
 * A broadcast ends into a feed that live viewers are still walking, so the manifest that ends it is
 * read as the next update of the one they are playing. hls.js merges a live playlist against its
 * predecessor and raises `media sequence mismatch` when the sequence moves backwards, which its
 * error controller escalates to fatal on a single-variant stream because there is no level to switch
 * to. The client answers a fatal parsing error by remounting the player, and a remounted player
 * starts at the beginning. That is why the end of a broadcast used to rewind the viewer to zero.
 */
describe('ending a broadcast that live viewers are still following', () => {
  const ENDLIST_TAG = '#EXT-X-ENDLIST';
  const PLAYLIST_TYPE_VOD_TAG = '#EXT-X-PLAYLIST-TYPE:VOD';

  it('leaves the media sequence exactly where the live manifest had it', () => {
    const manager = withSegments(500, SHORTEST_SEGMENT_DURATION_S);

    assert.equal(mediaSequenceOf(manager.buildClosingLiveManifest()), mediaSequenceOf(manager.buildLiveManifest()));
  });

  it('names the same segments the live manifest named', () => {
    const manager = withSegments(500, SHORTEST_SEGMENT_DURATION_S);

    assert.deepEqual(segmentUris(manager.buildClosingLiveManifest()), segmentUris(manager.buildLiveManifest()));
  });

  it('ends the playlist, so a player stops reloading it instead of following a dead feed', () => {
    assert.ok(withSegments(10, 2).buildClosingLiveManifest().includes(ENDLIST_TAG));
  });

  /** A live playlist that has ended is still a live playlist. Calling it VOD restarts the player. */
  it('does not relabel the playlist as VOD', () => {
    assert.ok(!withSegments(10, 2).buildClosingLiveManifest().includes(PLAYLIST_TYPE_VOD_TAG));
  });

  it('says nothing when there was never a segment to end', () => {
    assert.equal(new ManifestManager(TEST_ANCHOR).buildClosingLiveManifest(), '');
  });

  /** The recording is a separate resource with a separate reader, and it is not what changed. */
  it('leaves the VOD manifest starting at zero and naming everything', () => {
    const manager = withSegments(500, SHORTEST_SEGMENT_DURATION_S);

    assert.equal(mediaSequenceOf(manager.buildVODManifest()), 0);
    assert.equal(segmentUris(manager.buildVODManifest()).length, 500);
  });
});

/**
 * The wall clock every playlist now carries, and the two things it is derived from.
 *
 * ⛔ Both terms are nominal. The instant is the broadcast's, handed in once for the whole ladder,
 * and the step is the fragment length the deployment declared. Neither is read off a segment, which
 * is what lets four rungs date the same media identically while their uploads land milliseconds
 * apart.
 */
describe('every segment carries a program date-time derived from the broadcast anchor', () => {
  const ANCHOR = { startedAtMs: Date.UTC(2026, 8, 1, 12, 0, 0), fragmentSeconds: 2 };
  const STEP_MS = ANCHOR.fragmentSeconds * 1000;

  function anchored(): ManifestManager {
    return new ManifestManager(ANCHOR);
  }

  it('stamps the first segment with the anchor itself', () => {
    const manager = anchored();
    manager.addSegment(0, 2, ref(0));

    assert.deepEqual(programDateTimesOf(manager.buildLiveManifest()), [TEST_ANCHOR.startedAtMs]);
  });

  it('steps by the declared fragment length, not by the segment’s own EXTINF', () => {
    const manager = anchored();
    // Half the declared fragment, which is what a force-closed segment looks like. The stamp must
    // not follow it: a rung whose encoder cut short would otherwise drift away from its siblings.
    feed(manager, 0, 3, 1);

    assert.deepEqual(programDateTimesOf(manager.buildLiveManifest()), [
      TEST_ANCHOR.startedAtMs,
      TEST_ANCHOR.startedAtMs + STEP_MS,
      TEST_ANCHOR.startedAtMs + 2 * STEP_MS,
    ]);
  });

  it('writes UTC to the millisecond, which is what a sub-second fragment needs', () => {
    const manager = new ManifestManager({ startedAtMs: TEST_ANCHOR.startedAtMs, fragmentSeconds: 0.5 });
    feed(manager, 0, 2, 0.5);

    const manifest = manager.buildLiveManifest();

    assert.ok(manifest.includes(`${PROGRAM_DATE_TIME_TAG}:2026-09-01T12:00:00.000Z`), manifest);
    assert.ok(manifest.includes(`${PROGRAM_DATE_TIME_TAG}:2026-09-01T12:00:00.500Z`), manifest);
  });

  /**
   * The defect the tag exists to prevent. Two rungs of one ladder date the same media alike because
   * both derive from the anchor their group shares, whatever their own uploads did.
   */
  it('dates the same media alike on two rungs of one ladder', () => {
    const tall = anchored();
    const short = anchored();

    feed(tall, 0, 5, 2);
    feed(short, 0, 5, 1.98);

    assert.deepEqual(programDateTimesOf(tall.buildLiveManifest()), programDateTimesOf(short.buildLiveManifest()));
  });

  it('stamps every segment of the recording too, not only the live playlist', () => {
    const manager = anchored();
    feed(manager, 0, 4, 2);

    const vod = manager.buildVODManifest();

    assert.deepEqual(programDateTimesOf(vod).length, segmentUris(vod).length);
    assert.deepEqual(programDateTimesOf(vod)[3], TEST_ANCHOR.startedAtMs + 3 * STEP_MS);
  });

  it('stamps every segment of the closing playlist', () => {
    const manager = anchored();
    feed(manager, 0, 4, 2);

    const closing = manager.buildClosingLiveManifest();

    assert.equal(programDateTimesOf(closing).length, segmentUris(closing).length);
  });

  it('keeps one stamp per segment as the window slides, still on the broadcast’s own clock', () => {
    const manager = anchored();
    feed(manager, 0, 500, 2);

    const manifest = manager.buildLiveManifest();
    const stamps = programDateTimesOf(manifest);

    assert.equal(stamps.length, segmentUris(manifest).length);
    assert.ok(stamps.length < 500, 'the window did not slide, so this proves nothing about sliding');
    assert.equal(stamps[stamps.length - 1], TEST_ANCHOR.startedAtMs + 499 * STEP_MS);
  });

  it('holds the anchor across a restore, so a recovered broadcast is not re-dated', () => {
    const manager = anchored();
    feed(manager, 0, 3, 2);
    const state = manager.getState();

    const recovered = anchored();
    recovered.restoreState(state.segments, state.hlsHeaders);
    recovered.addSegment(3, 2, ref(3));

    assert.deepEqual(programDateTimesOf(recovered.buildLiveManifest()), [
      TEST_ANCHOR.startedAtMs,
      TEST_ANCHOR.startedAtMs + STEP_MS,
      TEST_ANCHOR.startedAtMs + 2 * STEP_MS,
      TEST_ANCHOR.startedAtMs + 3 * STEP_MS,
    ]);
  });

  /**
   * A recovery entry written before the sequence was persisted alongside the index. Its offset is
   * recovered from the first segment it holds, which is what the sequence was then, so the restored
   * history keeps the stamps it already published.
   */
  it('dates a recovery entry that predates the sequence from the first segment it holds', () => {
    const manager = anchored();
    manager.restoreState(
      [
        { index: 11, duration: 2, ref: ref(11) },
        { index: 12, duration: 2, ref: ref(12) },
      ],
      ['#EXTM3U', '#EXT-X-VERSION:3'],
    );

    assert.deepEqual(programDateTimesOf(manager.buildLiveManifest()), [
      TEST_ANCHOR.startedAtMs,
      TEST_ANCHOR.startedAtMs + STEP_MS,
    ]);
  });
});
