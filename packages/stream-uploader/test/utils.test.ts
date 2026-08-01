import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isMasterPlaylist, parseAppStream, parseMasterPlaylist, parseMediaPlaylist } from '../src/engines/ome/utils.js';

describe('parseAppStream', () => {
  it('parses app and stream from the URL path', () => {
    assert.deepEqual(parseAppStream('srt://127.0.0.1:10080/video/test'), { app: 'video', stream: 'test' });
  });

  it('parses RTMP URLs', () => {
    assert.deepEqual(parseAppStream('rtmp://host:1935/audio/show'), { app: 'audio', stream: 'show' });
  });

  it('parses app and stream from the streamid query param', () => {
    assert.deepEqual(parseAppStream('srt://127.0.0.1:10080?streamid=srt://127.0.0.1:10080/video/test'), {
      app: 'video',
      stream: 'test',
    });
  });

  it('parses a percent-encoded streamid query param', () => {
    assert.deepEqual(parseAppStream('srt://127.0.0.1:10080?streamid=srt%3A%2F%2F127.0.0.1%3A10080%2Fvideo%2Ftest'), {
      app: 'video',
      stream: 'test',
    });
  });

  it('prefers the URL path over the streamid query param', () => {
    assert.deepEqual(parseAppStream('srt://host:10080/video/test?streamid=srt://host:10080/audio/other'), {
      app: 'video',
      stream: 'test',
    });
  });

  it('returns undefined fields when the URL has no app/stream and no streamid', () => {
    assert.deepEqual(parseAppStream('srt://127.0.0.1:10080'), { app: undefined, stream: undefined });
    assert.deepEqual(parseAppStream('srt://127.0.0.1:10080/video'), { app: 'video', stream: undefined });
  });

  it('returns undefined fields when the streamid has no app/stream', () => {
    assert.deepEqual(parseAppStream('srt://host:10080?streamid=srt://host:10080/video'), {
      app: 'video',
      stream: undefined,
    });
  });

  it('throws when the URL is not parseable', () => {
    assert.throws(() => parseAppStream('not a url'), /Could not parse app\/stream/);
  });
});

describe('isMasterPlaylist', () => {
  it('detects a master playlist by its #EXT-X-STREAM-INF tag', () => {
    const text = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', 'chunklist_360p.m3u8'].join('\n');

    assert.equal(isMasterPlaylist(text), true);
  });

  it('detects a master playlist with CRLF line endings and indented tags', () => {
    const text = '#EXTM3U\r\n  #EXT-X-STREAM-INF:BANDWIDTH=800000\r\nvariant.m3u8\r\n';

    assert.equal(isMasterPlaylist(text), true);
  });

  it('returns false for a media playlist', () => {
    const text = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:0', '#EXTINF:2.0,', 'segment_0.ts'].join('\n');

    assert.equal(isMasterPlaylist(text), false);
  });

  it('returns false for an empty playlist', () => {
    assert.equal(isMasterPlaylist(''), false);
  });
});

describe('parseMasterPlaylist', () => {
  it('returns the URI of the first variant in a master playlist', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      'chunklist_360p.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
      'chunklist_720p.m3u8',
    ].join('\n');

    assert.equal(parseMasterPlaylist(text), 'chunklist_360p.m3u8');
  });

  it('skips blank lines and comments between the stream-inf tag and the variant URI', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      '',
      '# a comment in between',
      '  ',
      'variant.m3u8',
    ].join('\n');

    assert.equal(parseMasterPlaylist(text), 'variant.m3u8');
  });

  it('trims whitespace around the variant URI and handles CRLF line endings', () => {
    const text = '#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=800000\r\n  variant.m3u8  \r\n';

    assert.equal(parseMasterPlaylist(text), 'variant.m3u8');
  });

  it('throws when a stream-inf tag has no following URI', () => {
    const text = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000', '', '# trailing comment'].join('\n');

    assert.throws(() => parseMasterPlaylist(text), /no variant URI/);
  });

  it('throws for a media playlist (callers must check isMasterPlaylist first)', () => {
    const text = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0', '#EXTINF:2.0,', 'segment_0.ts'].join('\n');

    assert.throws(() => parseMasterPlaylist(text), /no variant URI/);
  });
});

