import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildExtinf,
  buildProgramDateTime,
  parseManifest,
  programDateTimeMs,
  segmentDuration,
} from '../src/manifest.js';

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

  // `String(0.0000001)` is `"1e-7"`, which RFC 8216 does not allow. hls.js reads that line with a
  // regex that captures the leading `1`, so the player treats the segment as one second rather than
  // a ten-millionth of one. The uploader accepts the duration: `isUsableDuration` asks only for a
  // finite number in [0, 3600].
  it('never writes a duration in exponent notation', () => {
    for (const duration of [0.0000001, 1e-323, 0.0000005]) {
      assert.doesNotMatch(buildExtinf(duration), /e-/, `${duration} reached the playlist as an exponent`);
    }
  });

  it('keeps the precision an encoder actually emits', () => {
    assert.equal(buildExtinf(4.002), '#EXTINF:4.002,');
    assert.equal(buildExtinf(3.5), '#EXTINF:3.5,');
    assert.equal(buildExtinf(4), '#EXTINF:4,');
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

  const PDT_0 = '#EXT-X-PROGRAM-DATE-TIME:2026-09-01T12:00:00.000Z';
  const PDT_1 = '#EXT-X-PROGRAM-DATE-TIME:2026-09-01T12:00:04.000Z';

  it('attaches a program date-time to the segment that follows it', () => {
    const parsed = parseManifest([...LIVE, PDT_0, '#EXTINF:4,', 'seg0.ts', PDT_1, '#EXTINF:4,', 'seg1.ts'].join('\n'));

    assert.deepEqual(
      parsed.segments.map((s) => s.programDateTime),
      [PDT_0, PDT_1],
    );
  });

  // The header branch is where a per-segment tag emitted before the first segment used to land, and
  // a client that captures the first playlist's headers once would then repeat that one instant
  // above every segment it ever appends.
  it('keeps the first segment’s program date-time out of the headers', () => {
    const parsed = parseManifest([...LIVE, PDT_0, '#EXTINF:4,', 'seg0.ts'].join('\n'));

    assert.deepEqual(parsed.headers, LIVE.filter(Boolean));
    assert.equal(parsed.segments[0].programDateTime, PDT_0);
  });

  it('does not carry a program date-time past the segment it belongs to', () => {
    const parsed = parseManifest([...LIVE, PDT_0, '#EXTINF:4,', 'seg0.ts', '#EXTINF:4,', 'seg1.ts'].join('\n'));

    assert.deepEqual(
      parsed.segments.map((s) => s.programDateTime),
      [PDT_0, undefined],
    );
  });

  it('reads a break and the stamp after it as belonging to the same segment', () => {
    const parsed = parseManifest(
      [...LIVE, '#EXTINF:4,', 'seg0.ts', '#EXT-X-DISCONTINUITY', PDT_1, '#EXTINF:4,', 'seg1.ts'].join('\n'),
    );

    assert.deepEqual(parsed.segments[1], {
      extinf: '#EXTINF:4,',
      uri: 'seg1.ts',
      discontinuity: true,
      programDateTime: PDT_1,
    });
  });

  it('leaves the field off a playlist that carries no stamps, which is every old recording', () => {
    const parsed = parseManifest([...LIVE, '#EXTINF:4,', 'seg0.ts'].join('\n'));

    assert.equal(parsed.segments[0].programDateTime, undefined);
  });

  it('counts the segments of a stamped playlist exactly as it counts an unstamped one', () => {
    const stamped = [...LIVE, PDT_0, '#EXTINF:4,', 'seg0.ts', PDT_1, '#EXTINF:4,', 'seg1.ts'];
    const bare = [...LIVE, '#EXTINF:4,', 'seg0.ts', '#EXTINF:4,', 'seg1.ts'];

    assert.equal(parseManifest(stamped.join('\n')).segments.length, parseManifest(bare.join('\n')).segments.length);
  });
});

describe('buildProgramDateTime', () => {
  it('writes UTC to the millisecond, which is the precision RFC 8216 allows', () => {
    assert.equal(
      buildProgramDateTime(Date.UTC(2026, 8, 1, 12, 0, 0) + 500),
      '#EXT-X-PROGRAM-DATE-TIME:2026-09-01T12:00:00.500Z',
    );
  });

  it('round-trips through the reader', () => {
    const at = Date.UTC(2026, 8, 1, 12, 0, 0) + 250;

    assert.equal(programDateTimeMs(buildProgramDateTime(at)), at);
  });
});

describe('programDateTimeMs', () => {
  it('reads an offset spelled as +00:00, which is what other origins write', () => {
    assert.equal(programDateTimeMs('#EXT-X-PROGRAM-DATE-TIME:2026-09-01T12:00:00.000+00:00'), Date.UTC(2026, 8, 1, 12));
  });

  it('tolerates the space some origins leave after the colon', () => {
    assert.equal(programDateTimeMs('#EXT-X-PROGRAM-DATE-TIME: 2026-09-01T12:00:00.000Z '), Date.UTC(2026, 8, 1, 12));
  });

  // Not a number rather than 0, which would date the segment to 1970 and read as a real instant.
  it('answers null for a value that is not a date', () => {
    assert.equal(programDateTimeMs('#EXT-X-PROGRAM-DATE-TIME:not-a-date'), null);
  });

  it('answers null for a line that is not the tag', () => {
    assert.equal(programDateTimeMs('#EXTINF:4,'), null);
  });
});
