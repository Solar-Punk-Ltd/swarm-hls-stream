/**
 * That the key an operator issues is the key the service will accept. See SEC-28.
 *
 * There are two implementations of one derivation: `derive_publish_key` in `_lib.sh`, because the
 * secret lives in this host's env file and the host is not required to have Node, and
 * `derivePublishKey` in `packages/stream-uploader/src/utils/publishKey.ts`, because the service has to
 * recompute it to compare. If they disagree, every key an operator hands out is refused, and the
 * failure looks exactly like a broadcaster who typed it wrong.
 *
 * Pinned by a golden vector rather than by having one call the other, which they cannot: they run in
 * different languages on different machines. The same triple is asserted in `publishKey.test.ts`, so
 * either side drifting fails a test on that side.
 *
 * The function is called out of `_lib.sh` rather than reimplemented here, because a test carrying its
 * own copy of the pipeline asserts against itself.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(here, '..', 'scripts', '_lib.sh');
const SCRIPT = path.join(here, '..', 'scripts', 'publish-key.sh');

/** A ceiling on a hung `openssl`, so a broken tool fails the run instead of holding it open. */
const DERIVE_TIMEOUT_MS = 10_000;

const SECRET = 'publish-key-secret-0123456789abcdef';

/**
 * The golden vector, and the whole point of this file. Computed once from `derivePublishKey` in the
 * stream-uploader, on 2026-08-03, and asserted verbatim on both sides ever since.
 */
const GOLDEN = [
  { streamId: 'video/demo', key: '2d1e344ecb833667c936399866349fbc' },
  { streamId: 'audio/podcast', key: '0901de836aef81a3dfce00aed78a01ff' },
];

/**
 * The secret goes through the environment, never through argv, which is the contract
 * `derive_publish_key` exists to keep. Passing it as an argument here would test a different
 * function from the one that ships.
 */
function runDerive(secret, streamId) {
  return spawnSync(
    'bash',
    ['-c', `source ${JSON.stringify(LIB)} >/dev/null 2>&1; derive_publish_key "$1"`, 'bash', streamId],
    {
      encoding: 'utf-8',
      timeout: DERIVE_TIMEOUT_MS,
      env: { ...process.env, PUBLISH_KEY_SECRET: secret },
    },
  );
}

