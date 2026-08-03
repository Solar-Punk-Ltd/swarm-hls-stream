import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertUsablePublishKeySecret,
  derivePublishKey,
  hasValidPublishKey,
  MIN_PUBLISH_KEY_SECRET_LENGTH,
  publishKeyFromParam,
  publishKeyFromUrl,
} from '../src/utils/publishKey.js';

const SECRET = 'x'.repeat(MIN_PUBLISH_KEY_SECRET_LENGTH);
const OTHER_SECRET = 'y'.repeat(MIN_PUBLISH_KEY_SECRET_LENGTH);

/**
 * One admission body and one webhook body, captured on 2026-08-03 from `airensoft/ovenmediaengine:latest`
 * and `ossrs/srs:6`, the two images this deployment pins, each publishing over the provider it actually
 * uses. They are here because the whole feature rests on the credential surviving the engine, and
 * neither engine documents that it does.
 *
 * OME carried the query verbatim in `request.url` on both the `opening` and the `closing`. SRS carried
 * it in `param` on both `on_publish` and `on_unpublish`, **with the leading `?` included**, which is the
 * detail an extractor written from the docs would get wrong.
 */
const MEASURED_OME_URL = 'srt://localhost:10080/video/demo?key=SECRET123abc';
const MEASURED_SRS_PARAM = '?key=SECRET123abc';

/**
 * The golden vector, shared with `deploy/test/publishKey.test.js`.
 *
 * `derive_publish_key` in `deploy/scripts/_lib.sh` is a second implementation of this derivation,
 * because the operator issuing a key runs on a host that is not required to have Node while the
 * service verifying it runs here. They cannot call each other, so they are pinned to one triple
 * instead, and either side drifting fails a test on that side. If they ever disagreed, every key an
 * operator handed out would be refused and it would look exactly like a broadcaster's typo.
 */
const GOLDEN_SECRET = 'publish-key-secret-0123456789abcdef';
const GOLDEN = [
  { streamId: 'video/demo', key: '2d1e344ecb833667c936399866349fbc' },
  { streamId: 'audio/podcast', key: '0901de836aef81a3dfce00aed78a01ff' },
];

describe('deriving a stream publish key', () => {
  for (const { streamId, key } of GOLDEN) {
    it(`derives the agreed key for ${streamId}, which the deploy script has to match`, () => {
      assert.equal(derivePublishKey(GOLDEN_SECRET, streamId), key);
    });
  }

  it('gives the same key every time for one stream', () => {
    assert.equal(derivePublishKey(SECRET, 'video/demo'), derivePublishKey(SECRET, 'video/demo'));
  });

  /**
   * The property the whole feature is built on. A broadcaster is handed the key for their own stream
   * and it proves nothing about any other, so one leaked key is one compromised broadcast rather than
   * the run of the deployment.
   */
  it('gives a different key for every stream', () => {
    assert.notEqual(derivePublishKey(SECRET, 'video/demo'), derivePublishKey(SECRET, 'video/other'));
    assert.notEqual(derivePublishKey(SECRET, 'video/demo'), derivePublishKey(SECRET, 'audio/demo'));
  });

  /** Rotation, since there is no store to revoke from: a new secret invalidates every key at once. */
  it('gives a different key under a different secret', () => {
    assert.notEqual(derivePublishKey(SECRET, 'video/demo'), derivePublishKey(OTHER_SECRET, 'video/demo'));
  });

  /**
   * The key travels in a publish URL through two engines and back out through a webhook, so a
   * character that changes shape on the way is a key that never matches. Same reasoning as
   * `URL_SAFE_TOKEN` in `webhookToken.ts`, except here the value is generated rather than configured,
   * so this is an assertion about the generator rather than a check on an operator.
   */
  it('gives a key that survives a URL unescaped', () => {
    const key = derivePublishKey(SECRET, 'video/demo');

    assert.match(key, /^[a-f0-9]+$/);
    assert.equal(encodeURIComponent(key), key);
  });

  it('gives a key with at least 128 bits in it', () => {
    assert.ok(derivePublishKey(SECRET, 'video/demo').length >= 32);
  });
});

