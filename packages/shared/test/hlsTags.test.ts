import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as tags from '../src/hlsTags.js';

/**
 * The tag spellings pinned against RFC 8216 rather than against the source that defines them.
 *
 * Moving these into one shared module made client and uploader unable to disagree, which is what
 * ARCH-1 asked for, and it also made a rename invisible to the round-trip test: both sides would
 * move together and still agree with each other while emitting something no player accepts. This is
 * the arm that fails on a rename. Written as literals on purpose, so it cannot be satisfied by
 * whatever the module happens to say today.
 */
const RFC_8216_TAGS: Record<keyof typeof tags, string> = {
  HLS_M3U: '#EXTM3U',
  HLS_VERSION: '#EXT-X-VERSION',
  HLS_TARGET_DURATION: '#EXT-X-TARGETDURATION',
  HLS_MEDIA_SEQUENCE: '#EXT-X-MEDIA-SEQUENCE',
  HLS_PROGRAM_DATE_TIME: '#EXT-X-PROGRAM-DATE-TIME',
  HLS_PLAYLIST_TYPE: '#EXT-X-PLAYLIST-TYPE',
  HLS_EXTINF: '#EXTINF',
  HLS_STREAM_INF: '#EXT-X-STREAM-INF',
  HLS_INDEPENDENT_SEGMENTS: '#EXT-X-INDEPENDENT-SEGMENTS',
  HLS_DISCONTINUITY: '#EXT-X-DISCONTINUITY',
  HLS_ENDLIST: '#EXT-X-ENDLIST',
  HLS_PLAYLIST_TYPE_EVENT: '#EXT-X-PLAYLIST-TYPE:EVENT',
  HLS_MEDIA_SEQUENCE_ZERO: '#EXT-X-MEDIA-SEQUENCE:0',
  HLS_PLAYLIST_TYPE_VOD: '#EXT-X-PLAYLIST-TYPE:VOD',
};

describe('HLS tag spellings (ARCH-1)', () => {
  for (const [name, spelling] of Object.entries(tags)) {
    it(`${name} is ${RFC_8216_TAGS[name as keyof typeof tags]}`, () => {
      assert.equal(spelling, RFC_8216_TAGS[name as keyof typeof tags]);
    });
  }

  // A tag added to the module and to nothing else would otherwise be unpinned, and the table above
  // would go on passing while saying nothing about it.
  it('pins every tag the module exports', () => {
    assert.deepEqual(
      Object.keys(tags).sort(),
      Object.keys(RFC_8216_TAGS).sort(),
      'a tag was added or removed without updating the table this test checks against',
    );
  });
});
