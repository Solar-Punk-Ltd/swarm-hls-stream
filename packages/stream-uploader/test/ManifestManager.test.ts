import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ManifestManager } from '../src/libs/ManifestManager.js';

const DISCONTINUITY_TAG = '#EXT-X-DISCONTINUITY';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('ManifestManager discontinuity handling', () => {
  it('emits a discontinuity tag before a flagged segment in the VOD manifest', () => {
    const manager = new ManifestManager('');
    manager.addSegment(0, 2, 'ref0');
    manager.addSegment(1, 2, 'ref1', true);
    manager.addSegment(2, 2, 'ref2');

    const manifest = manager.buildVODManifest();

    assert.ok(manifest.includes(`${DISCONTINUITY_TAG}\n#EXTINF:2,\nref1`));
    assert.equal(countOccurrences(manifest, DISCONTINUITY_TAG), 1);
    assert.ok(!manifest.includes(`${DISCONTINUITY_TAG}\n#EXTINF:2,\nref0`));
  });

  it('emits a discontinuity tag before a flagged segment in the live manifest', () => {
    const manager = new ManifestManager('');
    manager.addSegment(0, 2, 'ref0');
    manager.addSegment(1, 2, 'ref1', true);

    const manifest = manager.buildLiveManifest();

    assert.ok(manifest.includes(`${DISCONTINUITY_TAG}\n#EXTINF:2,\nref1`));
    assert.equal(countOccurrences(manifest, DISCONTINUITY_TAG), 1);
  });

  it('does not emit a discontinuity tag when no segment is flagged', () => {
    const manager = new ManifestManager('');
    manager.addSegment(0, 2, 'ref0');
    manager.addSegment(1, 2, 'ref1');

    assert.equal(countOccurrences(manager.buildVODManifest(), DISCONTINUITY_TAG), 0);
    assert.equal(countOccurrences(manager.buildLiveManifest(), DISCONTINUITY_TAG), 0);
  });
});
