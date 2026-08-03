import { derivePublishKey, PUBLISH_KEY_PARAM } from '@swarm-hls-stream/shared/publishKey';
import { timingSafeEqual } from 'node:crypto';

/**
 * How a publish key presented by an engine is verified and extracted. See SEC-28.
 *
 * **Naming and derivation moved to `@swarm-hls-stream/shared/publishKey`.** The operator CLI and the
 * e2e publisher have to derive exactly the value this verifies, and a second implementation of that
 * one line does not fail loudly: it authenticates nobody, which looks from the outside like a
 * broadcaster typing their key wrong. Re-exported here rather than imported at every call site, so
 * the move stays invisible to the rest of the package. See ARCH-1.
 *
 * What stays here is what only the service does. The constant-time compare, and the two engines'
 * webhook shapes, neither of which the publisher side has any use for.
 */
export {
  assertUsablePublishKeySecret,
  derivePublishKey,
  MIN_PUBLISH_KEY_SECRET_LENGTH,
  PUBLISH_KEY_PARAM,
} from '@swarm-hls-stream/shared/publishKey';

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
