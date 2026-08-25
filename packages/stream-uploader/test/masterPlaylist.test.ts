import {
  buildMasterPlaylist as sharedBuildMasterPlaylist,
  buildSwarmUri as sharedBuildSwarmUri,
} from '@swarm-hls-stream/shared';
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

/**
 * The behaviour is asserted once, in `packages/shared/test/masterPlaylist.test.ts`, because there is
 * now one builder rather than two that promised to agree. What is left to check here is that this
 * package still reaches that one.
 *
 * Identity rather than a re-assertion of the output. Comparing the text again would pass just as well
 * against a fresh local copy, which is the arrangement this replaced: the client had a byte-identical
 * builder for catalog entries written before masters were published, and both copies carried a
 * comment saying a viewer meeting one and then the other must not see the ladder change shape.
 */
describe('buildMasterPlaylist', () => {
  it('is the shared builder, not a copy of it', () => {
    assert.equal(buildMasterPlaylist, sharedBuildMasterPlaylist);
    assert.equal(buildSwarmUri, sharedBuildSwarmUri);
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
