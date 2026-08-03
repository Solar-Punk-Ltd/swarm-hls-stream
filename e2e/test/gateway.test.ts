import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GatewayStatusError, isFeedPendingFirstWrite, segmentRefFromUri } from '../src/bench/gateway.js';

/**
 * The one status that means "not yet" rather than "wrong".
 *
 * A Swarm feed answers 404 until its first update is written, and the uploader writes that only after
 * the first segment has closed and uploaded. The bench starts polling the moment the publisher is up,
 * so the very first read of a run can land in that window: on 2026-08-03 four of five 1080p runs at a
 * one-second GOP died there, on four different topics, with the deployment healthy throughout.
 */
describe('telling a feed that has not been written yet from one that broke', () => {
  it('waits out a 404 the first time, because a feed with no updates has nothing to serve', () => {
    assert.equal(isFeedPendingFirstWrite(new GatewayStatusError('http://gw/feeds/o/t', 404), false), true);
  });

  /**
   * The half that keeps the tolerance narrow. Polling through every 404 would turn a feed that
   * vanished mid-run into a run that quietly collected fewer samples than it was asked for.
   */
  it('fails on a 404 once the feed has answered, since that is a disappearance', () => {
    assert.equal(isFeedPendingFirstWrite(new GatewayStatusError('http://gw/feeds/o/t', 404), true), false);
  });

  it('fails on any other status, waited for or not', () => {
    assert.equal(isFeedPendingFirstWrite(new GatewayStatusError('http://gw/feeds/o/t', 500), false), false);
    assert.equal(isFeedPendingFirstWrite(new GatewayStatusError('http://gw/feeds/o/t', 403), false), false);
  });

  /** A timeout and a refused connection arrive as plain errors, and neither is a feed saying "not yet". */
  it('fails on an error that carries no status at all', () => {
    assert.equal(isFeedPendingFirstWrite(new Error('The operation was aborted due to timeout'), false), false);
  });
});

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
