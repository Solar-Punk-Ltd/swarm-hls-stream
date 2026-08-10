import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  absoluteBytesBase,
  buildMasterPlaylist,
  buildSwarmUri,
  isMasterPlaylist,
  masterVariants,
  parseManifest,
  parseSwarmUri,
} from '../src/components/SwarmHlsPlayer/playlist.js';
import type { Rendition } from '../src/types/stream.js';

const rendition = (name: string, width: number, height: number, bandwidth: number): Rendition => ({
  name,
  width,
  height,
  topic: `group-1-${name}`,
  bandwidth,
  avgBandwidth: Math.round(bandwidth * 0.9),
});

describe('swarm URIs', () => {
  it('round-trips owner and topic', () => {
    const uri = buildSwarmUri('aabbcc', 'group-1-720p');

    assert.equal(uri, 'swarm://aabbcc/group-1-720p');
    assert.deepEqual(parseSwarmUri(uri), { owner: 'aabbcc', topic: 'group-1-720p' });
  });

  it('still parses the bare owner/topic form hls.js hands back for a single rendition', () => {
    assert.deepEqual(parseSwarmUri('aabbcc/topic-uuid'), { owner: 'aabbcc', topic: 'topic-uuid' });
  });
});

describe('absoluteBytesBase', () => {
  const origin = 'http://localhost:5173';

  it('absolutises the dev proxy path, which is otherwise resolved against swarm://', () => {
    // The bug this exists to prevent: a root-relative "/bee/bytes/<ref>" in a media playlist whose
    // own URL is swarm://<owner>/<topic> resolves to swarm://<owner>/bee/bytes/<ref>, and the
    // fragment loader then requests <origin>//<owner>/bee/bytes/<ref> — which a dev server answers
    // with index.html rather than a segment.
    assert.equal(absoluteBytesBase('/bee', origin), 'http://localhost:5173/bee/bytes');
  });

  it('leaves an already absolute gateway alone', () => {
    assert.equal(absoluteBytesBase('http://localhost:1653', origin), 'http://localhost:1653/bytes');
    assert.equal(absoluteBytesBase('https://gateway.example', origin), 'https://gateway.example/bytes');
  });

  it('does not double the slash on a trailing-slash gateway URL', () => {
    assert.equal(absoluteBytesBase('http://localhost:1653/', origin), 'http://localhost:1653/bytes');
  });

  it('always returns something with a scheme, whatever it was given', () => {
    for (const beeUrl of ['/bee', 'http://localhost:1653', 'https://gateway.example/']) {
      assert.match(absoluteBytesBase(beeUrl, origin), /^https?:\/\//, `"${beeUrl}" must absolutise`);
    }
  });
});

describe('buildMasterPlaylist', () => {
  const renditions = [
    rendition('360p', 640, 360, 700_000),
    rendition('720p', 1280, 720, 2_800_000),
    rendition('1080p', 1920, 1080, 5_000_000),
  ];

  it('emits one EXT-X-STREAM-INF per rung, each followed by its feed URI', () => {
    const master = buildMasterPlaylist('aabbcc', renditions);

    assert.deepEqual(master.trim().split('\n'), [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-STREAM-INF:BANDWIDTH=700000,AVERAGE-BANDWIDTH=630000,RESOLUTION=640x360',
      'swarm://aabbcc/group-1-360p',
      '#EXT-X-STREAM-INF:BANDWIDTH=2800000,AVERAGE-BANDWIDTH=2520000,RESOLUTION=1280x720',
      'swarm://aabbcc/group-1-720p',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1920x1080',
      'swarm://aabbcc/group-1-1080p',
    ]);
  });

  it('writes variant URIs with a scheme, so hls.js resolves them to themselves', () => {
    // A bare `owner/topic` would come back out of url-toolkit as `owner/owner/topic`, because a
    // base URL with no scheme has its first path segment treated as the host.
    const master = buildMasterPlaylist('aabbcc', renditions);

    for (const line of master.split('\n').filter((l) => l && !l.startsWith('#'))) {
      assert.ok(line.startsWith('swarm://'), `variant URI "${line}" must carry a scheme`);
    }
  });

  it('rounds bandwidths, because BANDWIDTH is an integer in the HLS grammar', () => {
    const master = buildMasterPlaylist('aabbcc', [
      { ...rendition('720p', 1280, 720, 2_799_999.6), avgBandwidth: 2_519_999.4 },
    ]);

    assert.match(master, /BANDWIDTH=2800000,AVERAGE-BANDWIDTH=2519999,/);
  });

  it('produces a header-only playlist when the ladder is empty', () => {
    assert.equal(buildMasterPlaylist('aabbcc', []).trim().split('\n').length, 3);
  });
});

describe('isMasterPlaylist', () => {
  // What a feed answered with is the only thing that says whether a stream is a ladder. Get this
  // wrong in either direction and the loader takes the wrong branch: a master fed through the
  // media-playlist path parses as zero segments and the stream never starts, while a media playlist
  // mistaken for a master has its rungs polled as if its segment refs were feed topics.
  it('recognises a multivariant playlist', () => {
    assert.equal(isMasterPlaylist(buildMasterPlaylist('aabbcc', [rendition('360p', 640, 360, 700_000)])), true);
  });

  it('does not mistake a media playlist for one', () => {
    const media = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXTINF:1.5,', 'ref-0'].join('\n');

    assert.equal(isMasterPlaylist(media), false);
  });

  it('does not call an empty or headers-only playlist a master', () => {
    assert.equal(isMasterPlaylist(''), false);
    assert.equal(isMasterPlaylist(buildMasterPlaylist('aabbcc', [])), false);
  });
});

describe('masterVariants', () => {
  const renditions = [
    rendition('360p', 640, 360, 700_000),
    rendition('720p', 1280, 720, 2_800_000),
    rendition('1080p', 1920, 1080, 5_000_000),
  ];

  it('round-trips what the uploader published, in the order it listed', () => {
    const variants = masterVariants(buildMasterPlaylist('aabbcc', renditions));

    assert.deepEqual(variants, [
      { owner: 'aabbcc', topic: 'group-1-360p' },
      { owner: 'aabbcc', topic: 'group-1-720p' },
      { owner: 'aabbcc', topic: 'group-1-1080p' },
    ]);
  });

  it('skips a STREAM-INF with no URI after it rather than pairing it with the next tag', () => {
    // A truncated feed read ends mid-entry. Consuming the following tag as a topic would start a
    // walk on a feed that cannot exist, and the rung it belonged to would never be polled.
    const truncated = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360',
      '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720',
      'swarm://aabbcc/group-1-720p',
    ].join('\n');

    assert.deepEqual(masterVariants(truncated), [{ owner: 'aabbcc', topic: 'group-1-720p' }]);
  });

  it('tolerates CRLF and surrounding blank lines, which a gateway may add', () => {
    const master = `\r\n#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=700000\r\nswarm://aabbcc/group-1-360p\r\n\r\n`;

    assert.deepEqual(masterVariants(master), [{ owner: 'aabbcc', topic: 'group-1-360p' }]);
  });

  it('finds nothing in a media playlist, so its segment refs are never read as topics', () => {
    const media = ['#EXTM3U', '#EXTINF:1.5,', 'http://bee/bytes/aaaa'].join('\n');

    assert.deepEqual(masterVariants(media), []);
  });
});

describe('parseManifest', () => {
  it('separates headers from segments and reports a finalized playlist', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '',
      '#EXTINF:1.5,',
      'http://bee/bytes/aaaa',
      '#EXTINF:1.5,',
      'http://bee/bytes/bbbb',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const parsed = parseManifest(text);

    assert.deepEqual(parsed.headers, [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:0',
    ]);
    assert.deepEqual(
      parsed.segments.map((s) => s.uri),
      ['http://bee/bytes/aaaa', 'http://bee/bytes/bbbb'],
    );
    assert.equal(parsed.isFinalized, true);
  });

  it('reports a live playlist as not finalized', () => {
    const parsed = parseManifest('#EXTM3U\n#EXTINF:1.5,\naaaa\n');

    assert.equal(parsed.isFinalized, false);
    assert.equal(parsed.segments.length, 1);
  });
});
