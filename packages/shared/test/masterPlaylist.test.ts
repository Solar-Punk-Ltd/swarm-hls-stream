import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildMasterPlaylist,
  buildSwarmUri,
  parseSwarmUri,
  type Rendition,
  SWARM_SCHEME,
} from '../src/masterPlaylist.js';

const OWNER = 'aabbcc';

function rung(overrides: Partial<Rendition> = {}): Rendition {
  return {
    name: '720p',
    width: 1280,
    height: 720,
    topic: 'topic-720p',
    bandwidth: 2_800_000,
    avgBandwidth: 2_400_000,
    ...overrides,
  };
}

describe('buildMasterPlaylist', () => {
  it('emits one EXT-X-STREAM-INF per rung, each followed by its feed URI', () => {
    const master = buildMasterPlaylist(OWNER, [
      rung({ name: '360p', width: 640, height: 360, topic: 't360', bandwidth: 700_000, avgBandwidth: 600_000 }),
      rung({ topic: 't720' }),
    ]);

    assert.deepEqual(master.trim().split('\n'), [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-STREAM-INF:BANDWIDTH=700000,AVERAGE-BANDWIDTH=600000,RESOLUTION=640x360',
      `${SWARM_SCHEME}${OWNER}/t360`,
      '#EXT-X-STREAM-INF:BANDWIDTH=2800000,AVERAGE-BANDWIDTH=2400000,RESOLUTION=1280x720',
      `${SWARM_SCHEME}${OWNER}/t720`,
    ]);
  });

  it('keeps the order it was given, since a master lists rungs lowest first', () => {
    const master = buildMasterPlaylist(OWNER, [rung({ topic: 'first' }), rung({ topic: 'second' })]);
    const uris = master.split('\n').filter((line) => line.startsWith(SWARM_SCHEME));

    assert.deepEqual(uris, [`${SWARM_SCHEME}${OWNER}/first`, `${SWARM_SCHEME}${OWNER}/second`]);
  });

  it('writes variant URIs with a scheme, so hls.js resolves them to themselves', () => {
    const master = buildMasterPlaylist(OWNER, [rung()]);

    for (const line of master.split('\n').filter((l) => l && !l.startsWith('#'))) {
      assert.ok(line.startsWith(SWARM_SCHEME), `${line} would be resolved against the playlist's own URL`);
    }
  });

  it('rounds bandwidths, because BANDWIDTH is an integer in the HLS grammar', () => {
    const master = buildMasterPlaylist(OWNER, [rung({ bandwidth: 2_799_999.6, avgBandwidth: 2_400_000.4 })]);

    assert.match(master, /BANDWIDTH=2800000,AVERAGE-BANDWIDTH=2400000/);
  });

  it('names no CODECS, so hls.js keeps a rung it would otherwise have discarded', () => {
    assert.doesNotMatch(buildMasterPlaylist(OWNER, [rung()]), /CODECS/);
  });

  it('produces a header-only playlist when the ladder is empty', () => {
    assert.equal(buildMasterPlaylist(OWNER, []).trim().split('\n').length, 3);
  });
});

describe('swarm URIs', () => {
  it('round-trips owner and topic', () => {
    assert.deepEqual(parseSwarmUri(buildSwarmUri(OWNER, 'topic')), { owner: OWNER, topic: 'topic' });
  });

  it('still parses the bare owner/topic form hls.js hands back for a single rendition', () => {
    assert.deepEqual(parseSwarmUri(`${OWNER}/topic`), { owner: OWNER, topic: 'topic' });
  });
});