describe('parseMediaPlaylist', () => {
  it('parses segments with sequence numbers based on the media sequence', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:100',
      '#EXTINF:2.0,',
      'segment_100.ts',
      '#EXTINF:1.96,',
      'segment_101.ts',
      '#EXTINF:2.04,',
      'segment_102.ts',
    ].join('\n');

    assert.deepEqual(parseMediaPlaylist(text), [
      { seq: 100, duration: 2.0, uri: 'segment_100.ts' },
      { seq: 101, duration: 1.96, uri: 'segment_101.ts' },
      { seq: 102, duration: 2.04, uri: 'segment_102.ts' },
    ]);
  });

  it('defaults the media sequence to 0 when the tag is absent', () => {
    const text = ['#EXTM3U', '#EXTINF:2.0,', 'a.ts', '#EXTINF:2.0,', 'b.ts'].join('\n');

    assert.deepEqual(
      parseMediaPlaylist(text).map((e) => e.seq),
      [0, 1],
    );
  });

  it('parses a playlist whose media sequence reset to 0 (e.g. after an encoder restart)', () => {
    const text = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0', '#EXTINF:2.0,', 'segment_0.ts'].join('\n');

    assert.deepEqual(parseMediaPlaylist(text), [{ seq: 0, duration: 2.0, uri: 'segment_0.ts' }]);
  });

  it('falls back to media sequence 0 when the tag value is not a number', () => {
    const text = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:garbage', '#EXTINF:2.0,', 'a.ts'].join('\n');

    assert.deepEqual(
      parseMediaPlaylist(text).map((e) => e.seq),
      [0],
    );
  });

  // `#EXT-X-DISCONTINUITY` used to be in this list and is not any more: it is the one tag here that
  // changes what the segment after it means, and it has its own test below. See CON-9.
  it('ignores blank lines, comments, and unrelated tags between segments', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:5',
      '',
      '#EXTINF:2.0,',
      '# just a comment',
      '#EXT-X-KEY:METHOD=NONE',
      'a.ts',
      '   ',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXTINF:2.0,',
      'b.ts',
    ].join('\n');

    assert.deepEqual(parseMediaPlaylist(text), [
      { seq: 5, duration: 2.0, uri: 'a.ts' },
      { seq: 6, duration: 2.0, uri: 'b.ts' },
    ]);
  });

  it('parses the duration from an #EXTINF tag with a title after the comma', () => {
    const text = ['#EXTM3U', '#EXTINF:3.337,some title', 'a.ts'].join('\n');

    assert.deepEqual(parseMediaPlaylist(text), [{ seq: 0, duration: 3.337, uri: 'a.ts' }]);
  });

  it('skips a URI line that has no preceding #EXTINF, without consuming a sequence number', () => {
    const text = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:10', 'orphan.ts', '#EXTINF:2.0,', 'a.ts'].join('\n');

    assert.deepEqual(parseMediaPlaylist(text), [{ seq: 10, duration: 2.0, uri: 'a.ts' }]);
  });

  it('does not reuse an #EXTINF duration for more than one URI', () => {
    const text = ['#EXTM3U', '#EXTINF:2.0,', 'a.ts', 'b.ts'].join('\n');

    assert.deepEqual(parseMediaPlaylist(text), [{ seq: 0, duration: 2.0, uri: 'a.ts' }]);
  });

  // Every one of these used to become the segment's duration verbatim. It reaches `#EXTINF` in the
  // manifest we publish, which makes that playlist unplayable, and it poisons the total the VOD
  // catalog entry advertises. See CON-7.
  const UNUSABLE_DURATIONS = [
    { label: 'non-numeric', extinf: '#EXTINF:not-a-number,' },
    { label: 'empty', extinf: '#EXTINF:,' },
    { label: 'missing entirely', extinf: '#EXTINF:' },
    { label: 'whitespace only', extinf: '#EXTINF: ,' },
    { label: 'infinite', extinf: '#EXTINF:Infinity,' },
    { label: 'negative', extinf: '#EXTINF:-2.0,' },
  ];

  for (const { label, extinf } of UNUSABLE_DURATIONS) {
    it(`skips a segment whose #EXTINF duration is ${label}, without renumbering the ones behind it`, () => {
      const text = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:10', extinf, 'bad.ts', '#EXTINF:2.0,', 'good.ts'].join('\n');

      // seq 11, not 10. The skipped position is spent either way, because the origin numbers by
      // position: renumbering the rest onto it hands every later segment an index that belongs to
      // other media, and the duplicate filter then swallows real segments as ones already seen.
      assert.deepEqual(parseMediaPlaylist(text), [{ seq: 11, duration: 2.0, uri: 'good.ts' }]);
    });
  }

  it('keeps a zero duration, which is degenerate but not unusable', () => {
    const text = ['#EXTM3U', '#EXTINF:0,', 'a.ts'].join('\n');

    assert.deepEqual(parseMediaPlaylist(text), [{ seq: 0, duration: 0, uri: 'a.ts' }]);
  });

  // The tag an origin sends when the media after it is not a continuation of the media before it,
  // which is what an encoder restart produces. Swallowed with every other `#` line, the manifest we
  // publish told players the join was seamless and they stalled on it instead of resetting. See CON-9.
  it('marks the segment after an #EXT-X-DISCONTINUITY, and only that one', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:2.0,',
      'a.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:2.0,',
      'b.ts',
      '#EXTINF:2.0,',
      'c.ts',
    ].join('\n');

    assert.deepEqual(parseMediaPlaylist(text), [
      { seq: 0, duration: 2.0, uri: 'a.ts' },
      { seq: 1, duration: 2.0, uri: 'b.ts', discontinuity: true },
      { seq: 2, duration: 2.0, uri: 'c.ts' },
    ]);
  });

  it('does not carry a date across a discontinuity, in either direction', () => {
    const stamped = [
      '#EXTM3U',
      '#EXT-X-PROGRAM-DATE-TIME:2026-08-01T10:00:00.000Z',
      '#EXTINF:2.0,',
      'a.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:2.0,',
      'b.ts',
    ].join('\n');

    // Forward: the tag says the timeline restarts, so the next segment's start cannot be derived by
    // adding a duration to the last one. Unknown is the honest answer, and the handover floor CON-20
    // reads this for treats unknown as "cannot judge" rather than acting on a wrong number.
    assert.deepEqual(
      parseMediaPlaylist(stamped).map((entry) => entry.programDateTime),
      [Date.parse('2026-08-01T10:00:00.000Z'), undefined],
    );

    const stampedAfter = [
      '#EXTM3U',
      '#EXTINF:2.0,',
      'a.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-PROGRAM-DATE-TIME:2026-08-01T10:00:00.000Z',
      '#EXTINF:2.0,',
      'b.ts',
    ].join('\n');

    // Backward, which RFC 8216 6.3.3 otherwise allows: extrapolating back over the same boundary dates
    // the older media off the newer timeline, and it is exactly as wrong.
    assert.deepEqual(
      parseMediaPlaylist(stampedAfter).map((entry) => entry.programDateTime),
      [undefined, Date.parse('2026-08-01T10:00:00.000Z')],
    );
  });

  it('handles CRLF line endings and surrounding whitespace', () => {
    const text = '#EXTM3U\r\n#EXT-X-MEDIA-SEQUENCE:1\r\n#EXTINF:2.5,\r\n  a.ts  \r\n';

    assert.deepEqual(parseMediaPlaylist(text), [{ seq: 1, duration: 2.5, uri: 'a.ts' }]);
  });

  it('returns an empty array for an empty or tag-only playlist', () => {
    assert.deepEqual(parseMediaPlaylist(''), []);
    assert.deepEqual(parseMediaPlaylist('#EXTM3U\n#EXT-X-ENDLIST'), []);
  });

  // The date-time is the only field that separates one session's media from the next one's, since OME
  // restarts the media sequence at zero and reuses its segment file names across both. See CON-20.
  describe('#EXT-X-PROGRAM-DATE-TIME', () => {
    it('stamps each segment from the date-time that precedes it', () => {
      const text = [
        '#EXTM3U',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PROGRAM-DATE-TIME:2026-07-31T14:20:45.325+00:00',
        '#EXTINF:2.0,',
        'a.ts',
        '#EXT-X-PROGRAM-DATE-TIME:2026-07-31T14:20:47.325+00:00',
        '#EXTINF:2.0,',
        'b.ts',
      ].join('\n');

      assert.deepEqual(
        parseMediaPlaylist(text).map((entry) => entry.programDateTime),
        [Date.parse('2026-07-31T14:20:45.325Z'), Date.parse('2026-07-31T14:20:47.325Z')],
      );
    });

    // RFC 8216 lets a playlist stamp only its first segment. Deriving the rest is what keeps the floor
    // working against an origin that spells it that way, and a floor that quietly covers one segment
    // out of five looks exactly like one that covers all of them.
    it('derives later segments from one date-time and the durations before them', () => {
      const text = [
        '#EXTM3U',
        '#EXT-X-PROGRAM-DATE-TIME:2026-07-31T14:20:45.000+00:00',
        '#EXTINF:2.0,',
        'a.ts',
        '#EXTINF:3.5,',
        'b.ts',
        '#EXTINF:2.0,',
        'c.ts',
      ].join('\n');

      const base = Date.parse('2026-07-31T14:20:45.000Z');
      assert.deepEqual(
        parseMediaPlaylist(text).map((entry) => entry.programDateTime),
        [base, base + 2_000, base + 5_500],
      );
    });

    it('leaves the field off a playlist that carries no date-time', () => {
      const text = ['#EXTM3U', '#EXTINF:2.0,', 'a.ts'].join('\n');

      assert.deepEqual(parseMediaPlaylist(text), [{ seq: 0, duration: 2.0, uri: 'a.ts' }]);
    });

    // An unparseable date parses to NaN, and NaN compares false against any floor, so carrying it
    // would turn every comparison into a silent pass. Absent says the same thing and says it once.
    it('leaves the field off when the date-time cannot be parsed', () => {
      const text = ['#EXTM3U', '#EXT-X-PROGRAM-DATE-TIME:not-a-date', '#EXTINF:2.0,', 'a.ts'].join('\n');

      assert.deepEqual(parseMediaPlaylist(text), [{ seq: 0, duration: 2.0, uri: 'a.ts' }]);
    });

    /**
     * RFC 8216 section 6.3.3 has a client extrapolate backward when the first date-time appears after
     * some segments. An origin stamping on an interval rather than per segment serves exactly that
     * once its window slides past the first tag, and without this the oldest segments carry no date at
     * all, which a consumer reads as "cannot judge" rather than "old".
     */
    it('dates the segments in front of the first date-time by extrapolating backward', () => {
      const text = [
        '#EXTM3U',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXTINF:2.0,',
        'a.ts',
        '#EXTINF:2.0,',
        'b.ts',
        '#EXT-X-PROGRAM-DATE-TIME:2026-07-31T12:00:00.000Z',
        '#EXTINF:2.0,',
        'c.ts',
      ].join('\n');

      const anchor = Date.parse('2026-07-31T12:00:00.000Z');
      assert.deepEqual(
        parseMediaPlaylist(text).map((entry) => entry.programDateTime),
        [anchor - 4_000, anchor - 2_000, anchor],
      );
    });

    it('leaves an unstamped playlist alone rather than inventing an anchor for it', () => {
      const text = ['#EXTM3U', '#EXTINF:2.0,', 'a.ts', '#EXTINF:2.0,', 'b.ts'].join('\n');

      assert.deepEqual(
        parseMediaPlaylist(text).map((entry) => entry.programDateTime),
        [undefined, undefined],
      );
    });

    /**
     * A duration that is not a finite number cannot advance a clock, and adding it carries NaN onto
     * every later entry. NaN then loses every comparison, so a consumer deciding what to keep by
     * date discards all of it. The date side of this hazard is guarded above; this is the other side.
     */
    for (const [label, extinf] of [
      ['a non-numeric duration', '#EXTINF:not-a-number,'],
      ['an empty duration', '#EXTINF:,'],
      ['an infinite duration', '#EXTINF:Infinity,'],
    ]) {
      it(`drops the anchor rather than carrying NaN forward from ${label}`, () => {
        const text = [
          '#EXTM3U',
          '#EXT-X-PROGRAM-DATE-TIME:2026-07-31T12:00:00.000Z',
          '#EXTINF:2.0,',
          'a.ts',
          extinf,
          'b.ts',
          '#EXTINF:2.0,',
          'c.ts',
        ].join('\n');

        const stamps = parseMediaPlaylist(text).map((entry) => entry.programDateTime);
        assert.equal(stamps[2], undefined, `a segment after ${label} must be undated, not NaN: got ${stamps[2]}`);
        assert.ok(
          stamps.every((stamp) => stamp === undefined || Number.isFinite(stamp)),
          `no entry may carry a non-finite date: ${stamps.join(', ')}`,
        );
      });
    }

    // A single space after the colon made Date.parse return NaN, which the guard above turns into a
    // dropped anchor, silently removing the floor for the rest of the playlist. The trim that prevents
    // it had no test until a mutation removed it and nothing noticed.
    it('tolerates whitespace around the date-time value', () => {
      const text = ['#EXTM3U', '#EXT-X-PROGRAM-DATE-TIME: 2026-07-31T12:00:00.000Z ', '#EXTINF:2.0,', 'a.ts'].join(
        '\n',
      );

      assert.equal(parseMediaPlaylist(text)[0].programDateTime, Date.parse('2026-07-31T12:00:00.000Z'));
    });

    /**
     * Byte-for-byte what a real OvenMediaEngine served, captured on 2026-07-31 from
     * `airensoft/ovenmediaengine:latest` under this repo's own `Server.xml.template`, at the instant it
     * asked the admission webhook whether to admit a reconnect. Every case above is hand-written, so
     * all of them would keep passing if OME spelled any of this differently: the `+00:00` offset rather
     * than a `Z`, `2.000` rather than `2.0`, or the tag before `#EXTINF` rather than after it.
     */
    it('parses a playlist captured from a real OvenMediaEngine', () => {
      const captured = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:2',
        '#EXT-X-MEDIA-SEQUENCE:5',
        '#EXT-X-PROGRAM-DATE-TIME:2026-07-31T14:44:54.314+00:00',
        '#EXTINF:2.000,',
        'seg_917977731947844006_5_hls.ts',
        '#EXT-X-PROGRAM-DATE-TIME:2026-07-31T14:44:56.314+00:00',
        '#EXTINF:2.000,',
        'seg_917977731947844006_6_hls.ts',
        '#EXT-X-PROGRAM-DATE-TIME:2026-07-31T14:44:58.314+00:00',
        '#EXTINF:2.000,',
        'seg_917977731947844006_7_hls.ts',
        '',
      ].join('\n');

      assert.deepEqual(parseMediaPlaylist(captured), [
        {
          seq: 5,
          duration: 2,
          uri: 'seg_917977731947844006_5_hls.ts',
          programDateTime: Date.parse('2026-07-31T14:44:54.314Z'),
        },
        {
          seq: 6,
          duration: 2,
          uri: 'seg_917977731947844006_6_hls.ts',
          programDateTime: Date.parse('2026-07-31T14:44:56.314Z'),
        },
        {
          seq: 7,
          duration: 2,
          uri: 'seg_917977731947844006_7_hls.ts',
          programDateTime: Date.parse('2026-07-31T14:44:58.314Z'),
        },
      ]);
    });
  });
});
