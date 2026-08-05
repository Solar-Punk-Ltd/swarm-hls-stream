import {
  HLS_MEDIA_SEQUENCE,
  HLS_PLAYLIST_TYPE_VOD,
  HLS_TARGET_DURATION,
  parseManifest,
  segmentDuration,
} from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ManifestManager } from '../src/libs/ManifestManager.js';

/**
 * The two halves of the manifest contract, exercised against each other.
 *
 * The build side is the uploader's own `ManifestManager`, the parse side is the function the client
 * player calls on every feed slot it reads. Before ARCH-1 these sat in different packages with their
 * own copies of the tag literals and nothing compared them, so a tag could be renamed on one side
 * and the only report would have been a viewer seeing no segments.
 */

const BEE_URL = 'http://bee.test/bytes';

interface AddedSegment {
  index: number;
  duration: number;
  ref: string;
  discontinuity?: boolean;
}

function managerWith(segments: AddedSegment[]): ManifestManager {
  const manager = new ManifestManager(BEE_URL);
  for (const segment of segments) {
    manager.addSegment(segment.index, segment.duration, segment.ref, segment.discontinuity ?? false);
  }
  return manager;
}

/**
 * Far more segments than one chunk of manifest can name, so the window has certainly slid.
 *
 * A stream long enough to overflow rather than a count one past the window, because the window is a
 * byte budget: how many segments overflow it depends on the reference and gateway URL lengths. The
 * tests below read where the window starts out of the manifest instead of asserting a number.
 */
const OVERFLOWING_SEGMENTS: AddedSegment[] = Array.from({ length: 500 }, (_, index) => ({
  index,
  duration: 4,
  ref: `ref-${index}`,
}));

function assertWindowSlid(held: number): void {
  assert.ok(
    held > 0 && held < OVERFLOWING_SEGMENTS.length,
    `the window held ${held} of ${OVERFLOWING_SEGMENTS.length} segments, so it did not slide and this asserts nothing`,
  );
}

/** Fractional and integer durations both, because `#EXTINF` carries seconds rather than a count. */
const SEGMENTS: AddedSegment[] = [
  { index: 0, duration: 4, ref: 'ref-a' },
  { index: 1, duration: 3.5, ref: 'ref-b' },
  { index: 2, duration: 4.002, ref: 'ref-c', discontinuity: true },
  { index: 3, duration: 2, ref: 'ref-d' },
];

