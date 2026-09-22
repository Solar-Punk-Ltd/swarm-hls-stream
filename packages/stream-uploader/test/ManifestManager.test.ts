import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BroadcastDating, reanchorEpoch, withEpoch } from '../src/libs/broadcastDating.js';
import {
  continuesFrom,
  inheritedTimeline,
  LIVE_WINDOW_MAX_BYTES,
  ManifestManager,
} from '../src/libs/ManifestManager.js';
import { BroadcastAnchor } from '../src/types.js';

import { TEST_ANCHOR } from './helpers/fakes.js';

const DISCONTINUITY_TAG = '#EXT-X-DISCONTINUITY';
const GAP_TAG = '#EXT-X-GAP';
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

/** The `#EXT-X-TARGETDURATION` a manifest declares, which is the ceiling of its longest segment. */
function targetDurationOf(manifest: string): number {
  const line = manifest.split('\n').find((l) => l.startsWith('#EXT-X-TARGETDURATION:'));
  assert.ok(line, 'manifest must carry an EXT-X-TARGETDURATION');
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

/**
 * A broadcast that lost `missing` consecutive segments in the middle of itself.
 *
 * The engine's index carries on across the hole, which is what a real loss looks like from here:
 * nothing was told to the manager about the missing indexes, they simply never arrived.
 */
function withHole(before: number, missing: number, after: number, duration = 2): ManifestManager {
  const manager = new ManifestManager(TEST_ANCHOR);
  for (let i = 0; i < before; i++) {
    manager.addSegment(i, duration, ref(i));
  }
  for (let i = 0; i < after; i++) {
    const index = before + missing + i;
    manager.addSegment(index, duration, ref(index));
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
   * ⛔ The caller does not always ask, and on the shipped engine it never does. SRS delivers its
   * segments through a webhook that declares no break of its own (`engines/srs.ts`), so the reset is
   * the only evidence there is that the media after it is not a continuation. Without the marker a
   * player is told the join is seamless, which is what it stalls on, and the date stepping the length
   * of the outage becomes a promise of media the playlist does not name.
   */
  it('marks the restart as a discontinuity even when the caller says nothing about one', () => {
    const manager = livePast(3);

    manager.addSegment(0, 2, 'after-restart-0');

    const manifest = manager.buildLiveManifest();

    assert.ok(
      manifest.includes(`${DISCONTINUITY_TAG}\n${pdtLineAtMs(RESTARTED_AT_MS)}\n#EXTINF:2,\nafter-restart-0`),
      `the engine's reset went into the playlist as a seamless join, got:\n${manifest}`,
    );
  });

  it('marks only the segment the restart landed on, not the ones after it', () => {
    const manager = livePast(3);

    manager.addSegment(0, 2, 'after-restart-0');
    manager.addSegment(1, 2, 'after-restart-1');

    assert.equal(countOccurrences(manager.buildLiveManifest(), DISCONTINUITY_TAG), 1);
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

  /**
   * The floor is one segment's media past the newest segment this rung has dated, which on a stream
   * whose segments run long is further ahead than the configured grid would put it. Offering the
   * grid there would let a restart pull a stamp backwards, and hls.js reads that as a parsing error
   * rather than as a restart.
   */
  it('offers a floor that counts the media the broadcast really held', () => {
    const dating = pinnedDating(RESTARTED_AT_MS);
    const manager = new ManifestManager(TEST_ANCHOR, dating);
    feed(manager, 0, 3, 10);
    manager.buildLiveManifest();

    manager.addSegment(0, 2, 'after-restart-0', true);

    assert.deepEqual(dating.asked, [{ resumeAt: 3, notBeforeMs: TEST_ANCHOR.startedAtMs + 3 * 10_000 }]);
  });

  /**
   * The resuming segment takes the restart's own instant, and the media behind it carries on from
   * what each segment really held rather than from the grid the restart landed on.
   */
  it('resumes at the restart’s instant and carries on by the media that follows it', () => {
    const manager = livePast(3, pinnedDating(RESTARTED_AT_MS));

    manager.addSegment(0, 2.4, 'after-restart-0', true);
    manager.addSegment(1, 10, 'after-restart-1');
    manager.addSegment(2, 2, 'after-restart-2');

    assert.deepEqual(programDateTimesOf(manager.buildLiveManifest()).slice(-3), [
      RESTARTED_AT_MS,
      RESTARTED_AT_MS + 2_400,
      RESTARTED_AT_MS + 2_400 + 10_000,
    ]);
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
    // Consecutive, because that is what a recovery entry holds. A restart resumes the numbering at
    // one past the highest already published, so a re-anchoring never skips a sequence, and a list
    // that skipped one would be a lost segment rather than a restart.
    restored.restoreState(
      [
        { index: 0, duration: 2, ref: 'ref-0', sequence: 0 },
        { index: 1, duration: 2, ref: 'ref-1', sequence: 1 },
        { index: 2, duration: 2, ref: 'ref-2', sequence: 2 },
        { index: 0, duration: 2, ref: 'after-restart-0', sequence: 3, discontinuity: true },
      ],
      ['#EXTM3U', '#EXT-X-VERSION:3'],
    );

    restored.addSegment(1, 2, 'after-restart-1');

    assert.deepEqual(programDateTimesOf(restored.buildLiveManifest()), [
      TEST_ANCHOR.startedAtMs,
      TEST_ANCHOR.startedAtMs + STEP_MS,
      TEST_ANCHOR.startedAtMs + 2 * STEP_MS,
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

/**
 * A segment the broadcast lost, said out loud instead of left out.
 *
 * ⛔ HLS numbers the entries a playlist lists consecutively from `#EXT-X-MEDIA-SEQUENCE`, so leaving
 * the hole out renumbers every segment behind it. The rungs of one ladder derive their sequences from
 * one shared anchor precisely so segment N means the same instant on all four, and a rung that lost
 * one segment would be a segment out of step with its siblings until the window slid past the hole.
 */
describe('a hole in the sequences is published as gap entries', () => {
  it('names the missing sequence before the segment that follows it', () => {
    const manifest = withHole(2, 1, 1).buildLiveManifest();

    assert.ok(
      manifest.includes(`${GAP_TAG}\n${pdtLineAt(2)}\n#EXTINF:2,\ngap-2\n${pdtLineAt(3)}\n#EXTINF:2,\n${ref(3)}`),
      manifest,
    );
  });

  it('emits one entry per missing sequence, in order', () => {
    const manifest = withHole(2, 3, 1).buildLiveManifest();

    assert.equal(countOccurrences(manifest, GAP_TAG), 3);
    assert.deepEqual(segmentUris(manifest), [ref(0), ref(1), 'gap-2', 'gap-3', 'gap-4', ref(5)]);
  });

  it('leaves an unbroken run of sequences alone', () => {
    assert.equal(countOccurrences(withSegments(5, 2).buildLiveManifest(), GAP_TAG), 0);
    assert.equal(countOccurrences(withSegments(5, 2).buildVODManifest(), GAP_TAG), 0);
  });

  /**
   * The uploader's own e2e harness, the client's in-tab byte source and the bench all decide whether
   * a playlist line is fetchable by looking at its shape. A gap URI that matched would be handed to
   * a node as a chunk address.
   */
  it('gives a gap a URI no reader can mistake for a Swarm reference', () => {
    const uris = segmentUris(withHole(1, 2, 1).buildLiveManifest());
    const gaps = uris.filter((uri) => uri.startsWith('gap-'));

    assert.equal(gaps.length, 2);
    for (const uri of gaps) {
      assert.ok(!/^(?:[0-9a-f]{64}|[0-9a-f]{128})$/i.test(uri), `${uri} reads as a Swarm reference`);
    }
    assert.equal(new Set(gaps).size, gaps.length, 'two holes sharing a URI would be one entry to the client');
  });

  it('writes the same URI for the same hole every time the playlist is rebuilt', () => {
    const manager = withHole(2, 2, 1);

    assert.deepEqual(segmentUris(manager.buildLiveManifest()), segmentUris(manager.buildLiveManifest()));
  });

  /**
   * The whole point of the entries. A player numbers what it is given, so the segment after a hole
   * has to sit at its own sequence's position in the list.
   */
  it('leaves the segment behind a hole at the position its sequence names', () => {
    const uris = segmentUris(withHole(2, 3, 2).buildVODManifest());

    assert.equal(mediaSequenceOf(withHole(2, 3, 2).buildVODManifest()), 0);
    assert.equal(uris.indexOf(ref(5)), 5);
    assert.equal(uris.indexOf(ref(6)), 6);
  });

  /**
   * A hole is media nobody observed, so it is charged the length the deployment declared, which is
   * also the `#EXTINF` its own entry carries: the gap says two seconds and occupies two. Where it
   * starts is a different question, and that is the media that really ran in front of it.
   */
  it('charges a lost sequence the declared fragment length, after the media that really ran', () => {
    const manifest = withHole(1, 1, 1, 1.75).buildLiveManifest();
    const gapExtinf = manifest.split('\n')[manifest.split('\n').indexOf(GAP_TAG) + 2];

    assert.equal(gapExtinf, '#EXTINF:2,');
    assert.deepEqual(programDateTimesOf(manifest), [
      TEST_ANCHOR.startedAtMs,
      TEST_ANCHOR.startedAtMs + 1_750,
      TEST_ANCHOR.startedAtMs + 1_750 + 2_000,
    ]);
  });

  it('advances a three sequence hole by three declared lengths past the media in front of it', () => {
    const manifest = withHole(1, 3, 1, 2.4).buildLiveManifest();

    assert.deepEqual(programDateTimesOf(manifest), [
      TEST_ANCHOR.startedAtMs,
      TEST_ANCHOR.startedAtMs + 2_400,
      TEST_ANCHOR.startedAtMs + 2_400 + 2_000,
      TEST_ANCHOR.startedAtMs + 2_400 + 4_000,
      TEST_ANCHOR.startedAtMs + 2_400 + 6_000,
    ]);
  });

  it('says a hole in the recording as well as in the live window', () => {
    assert.equal(countOccurrences(withHole(2, 2, 2).buildVODManifest(), GAP_TAG), 2);
  });

  it('says a hole without claiming the media after it is a fresh encode', () => {
    const manager = withHole(2, 2, 2);

    assert.equal(countOccurrences(manager.buildLiveManifest(), DISCONTINUITY_TAG), 0);
    assert.equal(countOccurrences(manager.buildVODManifest(), DISCONTINUITY_TAG), 0);
  });

  /**
   * A restored session's sequences come off disk already carrying the hole, so nothing has to be
   * inferred: the same walk over the held segments finds it.
   */
  it('publishes a hole a restored session carries, on the numbering it was restored with', () => {
    const manager = new ManifestManager(TEST_ANCHOR);
    manager.restoreState(
      [
        { index: 11, duration: 2, ref: ref(11), sequence: 4 },
        { index: 14, duration: 2, ref: ref(14), sequence: 7 },
      ],
      ['#EXTM3U', '#EXT-X-VERSION:3'],
    );

    const manifest = manager.buildLiveManifest();

    assert.equal(mediaSequenceOf(manifest), 4);
    assert.deepEqual(segmentUris(manifest), [ref(11), 'gap-5', 'gap-6', ref(14)]);
  });
});

describe('the live window budgets its gap entries alongside its segments', () => {
  /**
   * The hole is small enough that the window can afford to name it, which is the case worth
   * budgeting: gap lines that were not counted would push the published manifest past one chunk and
   * turn one round trip per publish into three. See {@link LIVE_WINDOW_MAX_BYTES}.
   */
  it('still fits in one single-owner chunk when it is naming a hole', () => {
    const manifest = withHole(60, 5, 25).buildLiveManifest();

    assert.ok(countOccurrences(manifest, GAP_TAG) > 0, 'the window has to reach the hole for this to prove anything');
    assert.ok(
      Buffer.byteLength(manifest, 'utf-8') <= LIVE_WINDOW_MAX_BYTES,
      `a ${Buffer.byteLength(manifest, 'utf-8')} byte manifest costs three round trips per publish instead of one`,
    );
  });

  it('drops held segments from the front to pay for the gaps', () => {
    const withoutHole = segmentUris(withSegments(90, 2).buildLiveManifest()).length;
    const held = segmentUris(withHole(60, 5, 25).buildLiveManifest()).filter((uri) => !uri.startsWith('gap-'));

    assert.ok(held.length < withoutHole, `held ${held.length} segments against ${withoutHole} on a clean broadcast`);
    assert.equal(held[held.length - 1], ref(89));
  });

  /**
   * A hole wider than the whole budget cannot be named at all, so the window stops at it rather than
   * shrinking to the one segment the floor guarantees. Nothing is lost by that: the media before the
   * hole is behind the window, and a viewer joining now is handed the media that is actually there.
   */
  it('stops the window at a hole whose entries could never fit', () => {
    const manifest = withHole(60, 40, 15).buildLiveManifest();

    assert.equal(countOccurrences(manifest, GAP_TAG), 0);
    assert.equal(segmentUris(manifest)[0], ref(100));
    assert.equal(mediaSequenceOf(manifest), 100);
  });

  it('never opens a window on a gap entry, so the media sequence is always a real segment', () => {
    for (const missing of [1, 5, 40]) {
      const manifest = withHole(60, missing, 25).buildLiveManifest();

      assert.ok(!segmentUris(manifest)[0].startsWith('gap-'), `a ${missing} wide hole opened the window`);
      assert.ok(!segmentUris(manifest).at(-1)!.startsWith('gap-'), `a ${missing} wide hole ended the playlist`);
    }
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

  it('steps by the media a segment holds where that is outside the tolerance', () => {
    const manager = anchored();
    // Half the declared fragment, which is what a force-closed segment looks like. Nothing under a
    // ladder produces it, so the playlist says what the media did rather than a grid it left behind.
    feed(manager, 0, 3, 1);

    assert.deepEqual(programDateTimesOf(manager.buildLiveManifest()), [
      TEST_ANCHOR.startedAtMs,
      TEST_ANCHOR.startedAtMs + 1_000,
      TEST_ANCHOR.startedAtMs + 2_000,
    ]);
  });

  /**
   * The stage this exists for, measured live on 2026-09-15. A single rendition, where the
   * publisher's own keyframe interval decides the segment and `HLS_FRAGMENT` is a floor, cut
   * segments from 2.067 to 10.033 seconds against a configured 2 while every date stepped exactly
   * 2.000. The recording's wall clock fell further behind its own media with every segment and kept
   * those dates for ever.
   */
  it('dates a single rendition by what its segments really held', () => {
    const manager = anchored();
    const held = [2.067, 2.015, 2.4, 10.033, 2];
    held.forEach((duration, index) => manager.addSegment(index, duration, ref(index)));

    assert.deepEqual(programDateTimesOf(manager.buildLiveManifest()), [
      TEST_ANCHOR.startedAtMs,
      // ⛔ The smallest of the live readings, and the one a five percent band would have swallowed.
      // Nothing on a ladder produces a 67ms spread, so this is real media and it is charged as such.
      TEST_ANCHOR.startedAtMs + 2_067,
      // 2.015 is tick rounding on the configured grid, so it is read as the configured 2.
      TEST_ANCHOR.startedAtMs + 2_067 + 2_000,
      TEST_ANCHOR.startedAtMs + 2_067 + 2_000 + 2_400,
      TEST_ANCHOR.startedAtMs + 2_067 + 2_000 + 2_400 + 10_033,
    ]);
  });

  /**
   * ⛔ The half that must not move. Under a ladder the engine pins a keyframe every
   * `ABR_FPS x HLS_FRAGMENT` frames and SRS cuts exactly there, so a rung's segment holds the
   * configured length and only 90kHz tick rounding is left. Every one of those readings is inside
   * the tolerance, so the dating is the same arithmetic it always was and nothing a ladder publishes
   * today changes.
   */
  it('dates a ladder rung on the configured grid, tick rounding and all', () => {
    const manager = new ManifestManager({ startedAtMs: TEST_ANCHOR.startedAtMs, fragmentSeconds: 1 });
    feed(manager, 0, 4, 1.001);

    assert.deepEqual(
      programDateTimesOf(manager.buildLiveManifest()),
      [0, 1, 2, 3].map((sequence) => TEST_ANCHOR.startedAtMs + sequence * 1_000),
    );
  });

  /**
   * ⛔ A recovered session republishes the dates a viewer is already holding rather than deriving
   * them again. The instant each segment went out with is on the entry, and re-deriving it would
   * move every date of a broadcast whose segments ran longer than the configured length.
   */
  it('republishes a restored entry on the instant it was published with', () => {
    const manager = anchored();
    manager.addSegment(0, 2.4, ref(0));
    manager.addSegment(1, 10.033, ref(1));
    const published = programDateTimesOf(manager.buildLiveManifest());
    const state = manager.getState();

    const recovered = anchored();
    recovered.restoreState(state.segments, state.hlsHeaders);
    recovered.addSegment(2, 2, ref(2));

    assert.deepEqual(published, [TEST_ANCHOR.startedAtMs, TEST_ANCHOR.startedAtMs + 2_400]);
    assert.deepEqual(programDateTimesOf(recovered.buildLiveManifest()), [
      ...published,
      TEST_ANCHOR.startedAtMs + 2_400 + 10_033,
    ]);
  });

  /**
   * The three playlists a broadcast publishes are the live window, the closing playlist a viewer is
   * handed when it ends, and the recording. A segment's instant is decided once and stored on the
   * entry, so all three name the same one and a viewer carried across them sees no date move.
   */
  it('carries one instant per segment into the window, the closing playlist and the recording', () => {
    const manager = anchored();
    manager.addSegment(0, 2.4, ref(0));
    manager.addSegment(1, 10.033, ref(1));
    manager.addSegment(2, 2, ref(2));

    const live = programDateTimesOf(manager.buildLiveManifest());

    assert.deepEqual(live, [
      TEST_ANCHOR.startedAtMs,
      TEST_ANCHOR.startedAtMs + 2_400,
      TEST_ANCHOR.startedAtMs + 2_400 + 10_033,
    ]);
    assert.deepEqual(programDateTimesOf(manager.buildClosingLiveManifest()), live);
    assert.deepEqual(programDateTimesOf(manager.buildVODManifest()), live);
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

    // The spread one keyframe grid really produces across rungs: 90kHz tick rounding at a frame rate
    // that does not divide it, a fraction of a percent. Both readings are dated as the configured 2.
    feed(tall, 0, 5, 2);
    feed(short, 0, 5, 1.995);

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

  /**
   * ⛔ **The seam a deploy during a live broadcast leaves in one playlist, described here rather
   * than discovered later.** An entry written before the instant was persisted carries no
   * `presentedAtMs`, and `presentedAtMsOf` falls back to the anchor's own arithmetic for it. That is
   * not a guess: it is the very date that entry went out with, and republishing it is the point,
   * because a viewer is holding those dates and moving them would move media that has already been
   * handed out.
   *
   * What it means is that one published window can hold both rules at once. The restored entries are
   * `HLS_FRAGMENT` apart while each declares the media it really held, and the first arrival after
   * them steps by that media instead. On the 2026-09-15 stage, segments of 10.033 seconds against a
   * configured 2, the run of restored entries is 2000ms apart declaring 10.033s each, and the new one
   * lands 10033ms after the last of them.
   *
   * ⛔ The e2e manifest contract that shipped in the same landing reads every such pair as a failure:
   * `heldMs` is 10033 against a `gapMs` of 2000, a residual of 33ms against a 2ms slack, once per
   * pair, for the remaining life of that broadcast and in its recording. Nothing here is wrong and
   * no date a viewer holds is lost. Whether the contract should skip a pair whose earlier entry
   * carries no instant belongs to whoever owns `manifestContract.ts`.
   */
  it('keeps the grid a recovery entry written before the instant went out with, and steps the segment after it by the media that entry held', () => {
    // What the single-rendition stage of 2026-09-15 really cut against a configured 2.
    const MEASURED_SECONDS = 10.033;
    const MEASURED_MS = 10_033;
    const manager = anchored();

    manager.restoreState(
      [
        { index: 11, duration: MEASURED_SECONDS, ref: ref(11) },
        { index: 12, duration: MEASURED_SECONDS, ref: ref(12) },
      ],
      ['#EXTM3U', '#EXT-X-VERSION:3'],
    );
    manager.addSegment(13, MEASURED_SECONDS, ref(13));

    assert.deepEqual(programDateTimesOf(manager.buildLiveManifest()), [
      TEST_ANCHOR.startedAtMs,
      TEST_ANCHOR.startedAtMs + STEP_MS,
      TEST_ANCHOR.startedAtMs + STEP_MS + MEASURED_MS,
    ]);
  });
});

/**
 * ⛔ `segments` holds every segment the broadcast ever published, because the VOD manifest is built
 * from the same array and nothing prunes it. The target duration was read off that array with a
 * spread, which passes every element as its own argument, and measured on node v22.22.3 in this
 * repository that is fine at 109,770 elements and throws `RangeError: Maximum call stack size
 * exceeded` by 109,921. At the shipping half-second profile a broadcast crosses that in about 15.3
 * hours, and a stream that runs all day crosses it on its first day.
 *
 * What the throw cost: `restoreState` runs from the `StreamUploader` constructor, and the
 * orchestrator hands the failure to the error handler, so the stream is simply not recovered. Its
 * recording is never sealed, its catalog entry says `live` for ever, and the `unrecoverable_stream`
 * health reason never fires, because that counts quarantined entries and this one parses perfectly
 * well. Every later boot read it, threw again, and moved on.
 */
describe('ManifestManager restoring a broadcast longer than an argument list', () => {
  const ENTRIES = 150_000;
  const LONGEST_SECONDS = 3.4;

  it('takes back 150,000 segments and declares the longest of them as the target duration', () => {
    const manager = new ManifestManager(TEST_ANCHOR);
    const restored = Array.from({ length: ENTRIES }, (_, index) => ({
      index,
      // The longest segment sits at the very start, far outside the live window, because the target
      // duration is a property of the whole recording rather than of the window.
      duration: index === 0 ? LONGEST_SECONDS : 2,
      ref: ref(index),
      sequence: index,
    }));

    manager.restoreState(restored, ['#EXTM3U', '#EXT-X-VERSION:3']);

    assert.equal(targetDurationOf(manager.buildLiveManifest()), Math.ceil(LONGEST_SECONDS));
  });
});

/**
 * A session opening over a feed a previous session already wrote to, which is what a rung's derived
 * topic and a declared topic both now produce.
 *
 * ⛔ The seam is the whole subject. A viewer following the feed head is handed this session's first
 * live playlist as the next update of the one they are playing, so its `#EXT-X-MEDIA-SEQUENCE` has to
 * carry on from where the last one stopped — hls.js reads a sequence that moved backwards as a
 * parsing error, escalates it to fatal on a single-variant stream, and the client answers a fatal
 * parsing error by remounting the player at the beginning. One `#EXT-X-DISCONTINUITY` says the media
 * either side of the join is not continuous, which is also what makes the date jump at the seam legal.
 *
 * ⛔ What does NOT move is everything the offset is kept out of: the dating, which is derived from
 * this session's own sequence and its own anchor, and the numbering the engine's indexes are placed
 * against. A ladder's four rungs each resume a different feed head, so an offset folded into either
 * would put them on four different clocks for the same media.
 */
describe('a session that continues a feed a previous session wrote', () => {
  /** The recording the previous session left at the head, already deep into its published sequence. */
  const PREVIOUS_MEDIA_SEQUENCE = 900_000;
  const PREVIOUS_RECORDING = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MEDIA-SEQUENCE:${PREVIOUS_MEDIA_SEQUENCE}`,
    '',
    ...Array.from({ length: 30 }, (_, i) => [pdtLineAt(i), '#EXTINF:1.5,', ref(1000 + i)]).flat(),
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');

  /** Where {@link PREVIOUS_RECORDING} leaves the numbering. */
  const CONTINUE_AT = PREVIOUS_MEDIA_SEQUENCE + 30;

  function continuing(): ManifestManager {
    const manager = new ManifestManager(TEST_ANCHOR);
    const readOffTheHead = continuesFrom(PREVIOUS_RECORDING);
    assert.equal(readOffTheHead, CONTINUE_AT, 'the head read must yield the sequence past the last entry');
    manager.continueFrom(readOffTheHead!);
    return manager;
  }

  it('reads the sequence past the last entry off a live playlist too, gap entries counted', () => {
    const manager = withSegments(3, 1.5);
    manager.addSegment(5, 1.5, ref(5));

    const live = manager.buildLiveManifest();
    // Three segments, a hole at sequences 3 and 4, then the fourth: six entries from sequence 0.
    assert.equal(continuesFrom(live), 6);
  });

  it('answers null for a payload that is not a playlist, so nothing is offset off a bad read', () => {
    assert.equal(continuesFrom('not a playlist at all'), null);
  });

  it('numbers its first live playlist from where the previous session stopped', () => {
    const manager = continuing();
    feed(manager, 0, 3);

    assert.equal(mediaSequenceOf(manager.buildLiveManifest()), CONTINUE_AT);
  });

  it('writes exactly one discontinuity, before its own first segment', () => {
    const manager = continuing();
    feed(manager, 0, 3);
    const live = manager.buildLiveManifest();

    assert.equal(countOccurrences(live, DISCONTINUITY_TAG), 1);
    const lines = live.split('\n');
    assert.equal(
      lines[lines.indexOf(DISCONTINUITY_TAG) + 3],
      'ref-0',
      'the break belongs to this session’s first segment, which follows its own stamp and length',
    );
  });

  /**
   * ⛔ The one thing the offset must not touch. The dates are this session's own wall clock, so the
   * media after the seam carries the time it really happened rather than a time shifted by however
   * long the previous session ran. The discontinuity above is what makes the jump at the seam legal.
   */
  it('keeps the large published sequence offset while dating from its own measured media', () => {
    const manager = continuing();
    const held = [2.4, 10.033, 2];
    held.forEach((duration, index) => manager.addSegment(index, duration, ref(index)));
    const live = manager.buildLiveManifest();

    assert.equal(mediaSequenceOf(live), CONTINUE_AT);
    assert.equal(countOccurrences(live, DISCONTINUITY_TAG), 1);
    assert.deepEqual(programDateTimesOf(live), [
      TEST_ANCHOR.startedAtMs,
      TEST_ANCHOR.startedAtMs + 2_400,
      TEST_ANCHOR.startedAtMs + 2_400 + 10_033,
    ]);
  });

  /**
   * ⛔ A session handed the numbering and nothing else records only its own media. That is the
   * shape a feed whose head names no media leaves, and it is what keeps such a broadcast's output
   * exactly what it has always been. A head that DOES name media is inherited as well — see the
   * glued-recording suite below.
   */
  it('records only its own segments when nothing was inherited, numbered from the same place', () => {
    const manager = continuing();
    feed(manager, 0, 3);
    manager.buildLiveManifest();

    const vod = manager.buildVODManifest();
    assert.equal(mediaSequenceOf(vod), CONTINUE_AT);
    assert.deepEqual(segmentUris(vod), ['ref-0', 'ref-1', 'ref-2']);
  });

  /**
   * The engine's own indexes are what the numbering is placed against, and the offset is applied
   * after that. A restart still resumes above the highest sequence already published rather than
   * above the number it was published as.
   */
  it('still re-anchors an engine restart forwards, and publishes the result offset', () => {
    const manager = continuing();
    feed(manager, 100, 3);
    manager.buildLiveManifest();

    manager.addSegment(0, 1.5, ref(0));
    const live = manager.buildLiveManifest();

    assert.equal(mediaSequenceOf(live), CONTINUE_AT, 'the window still opens at the oldest held segment');
    assert.equal(
      continuesFrom(live),
      CONTINUE_AT + 4,
      'the restarted segment continues above the three already published rather than reusing a number',
    );
  });

  it('carries the offset back through a restore, so a crash does not renumber the history', () => {
    const manager = continuing();
    feed(manager, 0, 3);
    manager.buildLiveManifest();

    const recovered = new ManifestManager(TEST_ANCHOR);
    recovered.restoreState(manager.getState().segments, manager.getState().hlsHeaders);
    recovered.continueFrom(manager.publishedSequenceOffset());

    assert.equal(mediaSequenceOf(recovered.buildLiveManifest()), CONTINUE_AT);
  });
});

/**
 * A broadcaster who stops and starts again writes several recordings onto one rung feed, and the
 * catalogue points at the head. So the head recording opens with the playlist that was there when
 * this session started, one `#EXT-X-DISCONTINUITY`, then this session's own media.
 *
 * ⛔ Every prefix below is playlist TEXT, parsed the way the uploader parses the head it reads off
 * the feed. A suite that handed the manager a hand-built object would prove the gluing against a
 * prefix nothing publishes. The two fixtures at the top are the shapes `bee` really answered with
 * on the 360p rung of stream aa1c366a on 2026-09-21: a closing live playlist and a recording.
 */
describe('gluing the recording onto what was already on the feed', () => {
  const DISCONTINUITY_SEQUENCE_TAG = '#EXT-X-DISCONTINUITY-SEQUENCE';
  const ENDLIST_TAG = '#EXT-X-ENDLIST';
  const PLAYLIST_TYPE_VOD_TAG = '#EXT-X-PLAYLIST-TYPE:VOD';

  /** Session one as the feed really held it: 14 entries from 0, a short last one, no break. */
  const SESSION_ONE = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '',
    ...Array.from({ length: 13 }, (_unused, i) => [
      `${PROGRAM_DATE_TIME_TAG}:2026-09-21T10:05:${(21 + i * 2).toString().padStart(2, '0')}.849Z`,
      '#EXTINF:2,',
      ref(1000 + i),
    ]).flat(),
    `${PROGRAM_DATE_TIME_TAG}:2026-09-21T10:05:47.849Z`,
    '#EXTINF:1.1,',
    ref(1013),
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');

  /** What session one really holds: thirteen 2s entries and one of 1.1s. */
  const SESSION_ONE_SECONDS = 13 * 2 + 1.1;
  const SESSION_ONE_ENTRIES = 14;

  function glued(prefixText: string): ManifestManager {
    const manager = new ManifestManager(TEST_ANCHOR);
    const continueAt = continuesFrom(prefixText);
    const prefix = inheritedTimeline(prefixText);
    assert.ok(continueAt !== null && prefix !== null, 'the fixture head must be readable');
    manager.continueFrom(continueAt!);
    manager.inherit(prefix!);
    return manager;
  }

  describe('reading the head', () => {
    it('carries every timeline line of a recording verbatim, and nothing of its header', () => {
      const parsed = inheritedTimeline(SESSION_ONE)!;

      assert.equal(parsed.mediaSequence, 0);
      assert.equal(parsed.targetDuration, 2);
      assert.equal(parsed.durationSeconds, SESSION_ONE_SECONDS);
      assert.equal(parsed.lines.length, SESSION_ONE_ENTRIES * 3, 'three lines per entry, none of them a header');
      assert.equal(parsed.lines[0], `${PROGRAM_DATE_TIME_TAG}:2026-09-21T10:05:21.849Z`);
      assert.equal(parsed.lines.at(-1), ref(1013));
      assert.ok(!parsed.lines.includes(ENDLIST_TAG), 'the recording writes its own ending');
      assert.ok(!parsed.lines.some((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE')));
    });

    /**
     * ⛔ A hole and a break are different statements and both are the previous session's to make, so
     * both come back exactly as they were written. Nothing here re-derives a stamp or renumbers a
     * gap URI: that media belongs to a session this one never saw.
     */
    it('carries gaps, breaks and stamps through untouched', () => {
      const withHoles = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:3',
        '#EXT-X-MEDIA-SEQUENCE:14',
        '',
        DISCONTINUITY_TAG,
        `${PROGRAM_DATE_TIME_TAG}:2026-09-21T10:06:32.475Z`,
        '#EXTINF:2,',
        ref(2000),
        GAP_TAG,
        `${PROGRAM_DATE_TIME_TAG}:2026-09-21T10:06:34.475Z`,
        '#EXTINF:2,',
        'gap-15',
        `${PROGRAM_DATE_TIME_TAG}:2026-09-21T10:06:36.475Z`,
        '#EXTINF:3,',
        ref(2002),
        '#EXT-X-ENDLIST',
        '',
      ].join('\n');

      const parsed = inheritedTimeline(withHoles)!;

      assert.equal(parsed.mediaSequence, 14);
      assert.equal(parsed.targetDuration, 3);
      assert.equal(parsed.durationSeconds, 7);
      assert.equal(parsed.lines[0], DISCONTINUITY_TAG, 'the break opens the timeline and is not a header');
      assert.ok(parsed.lines.includes(GAP_TAG));
      assert.ok(parsed.lines.includes('gap-15'), 'the hole keeps the name the previous session gave it');
    });

    /**
     * ⚠️ A predecessor that was killed never published a recording, so its head is a live window and
     * only that window is here to read. Documented rather than worked around: the killed session's
     * own recovery entry is what recovers the rest of its recording.
     */
    it('takes a live window with no ENDLIST for exactly what it is', () => {
      const manager = withSegments(4, 2);
      const live = manager.buildLiveManifest();

      const parsed = inheritedTimeline(live)!;
      assert.equal(parsed.lines.filter((line) => line.startsWith('#EXTINF:')).length, 4);
      assert.equal(parsed.durationSeconds, 8);
    });

    it('answers null for a playlist naming no media, and for a payload that is not one', () => {
      const empty = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0', ''].join(
        '\n',
      );

      assert.equal(inheritedTimeline(empty), null);
      assert.equal(inheritedTimeline('not a playlist at all'), null);
      assert.equal(inheritedTimeline(''), null);
    });
  });

  describe('the glued recording', () => {
    it('opens with the previous recording, seams it once, then names its own media', () => {
      const manager = glued(SESSION_ONE);
      feed(manager, 0, 3, 2);
      manager.buildLiveManifest();

      const vod = manager.buildVODManifest();
      const uris = segmentUris(vod);

      assert.equal(uris[0], ref(1000), 'the recording starts at the first session’s first segment');
      assert.deepEqual(uris.slice(-3), ['ref-0', 'ref-1', 'ref-2']);
      assert.equal(uris.length, SESSION_ONE_ENTRIES + 3);
      assert.equal(countOccurrences(vod, DISCONTINUITY_TAG), 1, 'one seam, never two');
      assert.ok(vod.includes(PLAYLIST_TYPE_VOD_TAG));
      assert.ok(vod.trimEnd().endsWith(ENDLIST_TAG));
    });

    /**
     * ⛔⛔ The defect a review caught on 2026-09-21. This session's first segment can arrive carrying
     * a break of its own — the origin declared one, or the engine's counter restarted on it — and that
     * break and the seam are the same join. Two tags there would tell a player there are two encodes
     * between the sessions and would move every later discontinuity sequence out by one.
     */
    it('writes one seam even when its own first segment declares a break of its own', () => {
      const manager = glued(SESSION_ONE);
      manager.addSegment(0, 2, 'ref-0', true);
      manager.addSegment(1, 2, 'ref-1');

      const vod = manager.buildVODManifest();
      assert.equal(countOccurrences(vod, DISCONTINUITY_TAG), 1, 'the origin′s break and the seam are one join');

      const lines = vod.split('\n');
      const seam = lines.indexOf(DISCONTINUITY_TAG);
      assert.equal(lines[seam + 3], 'ref-0', 'and it still sits immediately in front of this session′s media');
    });

    /**
     * ⛔ The suppression is positional rather than derived from the seam, which a head naming media
     * under no `#EXT-X-MEDIA-SEQUENCE` would leave unarmed: `continuesFrom` answers null there, so
     * nothing offsets the numbering and `isSeam` is false, while the prefix path writes the seam
     * regardless. Derived, that combination put a second tag back.
     */
    it('writes one seam over a head that declared no media sequence at all', () => {
      const headerless = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:2',
        '',
        `${PROGRAM_DATE_TIME_TAG}:2026-09-21T10:05:21.849Z`,
        '#EXTINF:2,',
        ref(700),
        '#EXT-X-ENDLIST',
        '',
      ].join('\n');
      assert.equal(continuesFrom(headerless), null, 'nothing offsets the numbering off such a head');

      const manager = new ManifestManager(TEST_ANCHOR);
      manager.inherit(inheritedTimeline(headerless)!);
      manager.addSegment(0, 2, 'ref-0', true);
      manager.addSegment(1, 2, 'ref-1');

      assert.equal(countOccurrences(manager.buildVODManifest(), DISCONTINUITY_TAG), 1);
    });

    /** The live playlist says the same join once too, from the other builder. */
    it('writes one seam in the live playlist when its own first segment declares a break', () => {
      const manager = glued(SESSION_ONE);
      manager.addSegment(0, 2, 'ref-0', true);
      manager.addSegment(1, 2, 'ref-1');

      assert.equal(countOccurrences(manager.buildLiveManifest(), DISCONTINUITY_TAG), 1);
    });

    /**
     * ⛔ The seam tag sits between the two sessions' media, not on this session's first entry twice.
     * The `isSeam` tag that a live playlist writes there is deliberately left to the prefix path.
     */
    it('puts the one seam immediately before this session’s first segment', () => {
      const manager = glued(SESSION_ONE);
      feed(manager, 0, 2, 2);

      const lines = manager.buildVODManifest().split('\n');
      const seam = lines.indexOf(DISCONTINUITY_TAG);

      assert.equal(lines[seam - 1], ref(1013), 'the previous recording’s last segment is in front of it');
      assert.equal(lines[seam + 3], 'ref-0', 'this session’s first segment follows its stamp and length');
    });

    it('declares the prefix’s media sequence, which is where the whole broadcast starts', () => {
      const manager = glued(SESSION_ONE);
      feed(manager, 0, 3, 2);

      assert.equal(mediaSequenceOf(manager.buildVODManifest()), 0);
      assert.equal(
        mediaSequenceOf(manager.buildLiveManifest()),
        SESSION_ONE_ENTRIES,
        'the live playlist still carries on from the head, which is what a following viewer needs',
      );
    });

    it('declares the longer target duration of the two sessions', () => {
      const manager = glued(SESSION_ONE);
      feed(manager, 0, 2, 5.5);

      assert.equal(targetDurationOf(manager.buildVODManifest()), 6);
      assert.equal(
        targetDurationOf(manager.buildLiveManifest()),
        6,
        'the live window holds only this session, so it declares only this session’s longest',
      );
    });

    it('declares the prefix’s own target duration when this session’s segments are shorter', () => {
      const manager = glued(SESSION_ONE);
      feed(manager, 0, 2, 0.5);

      assert.equal(targetDurationOf(manager.buildVODManifest()), 2);
    });

    /**
     * What the catalogue entry, the rendition announce and the admin's `vod` report all carry. A
     * length stopping at the last restart would tell a viewer a four-session broadcast is as long as
     * its last session.
     */
    it('reports the whole broadcast’s duration, both sessions', () => {
      const manager = glued(SESSION_ONE);
      feed(manager, 0, 3, 2);

      assert.equal(manager.getTotalDuration(), SESSION_ONE_SECONDS + 6);
    });

    it('names nothing at all before its own first segment lands', () => {
      assert.equal(glued(SESSION_ONE).buildVODManifest(), '', 'a session that held nothing publishes no recording');
    });
  });

  /**
   * ⛔ The whole point: session three inherits session two's glued recording, which already carries
   * session one, so the head recording plays the broadcast from its beginning however many times it
   * was restarted.
   */
  describe('chaining across three sessions', () => {
    function secondSessionRecording(): string {
      const manager = glued(SESSION_ONE);
      feed(manager, 0, 3, 2);
      manager.buildLiveManifest();
      return manager.buildVODManifest();
    }

    it('carries the first session through the second’s recording into the third’s', () => {
      const third = glued(secondSessionRecording());
      feed(third, 0, 2, 2);

      const vod = third.buildVODManifest();
      const uris = segmentUris(vod);

      assert.equal(uris[0], ref(1000), 'the first session is still at the front');
      assert.deepEqual(uris.slice(-2), ['ref-0', 'ref-1']);
      assert.equal(uris.length, SESSION_ONE_ENTRIES + 3 + 2);
      assert.equal(countOccurrences(vod, DISCONTINUITY_TAG), 2, 'one seam per join and no more');
      assert.equal(mediaSequenceOf(vod), 0);
    });

    it('sums all three sessions into the duration it reports', () => {
      const third = glued(secondSessionRecording());
      feed(third, 0, 2, 2);

      assert.equal(third.getTotalDuration(), SESSION_ONE_SECONDS + 6 + 4);
    });
  });

  /**
   * RFC 8216 §4.3.3.3: a window that has slid past a break has to say how many are behind it, or a
   * client joining now numbers the breaks it can see from a different place than one that has been
   * watching. hls.js 1.6.15 reads the tag into `level.startCC`.
   */
  describe('the discontinuity sequence on live playlists', () => {
    it('declares nothing at all on a broadcast that opened on an empty feed and never broke', () => {
      assert.ok(!withSegments(4, 2).buildLiveManifest().includes(DISCONTINUITY_SEQUENCE_TAG));
      assert.ok(!withSegments(4, 2).buildClosingLiveManifest().includes(DISCONTINUITY_SEQUENCE_TAG));
    });

    /**
     * ⛔⛔ **A break of its own counts even on an empty feed, and this used to answer zero for ever.**
     * The tag was skipped outright for a session with no offset and nothing inherited, on the
     * reasoning that such a session numbers its breaks from its own first entry — true only until one
     * of them slides out of the window. A reconnect seam is an ordinary event now rather than an
     * engine fault, so a first-session broadcast whose encoder dropped once and came back loses that
     * seam from its window within a minute and went on declaring nothing. hls.js reads this tag into
     * `level.startCC` and aligns discontinuity domains across levels from it when it switches rung, so
     * a ladder under-declaring it lands the switch in the wrong domain.
     */
    it('counts its own break once the window has slid past it, on an empty feed too', () => {
      const manager = withSegments(2, 2);
      // The encoder came back: this segment opens a resumed run and carries the seam.
      manager.resumeAfterReconnect();
      manager.buildLiveManifest();
      manager.addSegment(2, 2, ref(2));

      assert.ok(
        !manager.buildLiveManifest().includes(DISCONTINUITY_SEQUENCE_TAG),
        'the break is inside the window, so nothing is behind it yet and the tag stays absent',
      );

      // Enough segments that the byte budget slides the window past the seam.
      for (let index = 3; index < 400; index++) {
        manager.addSegment(index, 2, ref(index));
      }

      const live = manager.buildLiveManifest();
      assert.ok(
        live.includes(`${DISCONTINUITY_SEQUENCE_TAG}:1`),
        `the seam left the window uncounted; header was ${live.split('\n').slice(0, 6).join(' / ')}`,
      );
      assert.ok(
        manager.buildClosingLiveManifest().includes(`${DISCONTINUITY_SEQUENCE_TAG}:1`),
        'and the playlist a viewer is handed when the broadcast ends says the same',
      );
      assert.ok(
        !manager.buildVODManifest().includes(DISCONTINUITY_SEQUENCE_TAG),
        'while the recording names the broadcast from its start, so nothing precedes it',
      );
    });

    /** The seam is ON the first entry of this window, so nothing precedes it and the count is the prefix's. */
    it('counts only the inherited breaks while this session’s own seam is still in the window', () => {
      const manager = glued(SESSION_ONE);
      feed(manager, 0, 3, 2);

      assert.ok(
        !manager.buildLiveManifest().includes(DISCONTINUITY_SEQUENCE_TAG),
        'session one declared no break, so nothing is behind this window yet',
      );
    });

    it('counts the seams of every session behind the window once its own has slid past', () => {
      const chained = glued(SESSION_ONE);
      feed(chained, 0, 3, 2);
      chained.buildLiveManifest();
      const third = glued(chained.buildVODManifest());

      // Enough segments that the byte budget slides the window past this session's own first one.
      feed(third, 0, 400, 2);
      const live = third.buildLiveManifest();

      assert.ok(live.includes(`${DISCONTINUITY_SEQUENCE_TAG}:2`), live.split('\n').slice(0, 6).join('\n'));
    });

    it('declares it in the header, before the first entry, where hls.js requires it', () => {
      const chained = glued(SESSION_ONE);
      feed(chained, 0, 3, 2);
      chained.buildLiveManifest();
      const third = glued(chained.buildVODManifest());
      feed(third, 0, 400, 2);

      const lines = third.buildClosingLiveManifest().split('\n');
      const tag = lines.findIndex((line) => line.startsWith(DISCONTINUITY_SEQUENCE_TAG));
      const firstEntry = lines.findIndex((line) => line.startsWith('#EXTINF:'));

      assert.ok(tag > 0 && tag < firstEntry, 'the tag is a header, not part of the timeline');
      assert.equal(countOccurrences(third.buildClosingLiveManifest(), DISCONTINUITY_SEQUENCE_TAG), 1);
    });

    /** The recording names its timeline from its own first entry, so nothing precedes it. */
    it('is absent from the recording, whose count would be zero', () => {
      const manager = glued(SESSION_ONE);
      feed(manager, 0, 3, 2);

      assert.ok(!manager.buildVODManifest().includes(DISCONTINUITY_SEQUENCE_TAG));
    });

    /**
     * ⛔⛔ The counter has to dedupe exactly where {@link segmentLines} does. A first segment carrying
     * a break of its own publishes ONE tag at the seam, so once it slides out of the window exactly
     * one break is behind it — counting the seam and the segment's own flag separately said two, and
     * every fragment a client had already numbered from the first would have been one out.
     */
    it('counts its own first segment once when that segment declared a break of its own', () => {
      const manager = glued(SESSION_ONE);
      assert.equal(
        inheritedTimeline(SESSION_ONE)!.lines.filter((line) => line === DISCONTINUITY_TAG).length,
        0,
        'the prefix declares no break, so the only one behind the window can be this session′s seam',
      );
      manager.addSegment(0, 2, 'ref-0', true);
      // Enough that the byte budget slides the window past this session's own first segment.
      for (let i = 1; i < 400; i++) {
        manager.addSegment(i, 2, ref(i));
      }

      const live = manager.buildLiveManifest();
      assert.ok(live.includes(`${DISCONTINUITY_SEQUENCE_TAG}:1`), live.split('\n').slice(0, 6).join('\n'));
    });

    /**
     * ⛔⛔ A head left by a session that was killed is a live window, so the breaks earlier in that
     * broadcast are behind it and are named only by its own header. Dropping it published a number
     * LOWER than the head a viewer had just been handed, which is the one direction a discontinuity
     * sequence must never move.
     */
    it('carries the head′s own declared count, so it never publishes a lower one', () => {
      const killedWindow = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:2',
        '#EXT-X-MEDIA-SEQUENCE:40',
        `${DISCONTINUITY_SEQUENCE_TAG}:3`,
        '',
        `${PROGRAM_DATE_TIME_TAG}:2026-09-21T10:05:21.849Z`,
        '#EXTINF:2,',
        ref(900),
        '',
      ].join('\n');
      assert.equal(inheritedTimeline(killedWindow)!.discontinuitySequence, 3, 'the header is read, not dropped');

      const manager = glued(killedWindow);
      feed(manager, 0, 400, 2);

      const live = manager.buildLiveManifest();
      assert.ok(live.includes(`${DISCONTINUITY_SEQUENCE_TAG}:4`), 'the head′s three, plus this session′s own seam');
    });

    /**
     * The recording inherits that header too. A prefix taken from a killed session's window begins
     * mid-broadcast, so the breaks in front of it are real and the recording has to say so.
     */
    it('is declared on a recording glued onto a killed session′s window', () => {
      const killedWindow = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:2',
        '#EXT-X-MEDIA-SEQUENCE:40',
        `${DISCONTINUITY_SEQUENCE_TAG}:3`,
        '',
        `${PROGRAM_DATE_TIME_TAG}:2026-09-21T10:05:21.849Z`,
        '#EXTINF:2,',
        ref(900),
        '',
      ].join('\n');
      const manager = glued(killedWindow);
      feed(manager, 0, 2, 2);

      const vod = manager.buildVODManifest();
      assert.ok(vod.includes(`${DISCONTINUITY_SEQUENCE_TAG}:3`));
      const lines = vod.split('\n');
      assert.ok(
        lines.findIndex((line) => line.startsWith(DISCONTINUITY_SEQUENCE_TAG)) <
          lines.findIndex((line) => line.startsWith('#EXTINF:')),
        'and in the header, where hls.js requires it',
      );
    });

    /** A recording names the broadcast from its start, so it hands nothing on. */
    it('is absent again once the killed session′s window has itself been glued into a recording', () => {
      const manager = glued(SESSION_ONE);
      feed(manager, 0, 2, 2);
      manager.buildLiveManifest();

      assert.equal(inheritedTimeline(manager.buildVODManifest())!.discontinuitySequence, 0);
    });
  });

  /**
   * ⛔ The prefix is persisted rather than re-read, for the same reason the offset is: by the time a
   * recovered session runs, the feed head is its own live playlist.
   */
  describe('surviving a crash', () => {
    it('still glues the recording after the session was rebuilt off disk', () => {
      const manager = glued(SESSION_ONE);
      feed(manager, 0, 3, 2);
      manager.buildLiveManifest();

      const recovered = new ManifestManager(TEST_ANCHOR);
      const state = manager.getState();
      recovered.restoreState(state.segments, state.hlsHeaders, manager.inheritedPrefix()!);
      recovered.continueFrom(manager.publishedSequenceOffset());

      assert.equal(recovered.buildVODManifest(), manager.buildVODManifest());
      assert.equal(recovered.getTotalDuration(), manager.getTotalDuration());
    });

    it('hands the recovery entry back exactly what it was given', () => {
      const parsed = inheritedTimeline(SESSION_ONE)!;
      const manager = new ManifestManager(TEST_ANCHOR);
      manager.inherit(parsed);

      assert.deepEqual(manager.inheritedPrefix(), parsed);
      assert.equal(new ManifestManager(TEST_ANCHOR).inheritedPrefix(), null);
    });
  });

  /**
   * ⛔⛔ A standalone single-rendition stream mints a fresh topic per broadcast and a standalone
   * ladder a fresh group, so the head is empty and nothing is inherited. Those deployments must
   * publish exactly what they published before this existed.
   */
  it('leaves a broadcast over an empty feed byte-identical to what it always published', () => {
    const glue = new ManifestManager(TEST_ANCHOR);
    const plain = new ManifestManager(TEST_ANCHOR);
    assert.equal(inheritedTimeline(''), null, 'an empty head yields nothing to inherit');

    for (const manager of [glue, plain]) {
      feed(manager, 0, 6, 2);
      manager.buildLiveManifest();
    }

    assert.equal(glue.buildLiveManifest(), plain.buildLiveManifest());
    assert.equal(glue.buildClosingLiveManifest(), plain.buildClosingLiveManifest());
    assert.equal(glue.buildVODManifest(), plain.buildVODManifest());
    assert.equal(glue.getTotalDuration(), plain.getTotalDuration());
  });
});
