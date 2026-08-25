import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'vitest';

import { ManifestStateManager } from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { parseManifest } from '../src/components/SwarmHlsPlayer/playlist';

// Tags a fixture repeats get a name. Single-use header tags stay inline so each fixture still
// reads like the playlist it stands in for.
const M3U = '#EXTM3U';
const EXTINF_2S = '#EXTINF:2,';
const DISCONTINUITY = '#EXT-X-DISCONTINUITY';

describe('parseManifest discontinuity handling', () => {
  it('attaches the discontinuity flag to the segment following the tag', () => {
    const manifest = [
      M3U,
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '',
      EXTINF_2S,
      'seg0.ts',
      DISCONTINUITY,
      EXTINF_2S,
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
      M3U,
      DISCONTINUITY,
      EXTINF_2S,
      '#EXT-X-PLAYLIST-TYPE:EVENT', // orphaned: next line is a tag, not a URI
      EXTINF_2S,
      'segB.ts',
    ].join('\n');

    const { segments } = parseManifest(manifest);

    assert.equal(segments.length, 1);
    assert.equal(segments[0].uri, 'segB.ts');
    assert.equal(segments[0].discontinuity, false);
  });

  it('marks no discontinuity when the tag is absent', () => {
    const manifest = [M3U, EXTINF_2S, 'a.ts', EXTINF_2S, 'b.ts'].join('\n');

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
    const manifest = [M3U, EXTINF_2S, 'seg0.ts', DISCONTINUITY, EXTINF_2S, 'seg1.ts'].join('\n');
    const parsed = parseManifest(manifest);
    manager.updateManifest(TOPIC, parsed.headers, parsed.segments, parsed.isFinalized);

    const out = manager.serialize(TOPIC, '');

    assert.ok(
      out.includes(`${DISCONTINUITY}\n${EXTINF_2S}\nseg1.ts`),
      `expected discontinuity before seg1, got:\n${out}`,
    );
    assert.ok(!out.includes(`${DISCONTINUITY}\n${EXTINF_2S}\nseg0.ts`), 'seg0 must not carry a discontinuity');
  });

  it('serves a playable playlist when the first manifest a viewer ever sees is a finished one', () => {
    // How a recording is opened: nothing has been watched, so the feed head is the VOD manifest and
    // it arrives finalized on the first fetch. Every live path reaches `serialize` having taken a
    // manifest that was still open first, which is the only route that ever set the headers.
    const recording = [
      M3U,
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '',
      EXTINF_2S,
      'seg0.ts',
      EXTINF_2S,
      'seg1.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const parsed = parseManifest(recording);
    manager.updateManifest(TOPIC, parsed.headers, parsed.segments, parsed.isFinalized);

    const out = manager.serialize(TOPIC, '');

    // hls.js refuses a playlist whose first line is not this, with `Missing format identifier
    // #EXTM3U`, and reports it as a fatal error rather than as a bad playlist.
    assert.ok(out.startsWith(M3U), `a playlist must open with ${M3U}, got:\n${out}`);
    assert.ok(out.includes('#EXT-X-TARGETDURATION:2'), `the target duration must survive, got:\n${out}`);
    assert.ok(out.includes('seg0.ts') && out.includes('seg1.ts'), `both segments must be named, got:\n${out}`);
    assert.ok(out.includes('#EXT-X-ENDLIST'), `a finished playlist must be closed, got:\n${out}`);
  });

  it('preserves discontinuity flag when the same segment is reparsed without the tag (dedup across polls)', () => {
    // Poll 1: manifest with discontinuity on seg1
    const manifest1 = [M3U, EXTINF_2S, 'seg0.ts', DISCONTINUITY, EXTINF_2S, 'seg1.ts'].join('\n');
    const parsed1 = parseManifest(manifest1);
    manager.updateManifest(TOPIC, parsed1.headers, parsed1.segments, parsed1.isFinalized);

    const out1 = manager.serialize(TOPIC, '');
    assert.ok(out1.includes(`${DISCONTINUITY}\n${EXTINF_2S}\nseg1.ts`), 'Poll 1: expected discontinuity before seg1');

    // Poll 2: same segments but NO discontinuity tag in the manifest
    // (simulating the manifest being reparsed without the tag)
    const manifest2 = [M3U, EXTINF_2S, 'seg0.ts', EXTINF_2S, 'seg1.ts', EXTINF_2S, 'seg2.ts'].join('\n');
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
      out2.includes(`${DISCONTINUITY}\n${EXTINF_2S}\nseg1.ts`),
      'Poll 2: seg1 should STILL have discontinuity (dedup preserved the old flag)',
    );
  });
});

/**
 * That a manifest serialized for one gateway is not handed back for another.
 *
 * ⛔⛔⛔ FOUND BY A PAID SITTING, WHICH IS THE EXPENSIVE WAY TO FIND ANYTHING. On 2026-08-13 a
 * two-arm funded-versus-unfunded smoke ran green on every gate and the browser's own request log
 * showed **both arms fetching their video from the same node**: the feed and SOC lookups followed the
 * viewer's gateway and all 253 segment fetches did not. Had that reached the booked sitting, both
 * columns would have held one node, every metric would have agreed, and the report would have said
 * that funding makes no difference to a viewer.
 *
 * ⭐ `serialize` takes the gateway as an argument and then returns `cachedManifest` without looking
 * at it. `markAllDirty` exists for exactly this and is called by `setGatewayUrl`, so a viewer who
 * clicks the control is fine. A harness that seeds the gateway before the app runs never calls the
 * setter, and neither does anything else that changes the gateway without going through it.
 */
describe('a cached manifest belongs to the gateway it was built for', () => {
  const TOPIC = 'cache-vs-gateway';
  const FUNDED = 'http://127.0.0.1:10077/bytes';
  const UNFUNDED = 'http://127.0.0.1:10087/bytes';

  beforeEach(() => {
    ManifestStateManager.getInstance().clear(TOPIC);
  });

  it('serializes against the gateway it was asked for, not the one it was asked for first', () => {
    const state = ManifestStateManager.getInstance();
    state.updateManifest(TOPIC, [M3U], [{ extinf: EXTINF_2S, uri: 'abc123' }], false);

    const first = state.serialize(TOPIC, FUNDED);
    const second = state.serialize(TOPIC, UNFUNDED);

    assert.match(first, /10077/);
    assert.match(second, /10087/, `asked for the unfunded gateway and got back: ${second}`);
    assert.doesNotMatch(second, /10077/);
  });
});
