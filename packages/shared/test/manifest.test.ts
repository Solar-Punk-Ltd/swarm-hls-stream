import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildExtinf, parseManifest, segmentDuration } from '../src/manifest.js';

describe('segmentDuration', () => {
  it('reads the fractional seconds an EXTINF line carries', () => {
    assert.equal(segmentDuration('#EXTINF:4.002,'), 4.002);
  });

  it('reads a whole-second duration', () => {
    assert.equal(segmentDuration('#EXTINF:4,'), 4);
  });

  it('reads a duration written with a title after the comma', () => {
    assert.equal(segmentDuration('#EXTINF:3.5,segment title'), 3.5);
  });

  // Returning 0 for a line that carries no duration would be indistinguishable from a real
  // zero-length segment, which is how a malformed playlist becomes a silently wrong timeline.
  it('returns null for a line that is not an EXTINF', () => {
    assert.equal(segmentDuration('#EXT-X-ENDLIST'), null);
  });

  it('returns null when the value is not a number', () => {
    assert.equal(segmentDuration('#EXTINF:soon,'), null);
  });

  it('round-trips what buildExtinf writes', () => {
    assert.equal(segmentDuration(buildExtinf(4.002)), 4.002);
  });
});

describe('parseManifest', () => {
  const LIVE = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', ''];

  it('separates header lines from segments', () => {
    const parsed = parseManifest([...LIVE, '#EXTINF:4,', 'seg0.ts'].join('\n'));

    assert.deepEqual(parsed.headers, LIVE.filter(Boolean));
    assert.equal(parsed.segments.length, 1);
  });

  it('attaches a discontinuity to the segment that follows it, not the one before', () => {
    const parsed = parseManifest(
      [...LIVE, '#EXTINF:4,', 'seg0.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:4,', 'seg1.ts'].join('\n'),
    );

    assert.deepEqual(
      parsed.segments.map((s) => s.discontinuity),
      [false, true],
    );
  });

  it('does not carry a discontinuity past the segment it belongs to', () => {
    const parsed = parseManifest(
      [...LIVE, '#EXT-X-DISCONTINUITY', '#EXTINF:4,', 'seg0.ts', '#EXTINF:4,', 'seg1.ts'].join('\n'),
    );

    assert.deepEqual(
      parsed.segments.map((s) => s.discontinuity),
      [true, false],
    );
  });

  it('reports ENDLIST as finalized', () => {
    const parsed = parseManifest([...LIVE, '#EXTINF:4,', 'seg0.ts', '#EXT-X-ENDLIST'].join('\n'));

    assert.equal(parsed.isFinalized, true);
  });

  it('reports a playlist without ENDLIST as still running', () => {
    assert.equal(parseManifest([...LIVE, '#EXTINF:4,', 'seg0.ts'].join('\n')).isFinalized, false);
  });

  // An EXTINF whose URI line never arrived is a truncated playlist. Pairing it with whatever tag
  // came next would hand the player a tag as a media URI.
  it('drops an EXTINF whose next line is another tag', () => {
    const parsed = parseManifest([...LIVE, '#EXTINF:4,', '#EXT-X-ENDLIST'].join('\n'));

    assert.deepEqual(parsed.segments, []);
    assert.equal(parsed.isFinalized, true);
  });

  it('drops a trailing EXTINF with nothing after it', () => {
    assert.deepEqual(parseManifest([...LIVE, '#EXTINF:4,'].join('\n')).segments, []);
  });

  it('returns nothing for empty input rather than throwing', () => {
    assert.deepEqual(parseManifest(''), { headers: [], segments: [], isFinalized: false });
  });

  it('tolerates the trailing newline every builder here writes', () => {
    assert.equal(parseManifest([...LIVE, '#EXTINF:4,', 'seg0.ts', ''].join('\n')).segments.length, 1);
  });

  // A tag emitted after the first segment is not a header, and treating it as one would reorder it
  // above the segments when the playlist is rebuilt.
  it('stops collecting headers once a segment has been seen', () => {
    const parsed = parseManifest([...LIVE, '#EXTINF:4,', 'seg0.ts', '#EXT-X-TARGETDURATION:9'].join('\n'));

    assert.ok(!parsed.headers.includes('#EXT-X-TARGETDURATION:9'));
  });
});
