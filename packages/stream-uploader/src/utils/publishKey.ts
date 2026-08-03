import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Query parameter carrying a stream's publish credential.
 *
 * A query parameter because it is the only channel both engines leave open, and both were measured
 * carrying it on 2026-08-03 rather than taken from their documentation:
 *
 * - OME (`airensoft/ovenmediaengine:latest`, SRT provider) puts the publish URL in the admission
 *   body's `request.url` **with its query intact**, on the `opening` and again on the `closing`.
 * - SRS (`ossrs/srs:6`) puts it in the `on_publish` body's `param`, **including the leading `?`**, and
 *   repeats it on `on_unpublish`.
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
 */
export function derivePublishKey(secret: string, streamId: string): string {
  return createHmac('sha256', secret).update(streamId, 'utf8').digest('hex').slice(0, PUBLISH_KEY_LENGTH);
}

/**
 * Whether `presented` is the key for `streamId`.
 *
 * Constant-time, because a comparison that returns on the first differing byte leaks how much of the
 * key the caller already has, and an attacker may retry an announce as often as they like.
 *
 * An empty secret refuses everything rather than disabling the check. That guard is load-bearing and
 * not defensive: two empty strings encode to two zero-length buffers, which `timingSafeEqual` reports
 * as equal, so without it an unset secret would make the empty key valid for every stream at once.
 * Whether the feature is on at all is the caller's question, decided once at construction. See SEC-3.
 */
export function hasValidPublishKey(secret: string, streamId: string, presented: string | null): boolean {
  if (!secret || !presented) {
    return false;
  }

  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(derivePublishKey(secret, streamId), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The key an OME admission carried, or null when it carried none.
 *
 * Null rather than a throw for an unparseable URL: this runs before `parseAppStream` has had the
 * chance to refuse anything, so the announce's verdict stays with the guard that is allowed to make
 * it, and "no key" is the honest reading of a URL that names nothing.
 */
export function publishKeyFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const direct = usableKey(parsed.searchParams.get(PUBLISH_KEY_PARAM));
    if (direct !== null) {
      return direct;
    }
    // The same fallback `parseAppStream` takes, and it has to be the same or the two disagree about
    // where a credential can live. OME takes an entire publish URL as an SRT `streamid`, which is the
    // form `publish-key.sh` prints, so a key inside it is a key this announce presented. Reading only
    // the outer query answered `null` for that shape, which is a refusal rather than a wrong allow,
    // but it is a refusal of the operator's own documented publish URL.
    const streamid = parsed.searchParams.get('streamid');
    return streamid === null ? null : usableKey(new URL(streamid).searchParams.get(PUBLISH_KEY_PARAM));
  } catch {
    return null;
  }
}

/** The key an SRS webhook carried in `param`, which arrives as `?key=...` and may be absent entirely. */
export function publishKeyFromParam(param: string | undefined): string | null {
  if (!param) {
    return null;
  }
  return usableKey(new URLSearchParams(param).get(PUBLISH_KEY_PARAM));
}

/**
 * An empty parameter is a key nobody presented, not a key that happens to be empty. It has to become
 * `null` here, because `''` is a value any caller can supply and the emptiness guard in
 * `hasValidPublishKey` is all that stands between it and a zero-length `timingSafeEqual`.
 */
function usableKey(value: string | null): string | null {
  return value ? value : null;
}
