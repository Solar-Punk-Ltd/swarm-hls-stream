import { createHmac } from 'node:crypto';

/**
 * How a stream's publish credential is named and derived. See SEC-28.
 *
 * **Deliberately not re-exported from `index.ts`, and that is what the subpath export in
 * `package.json` is for.** `packages/client` is browser code and imports this package's barrel, so a
 * `node:crypto` import reachable through `export *` would be pulled into a bundle that has no such
 * module. Import it as `@swarm-hls-stream/shared/publishKey` from the two places that run on Node.
 *
 * The split against `stream-uploader`'s own `publishKey.ts` is by role rather than by convenience.
 * **Here: how a key is named and derived**, which the service, the operator CLI and the e2e publisher
 * all have to agree on, because a publisher that derives it differently is simply refused. **There:
 * how a presented key is verified and extracted**, which only the service does, and which needs the
 * constant-time compare and the two engines' webhook shapes.
 */

/**
 * Query parameter carrying a stream's publish credential.
 *
 * A query parameter because it is the only channel both engines leave open, and every spelling below
 * was measured against the pinned images rather than taken from documentation:
 *
 * - OME (`airensoft/ovenmediaengine:latest`, SRT) puts the publish URL in the admission body's
 *   `request.url` with its query intact, on the `opening` and again on the `closing`.
 * - SRS (`ossrs/srs:6`) over **RTMP** reports `param` **including the leading `?`**.
 * - SRS over **SRT** reports `param` **without** it, from a streamid of the form
 *   `#!::r=<app>/<stream>?key=<key>,m=publish`. Measured 2026-08-03.
 *
 * Both SRS spellings repeat `param` verbatim on `on_unpublish`, which is what lets the close path be
 * screened at all. See SEC-29.
 *
 * The name is short because a broadcaster types it into a publish URL by hand.
 */
export const PUBLISH_KEY_PARAM = 'key';

/** Matching the SRS webhook token and the API token: short enough to guess is short enough to guess. */
export const MIN_PUBLISH_KEY_SECRET_LENGTH = 32;

/**
 * Hex characters of the derived key, so 128 bits. Truncating an HMAC is sound and this is far past
 * brute force, while a full SHA-256 digest doubles the length of every publish URL an operator has to
 * hand out and read back over the phone.
 */
const PUBLISH_KEY_LENGTH = 32;

export function assertUsablePublishKeySecret(secret: string): void {
  if (secret.length < MIN_PUBLISH_KEY_SECRET_LENGTH) {
    throw new Error(`PUBLISH_KEY_SECRET must be at least ${MIN_PUBLISH_KEY_SECRET_LENGTH} characters`);
  }
}

/**
 * The key that proves the holder may publish `streamId`.
 *
 * Derived rather than stored, which is the whole reason this is a small module and not a subsystem.
 * There is no credential table to persist, no issuance endpoint to guard and no state to lose across a
 * restart, and rotation is one environment variable. The cost is that a single stream cannot be
 * revoked on its own: rotating the secret invalidates every key at once. That trade is worth naming
 * because it is the one an operator will hit, and the answer is to rotate and reissue.
 *
 * Keyed by the stream id and nothing else, so the key a broadcaster holds says nothing about any other
 * stream. One leaked key is one compromised broadcast.
 *
 * `deploy/scripts/_lib.sh` carries a fourth implementation of this line, in a `node -e` one-liner,
 * because a shell script cannot import a workspace package. `deploy/test/publishKey.test.js` pins it
 * against the same golden vector this package's tests use, which is the only thing keeping the two
 * from drifting.
 */
export function derivePublishKey(secret: string, streamId: string): string {
  return createHmac('sha256', secret).update(streamId, 'utf8').digest('hex').slice(0, PUBLISH_KEY_LENGTH);
}
