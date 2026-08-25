import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildMasterPlaylist, buildSwarmUri } from '../src/libs/MasterPlaylist.js';
import { buildLadderEntry, LadderIdentity, withMaster } from '../src/libs/StreamCatalog.js';
import { MEDIA_TYPE_VIDEO, Rendition } from '../src/types.js';

const rendition = (name: string, width: number, height: number, bandwidth: number): Rendition => ({
  name,
  width,
  height,
  topic: `group-1-${name}`,
  bandwidth,
  avgBandwidth: Math.round(bandwidth * 0.9),
});

const LADDER = [
  rendition('360p', 640, 360, 700_000),
  rendition('480p', 854, 480, 1_200_000),
  rendition('720p', 1280, 720, 2_800_000),
  rendition('1080p', 1920, 1080, 5_000_000),
];

describe('buildMasterPlaylist', () => {
  it('emits one EXT-X-STREAM-INF per rung, each followed by its feed URI', () => {
    // Byte-for-byte, because the client has a builder of its own for entries written before masters
    // were published (`components/SwarmHlsPlayer/playlist.ts`) and the two have to agree. A viewer
    // whose session started on one and continued on the other would otherwise see the ladder change
    // shape mid-stream. The matching assertion lives in the client's playlist.test.ts.
    assert.deepEqual(buildMasterPlaylist('aabbcc', LADDER).trim().split('\n'), [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-STREAM-INF:BANDWIDTH=700000,AVERAGE-BANDWIDTH=630000,RESOLUTION=640x360',
      'swarm://aabbcc/group-1-360p',
      '#EXT-X-STREAM-INF:BANDWIDTH=1200000,AVERAGE-BANDWIDTH=1080000,RESOLUTION=854x480',
      'swarm://aabbcc/group-1-480p',
      '#EXT-X-STREAM-INF:BANDWIDTH=2800000,AVERAGE-BANDWIDTH=2520000,RESOLUTION=1280x720',
      'swarm://aabbcc/group-1-720p',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1920x1080',
      'swarm://aabbcc/group-1-1080p',
    ]);
  });

  it('writes variant URIs with a scheme, so hls.js resolves them to themselves', () => {
    // A bare `owner/topic` comes back out of url-toolkit's buildAbsoluteURL as `owner/owner/topic`,
    // because a base URL with no scheme has its first path segment treated as the host. Harmless for
    // a single media playlist whose URL is never re-resolved; wrong for every variant of a master.
    for (const line of buildMasterPlaylist('aabbcc', LADDER)
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))) {
      assert.ok(line.startsWith('swarm://'), `variant URI "${line}" must carry a scheme`);
    }
  });

  it('rounds bandwidths, because BANDWIDTH is an integer in the HLS grammar', () => {
    const master = buildMasterPlaylist('aabbcc', [
      { ...rendition('720p', 1280, 720, 2_799_999.6), avgBandwidth: 2_519_999.4 },
    ]);

    assert.match(master, /BANDWIDTH=2800000,AVERAGE-BANDWIDTH=2519999,/);
  });

  it('names no CODECS, so hls.js keeps a rung it would otherwise have discarded', () => {
    assert.doesNotMatch(buildMasterPlaylist('aabbcc', LADDER), /CODECS/);
  });

  it('builds a swarm URI from an owner and a topic', () => {
    assert.equal(buildSwarmUri('aabbcc', 'group-1-720p'), 'swarm://aabbcc/group-1-720p');
  });
});

describe('withMaster', () => {
  const identity: LadderIdentity = {
    title: '10/08/2026',
    owner: 'abcd',
    group: 'group-1',
    mediatype: MEDIA_TYPE_VIDEO,
  };

  it('repoints the entry off the lowest rung and onto the master', () => {
    // Without this the catalog sends every viewer straight to the bottom rung's media playlist,
    // which plays perfectly and offers no other quality — the ladder exists and nothing can reach it.
    const entry = buildLadderEntry(identity, [], LADDER[0]);
    assert.equal(entry.topic, 'group-1-360p');

    assert.equal(withMaster(entry, { topic: 'group-1', index: 0 }).topic, 'group-1');
  });

  it('leaves a live entry without an index, as it was', () => {
    const live = buildLadderEntry(identity, [], LADDER[0]);

    assert.equal(withMaster(live, { topic: 'group-1', index: 7 }).index, undefined);
  });

  it('moves a finalized index onto the master feed, because it names an index in that feed', () => {
    // `index` is where a viewer finds the last playlist written. Repointing `topic` while leaving
    // `index` on the rung's feed would name an index that belongs to a different feed entirely —
    // usually a valid one, holding the wrong playlist.
    const finalized = buildLadderEntry(identity, [], { ...LADDER[0], index: 42, duration: 61 });
    assert.equal(finalized.state, 'vod');
    assert.equal(finalized.index, 42);

    assert.equal(withMaster(finalized, { topic: 'group-1', index: 9 }).index, 9);
  });

  it('changes nothing else, so the ladder stays describable without fetching the master', () => {
    const entry = buildLadderEntry(identity, [], LADDER[2]);
    const repointed = withMaster(entry, { topic: 'group-1', index: 3 });

    assert.deepEqual({ ...repointed, topic: entry.topic }, entry);
    assert.deepEqual(
      repointed.renditions?.map((r) => r.name),
      ['720p'],
    );
  });
});
