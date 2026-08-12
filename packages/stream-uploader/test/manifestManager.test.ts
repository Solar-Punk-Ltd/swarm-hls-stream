import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ManifestManager } from '../src/libs/ManifestManager.js';

/** The engine's own sequence number for a segment, which is what `addSegment` is handed. */
function feed(manager: ManifestManager, from: number, count: number, duration = 1.5): void {
  for (let i = 0; i < count; i++) {
    manager.addSegment(from + i, duration, `ref-${from + i}`);
  }
}

function mediaSequenceOf(manifest: string): number {
  const line = manifest.split('\n').find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
  assert.ok(line, 'manifest must carry an EXT-X-MEDIA-SEQUENCE');
  return Number.parseInt(line!.split(':')[1], 10);
}

function segmentUris(manifest: string): string[] {
  return manifest
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.trim());
}

describe('ManifestManager media sequence', () => {
  it('reports the engine sequence number of the playlist’s first segment', () => {
    const manager = new ManifestManager('');
    feed(manager, 0, 3);

    assert.equal(mediaSequenceOf(manager.buildLiveManifest()), 0);
  });

  it('advances with the sliding window rather than counting from zero', () => {
    // The live window holds ten segments. Once it starts sliding, EXT-X-MEDIA-SEQUENCE has to track
    // the segment that is actually first in the playlist — RFC 8216 6.2.2 — or a player reloading
    // the playlist cannot tell what was evicted from what is new.
    const manager = new ManifestManager('');
    feed(manager, 0, 14);

    const manifest = manager.buildLiveManifest();

    assert.equal(mediaSequenceOf(manifest), 4);
    assert.deepEqual(segmentUris(manifest)[0], 'ref-4');
    assert.equal(segmentUris(manifest).length, 10);
  });

  it('does not renumber a rung whose uploader joined the stream late', () => {
    // The defect this exists to prevent. Every rung of a ladder is transcoded from one source with
    // keyframes forced to the same media timestamps, so segment N means the same interval on all of
    // them — and with no EXT-X-PROGRAM-DATE-TIME in these playlists, the sequence number is the
    // only thing telling hls.js that two levels share a timeline.
    //
    // A count of segments this uploader had seen would make both of these start at 0, claiming the
    // 1080p rung's first segment covers the same instant as the 360p rung's when it is two segments
    // (3 seconds) later. Every switch would then land that far off.
    const early = new ManifestManager('');
    const late = new ManifestManager('');

    feed(early, 0, 5);
    feed(late, 2, 3);

    assert.equal(mediaSequenceOf(early.buildLiveManifest()), 0);
    assert.equal(mediaSequenceOf(late.buildLiveManifest()), 2);
  });

  it('uses the first segment it holds even when segments arrive out of order', () => {
    const manager = new ManifestManager('');
    manager.addSegment(7, 1.5, 'ref-7');
    manager.addSegment(5, 1.5, 'ref-5');
    manager.addSegment(6, 1.5, 'ref-6');

    const manifest = manager.buildLiveManifest();

    assert.equal(mediaSequenceOf(manifest), 5);
    assert.deepEqual(segmentUris(manifest), ['ref-5', 'ref-6', 'ref-7']);
  });

  it('carries the same numbering into the finalized VOD playlist', () => {
    const manager = new ManifestManager('');
    feed(manager, 3, 4);

    const vod = manager.buildVODManifest();

    assert.equal(mediaSequenceOf(vod), 3);
    assert.match(vod, /#EXT-X-PLAYLIST-TYPE:VOD/);
    assert.match(vod, /#EXT-X-ENDLIST/);
    assert.equal(segmentUris(vod).length, 4, 'VOD keeps every segment, not just the live window');
  });

  it('survives a restore, which is where the sequence numbers come back from disk', () => {
    const manager = new ManifestManager('');
    manager.restoreState(
      [
        { index: 11, duration: 1.5, ref: 'ref-11' },
        { index: 12, duration: 1.5, ref: 'ref-12' },
      ],
      ['#EXTM3U', '#EXT-X-VERSION:3'],
    );

    assert.equal(mediaSequenceOf(manager.buildLiveManifest()), 11);
  });

  it('prefixes segment URIs with the manifest gateway when one is configured', () => {
    const manager = new ManifestManager('http://bee/bytes');
    feed(manager, 0, 1);

    assert.deepEqual(segmentUris(manager.buildLiveManifest()), ['http://bee/bytes/ref-0']);
  });

  it('returns nothing at all before the first segment, rather than a headers-only playlist', () => {
    const manager = new ManifestManager('');

    assert.equal(manager.buildLiveManifest(), '');
    assert.equal(manager.buildVODManifest(), '');
  });
});
