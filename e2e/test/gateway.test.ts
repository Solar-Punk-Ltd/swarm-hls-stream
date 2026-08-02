import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { segmentRefFromUri } from '../src/bench/gateway.js';

/**
 * The uploader writes absolute segment URIs built from its own bee url, so a manifest entry looks
 * like `http://10.0.0.4:1633/bytes/<ref>`. The bench, like the client, keeps only the reference and
 * re-hosts it against the gateway a viewer is actually configured with. Taking the whole URI instead
 * would send every fetch to the uploader's private bee, which measures a path no viewer takes and on
 * most deployments is not reachable from here at all.
 */
describe('taking the reference out of a manifest entry', () => {
  const ref = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

  it('reads an absolute uri as the uploader writes it', () => {
    assert.equal(segmentRefFromUri(`http://10.0.0.4:1633/bytes/${ref}`), ref);
  });

  it('reads a bare reference, which is what an uploader with no bee url configured emits', () => {
    assert.equal(segmentRefFromUri(ref), ref);
  });

  it('ignores a query string rather than folding it into the reference', () => {
    assert.equal(segmentRefFromUri(`http://host:1633/bytes/${ref}?redundancy=1`), ref);
  });

  it('ignores a trailing slash rather than reading the reference as empty', () => {
    assert.equal(segmentRefFromUri(`http://host:1633/bytes/${ref}/`), ref);
  });

  it('reads an encrypted reference, which is twice as long', () => {
    assert.equal(segmentRefFromUri(`http://host:1633/bytes/${ref}${ref}`), `${ref}${ref}`);
  });

  /**
   * The shape has to be checked, not just the position. Taking the last path element of a URI with
   * no path yields the host and port, which would then be fetched as `/bytes/host:1633` and 404 —
   * a failure an operator would spend the run blaming the gateway for.
   */
  it('reports nothing for a uri with no path at all, rather than the host and port', () => {
    assert.equal(segmentRefFromUri('http://host:1633/'), null);
  });

  it('reports nothing for an entry that is not a reference', () => {
    assert.equal(segmentRefFromUri('http://host:1633/bytes/not-a-reference'), null);
  });

  it('reports nothing for a reference of the wrong width', () => {
    assert.equal(segmentRefFromUri(`http://host:1633/bytes/${ref.slice(0, 32)}`), null);
  });

  it('reports nothing for an empty entry', () => {
    assert.equal(segmentRefFromUri(''), null);
  });
});