describe('verifying a presented publish key', () => {
  it('accepts the key derived for that stream', () => {
    assert.equal(hasValidPublishKey(SECRET, 'video/demo', derivePublishKey(SECRET, 'video/demo')), true);
  });

  /**
   * The attack SEC-28 exists to stop, and the one SEC-26's address test could not: a publisher who
   * legitimately holds one stream presenting that credential against someone else's.
   */
  it('refuses a key that is valid, but for another stream', () => {
    assert.equal(hasValidPublishKey(SECRET, 'video/demo', derivePublishKey(SECRET, 'video/other')), false);
  });

  it('refuses a key derived from a retired secret', () => {
    assert.equal(hasValidPublishKey(SECRET, 'video/demo', derivePublishKey(OTHER_SECRET, 'video/demo')), false);
  });

  it('refuses a missing key', () => {
    assert.equal(hasValidPublishKey(SECRET, 'video/demo', null), false);
  });

  it('refuses a prefix of the real key', () => {
    const key = derivePublishKey(SECRET, 'video/demo');

    assert.equal(hasValidPublishKey(SECRET, 'video/demo', key.slice(0, -1)), false);
  });

  /**
   * The SEC-3 lesson, load-bearing rather than defensive. Two empty strings encode to two zero-length
   * buffers and `timingSafeEqual` reports those as equal, so without this an unset secret would not
   * disable the check, it would make the empty key the valid one for every stream at once.
   */
  it('refuses everything when the secret is empty, rather than accepting an empty key', () => {
    assert.equal(hasValidPublishKey('', 'video/demo', ''), false);
    assert.equal(hasValidPublishKey('', 'video/demo', null), false);
    assert.equal(hasValidPublishKey('', 'video/demo', derivePublishKey('', 'video/demo')), false);
  });
});

describe('reading the publish key out of what each engine sends', () => {
  it('reads it from the OME admission url, as OME actually sends it', () => {
    assert.equal(publishKeyFromUrl(MEASURED_OME_URL), 'SECRET123abc');
  });

  it('reads it from the SRS param, leading question mark and all', () => {
    assert.equal(publishKeyFromParam(MEASURED_SRS_PARAM), 'SECRET123abc');
  });

  it('reads it from an SRS param that arrives without the leading question mark', () => {
    assert.equal(publishKeyFromParam('key=SECRET123abc'), 'SECRET123abc');
  });

  it('finds nothing in an announce that carried no key', () => {
    assert.equal(publishKeyFromUrl('srt://localhost:10080/video/demo'), null);
    assert.equal(publishKeyFromParam(''), null);
    assert.equal(publishKeyFromParam(undefined), null);
  });

  /**
   * An empty parameter is a key nobody presented, not a key that happens to be empty. It has to reach
   * the verifier as `null`, because `''` is a value any caller can supply and the emptiness guard
   * there is the only thing standing between it and a zero-length `timingSafeEqual`.
   */
  it('reads an empty key parameter as no key at all', () => {
    assert.equal(publishKeyFromUrl('srt://localhost:10080/video/demo?key='), null);
    assert.equal(publishKeyFromParam('?key='), null);
  });

  /**
   * The extractor runs before `parseAppStream` has had a chance to refuse anything, so it sees whatever
   * the engine sent. Returning null rather than throwing keeps the announce's verdict with the guard
   * that is allowed to make it.
   */
  it('finds nothing in a url that does not parse', () => {
    assert.equal(publishKeyFromUrl('not a url at all'), null);
  });

  it('takes the first spelling when a url repeats the parameter', () => {
    assert.equal(publishKeyFromUrl('srt://h/video/demo?key=first&key=second'), 'first');
  });
});

describe('screening the configured secret', () => {
  it('accepts a secret at the minimum length', () => {
    assertUsablePublishKeySecret('a'.repeat(MIN_PUBLISH_KEY_SECRET_LENGTH));
  });

  it('refuses a secret short enough to guess', () => {
    assert.throws(
      () => assertUsablePublishKeySecret('a'.repeat(MIN_PUBLISH_KEY_SECRET_LENGTH - 1)),
      new RegExp(`${MIN_PUBLISH_KEY_SECRET_LENGTH}`),
    );
  });
});
