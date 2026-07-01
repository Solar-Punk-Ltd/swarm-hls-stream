import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'vitest';

import { ManifestStateManager, parseManifest } from '../src/components/SwarmHlsPlayer/ManifestManagement';

const DISCONTINUITY = '#EXT-X-DISCONTINUITY';

describe('parseManifest discontinuity handling', () => {
  it('attaches the discontinuity flag to the segment following the tag', () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '',
      '#EXTINF:2,',
      'seg0.ts',
      DISCONTINUITY,
      '#EXTINF:2,',
      'seg1.ts',
    ].join('\n');

    const { segments } = parseManifest(manifest);

    assert.equal(segments.length, 2);
    assert.equal(segments[0].uri, 'seg0.ts');
    assert.equal(segments[0].discontinuity, false);
    assert.equal(segments[1].uri, 'seg1.ts');
    assert.equal(segments[1].discontinuity, true);
  });

  it('does not leak the flag past a malformed/orphaned EXTINF', () => {
    const manifest = [
      '#EXTM3U',
      DISCONTINUITY,
      '#EXTINF:2,',
      '#EXT-X-PLAYLIST-TYPE:EVENT', // orphaned: next line is a tag, not a URI
      '#EXTINF:2,',
      'segB.ts',
    ].join('\n');

    const { segments } = parseManifest(manifest);

    assert.equal(segments.length, 1);
    assert.equal(segments[0].uri, 'segB.ts');
    assert.equal(segments[0].discontinuity, false);
  });

  it('marks no discontinuity when the tag is absent', () => {
    const manifest = ['#EXTM3U', '#EXTINF:2,', 'a.ts', '#EXTINF:2,', 'b.ts'].join('\n');

    const { segments } = parseManifest(manifest);

    assert.equal(segments.length, 2);
    assert.equal(
      segments.every((s) => !s.discontinuity),
      true,
    );
  });
});

describe('ManifestStateManager serialize', () => {
  const TOPIC = 'topic-test';
  const manager = ManifestStateManager.getInstance();

  beforeEach(() => {
    manager.clear(TOPIC);
  });

  it('re-emits #EXT-X-DISCONTINUITY before a flagged segment (parse -> state -> serialize)', () => {
    const manifest = ['#EXTM3U', '#EXTINF:2,', 'seg0.ts', DISCONTINUITY, '#EXTINF:2,', 'seg1.ts'].join('\n');
    const parsed = parseManifest(manifest);
    manager.updateManifest(TOPIC, parsed.headers, parsed.segments, parsed.isFinalized);

    const out = manager.serialize(TOPIC, '');

    assert.ok(
      out.includes(`${DISCONTINUITY}\n#EXTINF:2,\nseg1.ts`),
      `expected discontinuity before seg1, got:\n${out}`,
    );
    assert.ok(!out.includes(`${DISCONTINUITY}\n#EXTINF:2,\nseg0.ts`), 'seg0 must not carry a discontinuity');
  });

  it('preserves discontinuity flag when the same segment is reparsed without the tag (dedup across polls)', () => {
    // Poll 1: manifest with discontinuity on seg1
    const manifest1 = ['#EXTM3U', '#EXTINF:2,', 'seg0.ts', DISCONTINUITY, '#EXTINF:2,', 'seg1.ts'].join('\n');
    const parsed1 = parseManifest(manifest1);
    manager.updateManifest(TOPIC, parsed1.headers, parsed1.segments, parsed1.isFinalized);

    const out1 = manager.serialize(TOPIC, '');
    assert.ok(
      out1.includes(`${DISCONTINUITY}\n#EXTINF:2,\nseg1.ts`),
      'Poll 1: expected discontinuity before seg1',
    );

    // Poll 2: same segments but NO discontinuity tag in the manifest
    // (simulating the manifest being reparsed without the tag)
    const manifest2 = ['#EXTM3U', '#EXTINF:2,', 'seg0.ts', '#EXTINF:2,', 'seg1.ts', '#EXTINF:2,', 'seg2.ts'].join('\n');
    const parsed2 = parseManifest(manifest2);
    // Parsed2 should have seg0/seg1/seg2, all without discontinuity flag (because the tag is not in the manifest)
    assert.equal(parsed2.segments[1].uri, 'seg1.ts');
    assert.equal(parsed2.segments[1].discontinuity, false, 'newly parsed seg1 should not have discontinuity flag');

    manager.updateManifest(TOPIC, parsed2.headers, parsed2.segments, parsed2.isFinalized);

    const out2 = manager.serialize(TOPIC, '');
    // CRITICAL: Does seg1 still have the discontinuity flag?
    // The dedup logic should have ignored seg0 and seg1 (already in state), and only added seg2.
    // This means state.segments[1] (the original seg1 with discontinuity=true) is UNCHANGED.
    assert.ok(
      out2.includes(`${DISCONTINUITY}\n#EXTINF:2,\nseg1.ts`),
      'Poll 2: seg1 should STILL have discontinuity (dedup preserved the old flag)',
    );
  });
});
