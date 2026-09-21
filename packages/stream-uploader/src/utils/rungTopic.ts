import { createHash } from 'node:crypto';

/**
 * The namespace every rung topic in this project is derived under, minted once and never changed.
 *
 * ⛔ Changing it moves every rung of every ladder onto a different feed. A broadcast already running
 * would start writing somewhere nothing points at, and a recording already published would stay
 * addressable only through the recovery entries and catalog records that name the old value. It is a
 * constant rather than configuration for exactly that reason: there is no deployment for which a
 * different one is right.
 */
const RUNG_TOPIC_NAMESPACE = '6f9e1b2c-7d04-4a18-9f3e-2c5b8a6d4e10';

/** The sixteen bytes a hyphenated UUID spells, which is what a v5 name is hashed under. */
function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** The hyphenated form of sixteen bytes, lowercase, which is what the admin's `UUID_RE` accepts. */
function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The manifest feed topic a rung publishes on, derived from its ladder group and its rung name.
 *
 * ⛔⛔ **A rung's feed outlives its session, and that is the whole point of deriving it.** A topic
 * minted per session put a rung that restarted mid-broadcast — SRS bouncing a transcoder, an encoder
 * reconnecting — onto a feed the master no longer named until it re-announced, and made a finished
 * rung that came back indistinguishable from a crash-recovered one. Derived, the rung is on the same
 * feed it was on before, and a new session continues that feed above the previous session's head
 * rather than writing over it — see `StreamUploader.resumeFeedIndex`.
 *
 * ⛔ **Uniqueness per broadcast is the group's job, not this function's.** Standalone the group is a
 * fresh uuid per broadcast, so the derived topics are fresh with it; in admin mode the group is the
 * declared topic, which is stable for the life of the declaration, and so are these. Both are what
 * the deployment wants: each session's recording opens with the one already at that rung's feed
 * head, so the catalog entry names a recording of the whole broadcast with its seams marked.
 *
 * An RFC 4122 version-5 UUID, because the admin validates every topic it is handed against a UUID
 * shape (`UUID_RE`, `web2-admin/backend/src/schemas/stream.ts`) and because a name-based UUID is the
 * one standard way to spell "derived and stable" in that shape. Written out here rather than taken
 * from a dependency: node exports `randomUUID` and no v5, and a hash plus six bit operations is not
 * worth a package on the publish path.
 */
export function rungTopicFor(group: string, rung: string): string {
  const digest = createHash('sha1')
    .update(uuidBytes(RUNG_TOPIC_NAMESPACE))
    .update(Buffer.from(`${group}/${rung}`, 'utf-8'))
    .digest();

  const bytes = digest.subarray(0, 16);
  // RFC 4122 §4.3: the version in the high nibble of octet 6, and the variant in the top two bits of
  // octet 8. Without them the value is a truncated SHA-1 that happens to be 32 hex characters, and
  // anything reading it as a UUID would read the wrong version out of it.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return formatUuid(bytes);
}
