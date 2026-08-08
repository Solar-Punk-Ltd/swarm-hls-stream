import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildMasterPlaylist,
  buildSwarmUri,
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