function derivePublishKey(secret, streamId) {
  const result = runDerive(secret, streamId);
  assert.equal(result.error, undefined, `deriving the key failed to run: ${result.error?.message}`);
  assert.equal(result.status, 0, `deriving the key exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim();
}

describe('the publish key an operator issues', () => {
  for (const { streamId, key } of GOLDEN) {
    it(`derives the agreed key for ${streamId}`, () => {
      assert.equal(derivePublishKey(SECRET, streamId), key);
    });
  }

  /**
   * The per-stream property, asserted on this side too. It is what makes a key safe to hand to one
   * broadcaster, so a change that made the derivation ignore the stream id would be a silent
   * downgrade to a single deployment-wide password.
   */
  it('derives a different key for every stream', () => {
    assert.notEqual(derivePublishKey(SECRET, 'video/demo'), derivePublishKey(SECRET, 'video/other'));
  });

  it('derives a different key under a rotated secret', () => {
    assert.notEqual(derivePublishKey(SECRET, 'video/demo'), derivePublishKey(`${SECRET}-rotated`, 'video/demo'));
  });

  /** 128 bits of hex, matching `PUBLISH_KEY_LENGTH`, and nothing a URL would reshape on the way. */
  it('derives a key that survives a URL unescaped', () => {
    const key = derivePublishKey(SECRET, 'video/demo');

    assert.equal(key.length, 32);
    assert.match(key, /^[a-f0-9]{32}$/);
  });

  /**
   * The openssl form this replaced was a four-stage pipeline, so its exit status was `cut`'s and
   * never the digest's. A failing derivation printed nothing and reported success, and the caller
   * then handed the operator a publish URL ending `?key=` that no broadcaster could ever use.
   */
  it('reports a failure as a failure rather than as an empty key', () => {
    const result = runDerive('', 'video/demo');

    assert.notEqual(result.status, 0, 'an unusable secret must not exit zero');
    assert.equal(result.stdout.trim(), '', 'and must not print a key');
    assert.match(result.stderr, /at least 32 characters/);
  });

  /**
   * The length rule has to be counted in the units the service counts. `${#var}` in bash is bytes
   * under `LC_ALL=C` and characters under a UTF-8 locale, and `String.length` is neither: it is
   * UTF-16 code units. Eleven of these is 44 bytes, 11 characters and 22 code units, so the old
   * check accepted a secret that `assertUsablePublishKeySecret` then threw on at startup, taking
   * the whole deployment down over a secret the operator's own tool had just approved.
   */
  it('counts the secret length the way the service counts it', () => {
    const result = runDerive('\u{1F511}'.repeat(11), 'video/demo');

    assert.notEqual(result.status, 0, '22 UTF-16 code units is under the minimum, whatever bash would say');
  });

  /**
   * The reason this is node rather than `openssl dgst -hmac "$secret"`: openssl takes an HMAC key
   * only from its command line, and a command line is world-readable. One master secret is every
   * stream's key forever, so a momentary exposure is a permanent compromise.
   */
  it('never puts the secret on a command line', () => {
    const lib = fs.readFileSync(LIB, 'utf-8');
    const body = lib.slice(lib.indexOf('derive_publish_key() {'));
    const fn = body.slice(0, body.indexOf('\n}'));

    assert.doesNotMatch(fn, /-hmac\s+"?\$/, 'the secret must not be interpolated into an argument');
    assert.match(fn, /PUBLISH_KEY_SECRET=/, 'it has to travel in the environment');
  });
});

/**
 * The script an operator actually runs, as opposed to the function under it.
 *
 * The golden vector pins `derive_publish_key`, which is real coverage, but every string the
 * broadcaster copies is emitted here and none of it was executed by any test. The parameter name is
 * the sharpest case: renaming it to `?wrongname=` left the whole suite green while every publish it
 * produced would be refused. That is the same drift the repo already guards for the other credential,
 * where `srsWebhookAuth.test.ts` reads `srs.conf.template` and asserts the parameter name against
 * `SRS_WEBHOOK_TOKEN_PARAM` rather than against a literal.
 */
describe('the publish URLs publish-key.sh hands an operator', () => {
  const GOLDEN_KEY = GOLDEN[0].key;

  function runScript(env, ...args) {
    return spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf-8',
      timeout: DERIVE_TIMEOUT_MS,
      env: { ...process.env, ...env },
    });
  }

  it('prints both publish URLs carrying the key under the name the service reads', () => {
    const result = runScript({ PUBLISH_KEY_SECRET: SECRET }, 'video/demo');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`rtmp://[^\\s]*/video/demo\\?key=${GOLDEN_KEY}`));
    // OME's is percent-encoded, because the key sits inside a value that is itself inside a query.
    assert.match(result.stdout, new RegExp(`streamid=srt%3A%2F%2F[^\\s]*%2Fvideo%2Fdemo%3Fkey%3D${GOLDEN_KEY}`));
  });

  it('refuses to print anything when no secret is configured', () => {
    const result = runScript({ PUBLISH_KEY_SECRET: '' }, 'video/demo');

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.includes(GOLDEN_KEY), false, 'a key must not be printed when there is no secret');
    assert.match(result.stderr, /PUBLISH_KEY_SECRET is not set/);
  });

  it('refuses a secret the service would reject at startup', () => {
    const result = runScript({ PUBLISH_KEY_SECRET: 'too-short' }, 'video/demo');

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /at least 32 characters/);
  });

  it('refuses a stream id that is not one app and one stream', () => {
    for (const bad of ['notaslash', 'a/b/c', '']) {
      const result = runScript({ PUBLISH_KEY_SECRET: SECRET }, bad);

      assert.notEqual(result.status, 0, `"${bad}" must be refused`);
    }
  });
});
