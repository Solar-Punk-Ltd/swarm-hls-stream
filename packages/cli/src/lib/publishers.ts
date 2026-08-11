/**
 * BEE_PUBLISHERS, as the CLI needs it.
 *
 * The authoritative parser lives in the stream-uploader
 * (`libs/BeePublisherPool.ts`, `parsePublisherSpecs`) and is strict: a malformed entry refuses to
 * start, because publishing a rung to the wrong node and the wrong postage batch is worse than not
 * publishing at all. This one is deliberately forgiving. It exists to reach nodes for funding and
 * diagnosis, and refusing to show you three healthy nodes because the fourth entry has a typo is the
 * opposite of useful — so an unreadable entry is skipped and the rest are returned.
 *
 * URLs are taken as written. In a Docker deployment the host's `.env` holds host-reachable URLs
 * while compose overrides the uploader container's copy with compose service names, which is the
 * same split `BEE_URL` already has.
 */

/** One node named in BEE_PUBLISHERS. */
export interface PublisherSpec {
  rung: string;
  url: string;
  stamp: string;
}

export function parsePublishers(spec: string | undefined): PublisherSpec[] {
  if (!spec) {
    return [];
  }

  const parsed: PublisherSpec[] = [];

  for (const entry of spec.trim().split(/\s+/).filter(Boolean)) {
    const at = entry.indexOf('@');
    const hash = entry.lastIndexOf('#');

    if (at <= 0 || hash <= at + 1) {
      continue;
    }

    parsed.push({
      rung: entry.slice(0, at),
      url: entry.slice(at + 1, hash),
      stamp: entry.slice(hash + 1),
    });
  }

  return parsed;
}

// Reading BEE_PUBLISHERS is all this does. Nothing here writes it: the operator sets the config,
// and the CLI's job is to reach the nodes it names and report what it finds.