describe('manifest round trip (ARCH-1)', () => {
  for (const [name, build] of [
    ['live', (m: ManifestManager) => m.buildLiveManifest()],
    ['VOD', (m: ManifestManager) => m.buildVODManifest()],
  ] as const) {
    it(`a ${name} manifest parses back to the segments it was built from`, () => {
      const manifest = build(managerWith(SEGMENTS));

      const parsed = parseManifest(manifest);

      assert.equal(parsed.segments.length, SEGMENTS.length, `the ${name} manifest lost or invented a segment`);
      assert.deepEqual(
        parsed.segments.map((s) => s.uri),
        SEGMENTS.map((s) => `${BEE_URL}/${s.ref}`),
        'segment URIs did not survive the round trip in order',
      );
    });

    it(`a ${name} manifest keeps every duration exactly`, () => {
      const manifest = build(managerWith(SEGMENTS));

      const parsed = parseManifest(manifest);

      assert.deepEqual(
        parsed.segments.map((s) => segmentDuration(s.extinf)),
        SEGMENTS.map((s) => s.duration),
        'a duration was rounded, dropped or misread',
      );
    });

    it(`a ${name} manifest keeps the discontinuity on the segment that follows it`, () => {
      const manifest = build(managerWith(SEGMENTS));

      const parsed = parseManifest(manifest);

      assert.deepEqual(
        parsed.segments.map((s) => s.discontinuity === true),
        SEGMENTS.map((s) => s.discontinuity === true),
        'the discontinuity moved to another segment or vanished',
      );
    });
  }

  // The one fact a reader must not miss: a finished recording is finalized and a running broadcast
  // is not. Getting this backwards either strands the player polling a stream that ended, or stops
  // it polling one that is still going.
  it('marks a VOD manifest finalized and a live one not', () => {
    const manager = managerWith(SEGMENTS);

    assert.equal(parseManifest(manager.buildVODManifest()).isFinalized, true, 'a finished recording read as live');
    assert.equal(parseManifest(manager.buildLiveManifest()).isFinalized, false, 'a running broadcast read as finished');
  });

  // The live window is the builder's, not the parser's, so the round trip has to survive it rather
  // than assume every segment is present.
  it('round-trips only the live window once the stream outgrows it', () => {
    const parsed = parseManifest(managerWith(OVERFLOWING_SEGMENTS).buildLiveManifest());

    assertWindowSlid(parsed.segments.length);
    assert.deepEqual(
      parsed.segments.map((s) => s.uri),
      OVERFLOWING_SEGMENTS.slice(-parsed.segments.length).map((s) => `${BEE_URL}/${s.ref}`),
      'the live window did not round-trip as the newest segments it holds',
    );
  });

  // Every header the builder writes was discarded by the round trip: setting TARGETDURATION to 0,
  // forcing the media sequence to 0, and flipping PLAYLIST_TYPE from VOD to EVENT each left the whole
  // suite green. The segment list is only half of what a player reads.
  it('carries the target duration, rounded up to whole seconds', () => {
    const parsed = parseManifest(managerWith(SEGMENTS).buildLiveManifest());

    // 4.002 is the longest segment, and #EXT-X-TARGETDURATION is an integer that must not be less
    // than any segment's duration, so it rounds up rather than to nearest.
    assert.ok(
      parsed.headers.includes(`${HLS_TARGET_DURATION}:5`),
      `target duration missing or wrong: ${JSON.stringify(parsed.headers)}`,
    );
  });

  it('carries a media sequence of 0 while the stream fits in the live window', () => {
    const parsed = parseManifest(managerWith(SEGMENTS).buildLiveManifest());

    assert.ok(
      parsed.headers.includes(`${HLS_MEDIA_SEQUENCE}:0`),
      `media sequence missing or wrong: ${JSON.stringify(parsed.headers)}`,
    );
  });

  // The one assertion that needs the window to have slid. A media sequence stuck at 0 tells a player
  // that the first segment it can see is the first there ever was, so a viewer joining late replays
  // from the wrong point. Checked against the segment it names rather than against a number, since
  // where the window starts is now whatever the byte budget allows.
  it('advances the media sequence to the first segment the window still names', () => {
    const parsed = parseManifest(managerWith(OVERFLOWING_SEGMENTS).buildLiveManifest());
    const declared = parsed.headers.find((header) => header.startsWith(`${HLS_MEDIA_SEQUENCE}:`));

    assert.ok(declared, `media sequence missing: ${JSON.stringify(parsed.headers)}`);
    assertWindowSlid(parsed.segments.length);

    const first = Number(declared.slice(`${HLS_MEDIA_SEQUENCE}:`.length));
    assert.ok(first > 0, `the media sequence stayed at ${first} while the window slid`);
    assert.equal(
      parsed.segments[0].uri,
      `${BEE_URL}/ref-${first}`,
      'the media sequence does not name the first segment in the window',
    );
  });

  it('marks a VOD manifest as VOD and a live one not at all', () => {
    const manager = managerWith(SEGMENTS);

    assert.ok(
      parseManifest(manager.buildVODManifest()).headers.includes(HLS_PLAYLIST_TYPE_VOD),
      'a finished recording did not declare itself VOD',
    );
    for (const header of parseManifest(manager.buildLiveManifest()).headers) {
      assert.doesNotMatch(header, /^#EXT-X-PLAYLIST-TYPE/, 'a running broadcast declared a playlist type');
    }
  });

  it('carries the headers through as header lines rather than segments', () => {
    const parsed = parseManifest(managerWith(SEGMENTS).buildLiveManifest());

    assert.ok(
      parsed.headers.includes('#EXTM3U'),
      `the parser did not see the playlist header: ${JSON.stringify(parsed.headers)}`,
    );
    for (const header of parsed.headers) {
      assert.ok(header.startsWith('#'), `a segment URI was read as a header: ${header}`);
    }
  });

  it('reports an empty manifest as no segments rather than throwing', () => {
    const parsed = parseManifest(new ManifestManager(BEE_URL).buildLiveManifest());

    assert.deepEqual(parsed.segments, []);
    assert.equal(parsed.isFinalized, false);
  });
});
