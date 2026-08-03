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
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(here, '..', 'scripts', '_lib.sh');

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

function derivePublishKey(secret, streamId) {
  const result = spawnSync(
    'bash',
    ['-c', `source ${JSON.stringify(LIB)} >/dev/null 2>&1; derive_publish_key "$1" "$2"`, 'bash', secret, streamId],
    { encoding: 'utf-8', timeout: DERIVE_TIMEOUT_MS },
  );
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
});
