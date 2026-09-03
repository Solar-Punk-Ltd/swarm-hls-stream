import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { LIVE_WINDOW_MAX_BYTES, ManifestManager } from '../src/libs/ManifestManager.js';

import { TEST_ANCHOR } from './helpers/fakes.js';

const DISCONTINUITY_TAG = '#EXT-X-DISCONTINUITY';
const PROGRAM_DATE_TIME_TAG = '#EXT-X-PROGRAM-DATE-TIME';

/** The wall clock {@link TEST_ANCHOR} puts on the segment at this playlist sequence. */
function pdtLineAt(sequence: number): string {
  return `${PROGRAM_DATE_TIME_TAG}:${new Date(
    TEST_ANCHOR.startedAtMs + sequence * TEST_ANCHOR.fragmentSeconds * 1000,
  ).toISOString()}`;
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
  it('reports the engine sequence number of the playlist’s first segment', () => {
    const manager = new ManifestManager(TEST_ANCHOR);
    feed(manager, 0, 3);

    assert.equal(mediaSequenceOf(manager.buildLiveManifest()), 0);
  });

  it('starts the VOD manifest at the engine index of its first segment, not zero', () => {
    // A rung whose opening segment was lost, or whose engine restarted mid-broadcast, retains a first
    // segment that is not index 0. Renumbering the VOD playlist to zero misaligns the ladder's levels
    // for a VOD viewer exactly as it would live, since the master playlist names all four rungs.
    const manager = new ManifestManager(TEST_ANCHOR);
    feed(manager, 4, 3);

    assert.equal(mediaSequenceOf(manager.buildVODManifest()), 4);
  });

  // The sliding-window case is covered by 'names the count it dropped as the media sequence' in the
  // live-window suite above. ABR's version asserted a media sequence of 4 after 14 segments, which
  // assumes a window bounded at ten segments. This branch bounds the window by BYTES, at one bee
  // chunk, so fourteen short refs all fit and it never slides. The surviving test derives its
  // expectation from what the window actually kept rather than hard-coding a length.

  it('does not renumber a rung whose uploader joined the stream late', () => {
    // The defect this exists to prevent. Every rung of a ladder is transcoded from one source with
    // keyframes forced to the same media timestamps, so segment N means the same interval on all of
    // them — and with no EXT-X-PROGRAM-DATE-TIME in these playlists, the sequence number is the
    // only thing telling hls.js that two levels share a timeline.
    //
    // A count of segments this uploader had seen would make both of these start at 0, claiming the
    // 1080p rung's first segment covers the same instant as the 360p rung's when it is two segments
    // (3 seconds) later. Every switch would then land that far off.
    const early = new ManifestManager(TEST_ANCHOR);
    const late = new ManifestManager(TEST_ANCHOR);

    feed(early, 0, 5);
    feed(late, 2, 3);

    assert.equal(mediaSequenceOf(early.buildLiveManifest()), 0);
    assert.equal(mediaSequenceOf(late.buildLiveManifest()), 2);
  });

  it('uses the first segment it holds even when segments arrive out of order', () => {
    const manager = new ManifestManager(TEST_ANCHOR);
    manager.addSegment(7, 1.5, 'ref-7');
    manager.addSegment(5, 1.5, 'ref-5');
    manager.addSegment(6, 1.5, 'ref-6');

    const manifest = manager.buildLiveManifest();

    assert.equal(mediaSequenceOf(manifest), 5);
    assert.deepEqual(segmentUris(manifest), ['ref-5', 'ref-6', 'ref-7']);
  });

  it('survives a restore, which is where the sequence numbers come back from disk', () => {
    const manager = new ManifestManager(TEST_ANCHOR);
    manager.restoreState(
      [
        { index: 11, duration: 1.5, ref: 'ref-11' },
        { index: 12, duration: 1.5, ref: 'ref-12' },
      ],
      ['#EXTM3U', '#EXT-X-VERSION:3'],
    );

    assert.equal(mediaSequenceOf(manager.buildLiveManifest()), 11);
  });

  it('returns nothing at all before the first segment, rather than a headers-only playlist', () => {
    const manager = new ManifestManager(TEST_ANCHOR);

    assert.equal(manager.buildLiveManifest(), '');
    assert.equal(manager.buildVODManifest(), '');
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

    assert.deepEqual(programDateTimesOf(manager.buildLiveManifest()), [ANCHOR.startedAtMs]);
  });

  it('steps by the declared fragment length, not by the segment’s own EXTINF', () => {
    const manager = anchored();
    // Half the declared fragment, which is what a force-closed segment looks like. The stamp must
    // not follow it: a rung whose encoder cut short would otherwise drift away from its siblings.
    feed(manager, 0, 3, 1);

    assert.deepEqual(programDateTimesOf(manager.buildLiveManifest()), [
      ANCHOR.startedAtMs,
      ANCHOR.startedAtMs + STEP_MS,
      ANCHOR.startedAtMs + 2 * STEP_MS,
    ]);
  });

  it('writes UTC to the millisecond, which is what a sub-second fragment needs', () => {
    const manager = new ManifestManager({ startedAtMs: ANCHOR.startedAtMs, fragmentSeconds: 0.5 });
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
    assert.deepEqual(programDateTimesOf(vod)[3], ANCHOR.startedAtMs + 3 * STEP_MS);
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
    assert.equal(stamps[stamps.length - 1], ANCHOR.startedAtMs + 499 * STEP_MS);
  });

  it('holds the anchor across a restore, so a recovered broadcast is not re-dated', () => {
    const manager = anchored();
    feed(manager, 0, 3, 2);
    const state = manager.getState();

    const recovered = anchored();
    recovered.restoreState(state.segments, state.hlsHeaders);
    recovered.addSegment(3, 2, ref(3));

    assert.deepEqual(programDateTimesOf(recovered.buildLiveManifest()), [
      ANCHOR.startedAtMs,
      ANCHOR.startedAtMs + STEP_MS,
      ANCHOR.startedAtMs + 2 * STEP_MS,
      ANCHOR.startedAtMs + 3 * STEP_MS,
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
      ANCHOR.startedAtMs,
      ANCHOR.startedAtMs + STEP_MS,
    ]);
  });
});
