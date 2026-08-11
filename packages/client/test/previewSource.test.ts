/**
 * A preview card used to spin forever whenever its manifest produced no segments, which included the
 * case where the gateway had answered 404: `res.ok` was never read, the 404 body went into
 * `parseManifest`, and the empty result it returned took an early return that was the one exit not
 * clearing the loading flag. Failure and "still working on it" were the same pixels, permanently.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { previewSourceFrom } from '../src/components/StreamPreview/previewSource';

const OK = { ok: true, status: 200 };

describe('what a preview card should do with the manifest it fetched', () => {
  it('plays the first segment when the manifest lists one', () => {
    const source = previewSourceFrom(OK, [
      { extinf: '#EXTINF:2.0,', uri: 'seg0.ts' },
      { extinf: '#EXTINF:2.0,', uri: 'seg1.ts' },
    ]);

    assert.equal(source.kind === 'playable' ? source.firstSegment.uri : null, 'seg0.ts');
  });

  it('reports a manifest that lists no segments as unavailable rather than pending', () => {
    const source = previewSourceFrom(OK, []);

    assert.equal(source.kind, 'unavailable', 'an empty playlist left the card loading for good');
  });

  // The two cases below are one value by the time the parser has finished with them: a 404 page and an
  // empty playlist both parse to `segments: []`. Keeping them apart is the whole point of reading `ok`.
  it('reports a gateway that refused the manifest as unavailable, and names the status', () => {
    const source = previewSourceFrom({ ok: false, status: 404 }, []);

    assert.equal(source.kind, 'unavailable');
    assert.match(
      source.kind === 'unavailable' ? source.reason : '',
      /404/,
      'the reason must name the refusal, not describe an empty broadcast',
    );
  });

  it('does not call a refusal empty even when the error body happens to parse into segments', () => {
    const source = previewSourceFrom({ ok: false, status: 500 }, [{ extinf: '#EXTINF:2.0,', uri: 'seg0.ts' }]);

    assert.equal(source.kind, 'unavailable', 'a 500 body is not a playlist however well it parses');
  });
});
