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
    const many = Array.from({ length: 14 }, (_, index) => ({ index, duration: 4, ref: `ref-${index}` }));

    const parsed = parseManifest(managerWith(many).buildLiveManifest());

    assert.deepEqual(
      parsed.segments.map((s) => s.uri),
      many.slice(-10).map((s) => `${BEE_URL}/${s.ref}`),
      'the live window did not round-trip as its last ten segments',
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
  // the tenth segment is the first, so a viewer joining late replays from the wrong point.
  it('advances the media sequence once the stream outgrows the live window', () => {
    const many = Array.from({ length: 14 }, (_, index) => ({ index, duration: 4, ref: `ref-${index}` }));

    const parsed = parseManifest(managerWith(many).buildLiveManifest());

    assert.ok(
      parsed.headers.includes(`${HLS_MEDIA_SEQUENCE}:4`),
      `14 segments in a window of 10 must start at 4: ${JSON.stringify(parsed.headers)}`,
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
