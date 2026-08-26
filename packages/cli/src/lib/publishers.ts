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

/** One node named in BEE_PUBLISHERS, written `rung@url<batch>`. */
export interface PublisherSpec {
  rung: string;
  url: string;
  stamp: string;
}

/**
 * What reading BEE_PUBLISHERS yields: the entries that resolved, the raw entries that did not, and
 * the rungs more than one entry claims.
 *
 * The dropped list is the whole point of this shape. An empty `parsed` means one of two very
 * different things. The variable was unset, or it was set to something unreadable, and telling them
 * apart is what stops a garbled list being read as the single node while the rungs it names go
 * unchecked.
 *
 * A duplicated rung is reported rather than resolved, and both entries stay in `parsed`. The spend
 * path refuses it already, because choosing which of two nodes to buy a batch on is not a guess
 * worth making. Listing is the opposite case: both nodes may be holding stamps, and dropping one is
 * how a batch fills unnoticed. Naming it is all this layer does.
 */
interface PublisherParse {
  parsed: PublisherSpec[];
  dropped: string[];
  duplicated: string[];
}

/** One entry as `rung@url<batch>`, or null when it cannot be read. The `#` form is still accepted. */
function readEntry(entry: string): PublisherSpec | null {
  const at = entry.indexOf('@');
  const bracketed = entry.endsWith('>');
  const open = bracketed ? entry.lastIndexOf('<') : entry.lastIndexOf('#');
  const close = bracketed ? entry.length - 1 : entry.length;

  // `close - 1` requires at least one character of batch, matching the uploader's parseEntry. `open
  // >= close` let an empty batch through as `stamp: ''`, which then read as "no configured batch" and
  // silenced the very warning stamp-check raises when a node is not holding the batch it should.
  if (at <= 0 || open <= at + 1 || open >= close - 1) {
    return null;
  }

  return {
    rung: entry.slice(0, at),
    url: entry.slice(at + 1, open),
    stamp: entry.slice(open + 1, close),
  };
}

/** The rung names more than one entry claims, each named once however many entries claim it. */
function repeatedRungs(parsed: PublisherSpec[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();

  for (const { rung } of parsed) {
    if (seen.has(rung)) {
      repeated.add(rung);
    }
    seen.add(rung);
  }

  return [...repeated];
}

/** Read BEE_PUBLISHERS into the entries that resolved and the raw entries that did not. */
export function readPublishers(spec: string | undefined): PublisherParse {
  if (!spec) {
    return { parsed: [], dropped: [], duplicated: [] };
  }

  const parsed: PublisherSpec[] = [];
  const dropped: string[] = [];

  for (const entry of spec.trim().split(/\s+/).filter(Boolean)) {
    const publisher = readEntry(entry);
    if (publisher) {
      parsed.push(publisher);
    } else {
      dropped.push(entry);
    }
  }

  return { parsed, dropped, duplicated: repeatedRungs(parsed) };
}

/** The readable entries only, for callers that do not need to know what was dropped. */
export function parsePublishers(spec: string | undefined): PublisherSpec[] {
  return readPublishers(spec).parsed;
}

// Reading BEE_PUBLISHERS is all this does. Nothing here writes it: the operator sets the config,
// and the CLI's job is to reach the nodes it names and report what it finds.
