import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'vitest';

import type { Segment } from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { ManifestStateManager } from '../src/components/SwarmHlsPlayer/ManifestManagement';

const HEADERS = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1'];
const BYTES_URL = 'http://localhost:1633/bzz/';

/** A Swarm reference as the uploader writes one: 64 hex characters. */
function ref(index: number): string {
  return index.toString(16).padStart(64, '0');
}

function segmentsFrom(first: number, count: number, durationS: number): Segment[] {
  return Array.from({ length: count }, (_unused, offset) => ({
    extinf: `#EXTINF:${durationS.toFixed(6)},`,
    uri: ref(first + offset),
  }));
}

function segmentUris(manifest: string): string[] {
  return manifest.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * What a viewer's own copy of the playlist costs as a broadcast runs on.
 *
 * This side keeps every segment it has ever seen and hands hls.js the whole list on every poll,
 * which is deliberate: `normalizeHeaders` pins the playlist to media sequence zero so segment N
 * always means the Nth since this viewer joined, and dropping the front of the list is what hls.js
 * reports as a media sequence mismatch. Trimming is therefore not a free fix, and these assertions
 * exist so the growth stays a known cost rather than a surprise.
 *
 * The cost is a function of the segment COUNT, not of how long each segment is, so the segment
 * length a deployment picks sets how fast the count climbs. `docs/bench/manifest-growth-2026-08-12.md`
 * measures the wall-clock side of it, which does not belong in a test.
 */
describe('a live viewer accumulates the whole broadcast', () => {
  const TOPIC = 'growth-test';
  const manager = ManifestStateManager.getInstance();

  beforeEach(() => {
    manager.clear(TOPIC);
  });

  it('names every segment it has ever seen, however many polls that took', () => {
    const polls = 200;
    const perPoll = 25;

    for (let poll = 0; poll < polls; poll++) {
      manager.updateManifest(TOPIC, HEADERS, segmentsFrom(poll * perPoll, perPoll, 0.5), false);
    }

    assert.equal(segmentUris(manager.serialize(TOPIC, BYTES_URL)).length, polls * perPoll);
  });

  it('grows the bytes it serves in proportion to the segments it holds', () => {
    manager.updateManifest(TOPIC, HEADERS, segmentsFrom(0, 2_000, 0.5), false);
    const atTwoThousand = manager.serialize(TOPIC, BYTES_URL).length;

    manager.updateManifest(TOPIC, HEADERS, segmentsFrom(2_000, 2_000, 0.5), false);
    const atFourThousand = manager.serialize(TOPIC, BYTES_URL).length;

    const ratio = atFourThousand / atTwoThousand;
    assert.ok(
      ratio > 1.95 && ratio < 2.05,
      `doubling the segments should roughly double the manifest, got ${ratio.toFixed(3)}x ` +
        `(${atTwoThousand} -> ${atFourThousand} bytes)`,
    );
  });

  it('costs the same at every segment length, because the count is what it charges for', () => {
    manager.updateManifest(TOPIC, HEADERS, segmentsFrom(0, 1_000, 0.5), false);
    const atHalfSecond = manager.serialize(TOPIC, BYTES_URL).length;

    manager.clear(TOPIC);
    manager.updateManifest(TOPIC, HEADERS, segmentsFrom(0, 1_000, 1), false);
    const atOneSecond = manager.serialize(TOPIC, BYTES_URL).length;

    assert.equal(
      atHalfSecond,
      atOneSecond,
      'the same count at two segment lengths must serve the same bytes, so a deployment that ' +
        'halves the segment length pays by producing twice as many rather than by making each dearer',
    );
  });

  /**
   * The other half of the cost, and the reason the rebuild is not paid on every poll: a poll that
   * finds nothing new leaves the state clean and is served the cached string. A live viewer at the
   * edge sees a new segment on nearly every poll, so this path is the exception rather than the rule.
   */
  it('serves the cached string to a poll that found nothing new', () => {
    const segments = segmentsFrom(0, 1_000, 0.5);
    manager.updateManifest(TOPIC, HEADERS, segments, false);
    const built = manager.serialize(TOPIC, BYTES_URL);

    manager.updateManifest(TOPIC, HEADERS, segments, false);

    assert.equal(manager.serialize(TOPIC, BYTES_URL), built);
  });
});
