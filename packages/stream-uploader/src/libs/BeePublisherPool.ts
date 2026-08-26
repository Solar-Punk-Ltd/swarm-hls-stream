import { Bee } from '@ethersphere/bee-js';

import { Logger } from './Logger.js';

/** One funded Bee node, and the postage batch it pays with. */
export interface BeePublisher {
  /** The rung this node publishes, or {@link SINGLE_PUBLISHER} when one node serves everything. */
  readonly rung: string;
  readonly url: string;
  readonly stamp: string;
  readonly bee: Bee;
}

/** One node, everything through it — what `rung` reads as when the deployment has not been split. */
export const SINGLE_PUBLISHER = 'all';

/** A publisher as configured, before a Bee client exists for it. */
export interface PublisherSpec {
  rung: string;
  url: string;
  stamp: string;
}

const RUNG_NAME = /^[a-zA-Z0-9._-]+$/;
/** A postage batch id is 32 bytes of hex. Checked so a truncated paste fails at startup. */
const BATCH_ID = /^[0-9a-fA-F]{64}$/;

/**
 * Which Bee node publishes what.
 *
 * A feed's address is a pure function of its signing key and its topic — the node that pushed the
 * chunk is nowhere in it. `makeFeedIdentifier` is `keccak256(topic ‖ index)`, and bee-js signs the
 * single owner chunk locally before POSTing it, so a node here is not the owner of anything: it is a
 * pipe with a wallet. Which pipe carries which rung is therefore a routing decision, and this is
 * where it lives.
 *
 * The routing matters because postage batches drain in proportion to bitrate. Across the shipped
 * ladder 1080p burns roughly seven times the bytes of 360p, so batches of equal depth expire hours
 * apart. A node per rung turns that from "the stage stops" into "one rung goes quiet and ABR steps
 * down", which is the whole reason for splitting them.
 */
export class BeePublisherPool {
  private readonly logger = Logger.getInstance();

  private constructor(
    /** Ascending rung height. That order is the routing decision — see {@link coordinator}. */
    private readonly ordered: BeePublisher[],
    private readonly byRung: Map<string, BeePublisher>,
  ) {}

  /**
   * One node for everything.
   *
   * This is every deployment that has not been split per rung yet, and it is also the only shape a
   * single-rendition deployment can have — with the ladder off there are no rungs to split by.
   */
  public static single(url: string, stamp: string): BeePublisherPool {
    // The same eager validation parseEntry applies to each split node, so a truncated STAMP or a
    // non-http BEE_URL refuses to start here too rather than failing on the first paid write.
    assertBatchId('STAMP', stamp);
    assertHttpUrl('BEE_URL', url);

    const publisher: BeePublisher = { rung: SINGLE_PUBLISHER, url, stamp, bee: new Bee(url) };
    return new BeePublisherPool([publisher], new Map([[SINGLE_PUBLISHER, publisher]]));
  }

  /**
   * One node per rung, ordered by the ladder rather than by the order they were configured in.
   *
   * `rungOrder` is expected ascending by height, which is what `AbrLadder.rungs()` returns. Sorting
   * here rather than trusting the config means the coordination decision below cannot be broken by
   * writing BEE_PUBLISHERS in a different order.
   *
   * Coverage is exact in both directions: a ladder rung with no node would publish to whichever
   * node the fallback picked and quietly spend the wrong batch, and a node named for a rung the
   * ladder does not have is a typo that would otherwise sit unused until someone wondered why a
   * rung was missing.
   */
  public static perRung(specs: PublisherSpec[], rungOrder: string[]): BeePublisherPool {
    const byRung = new Map<string, BeePublisher>(
      specs.map((spec) => [spec.rung, { rung: spec.rung, url: spec.url, stamp: spec.stamp, bee: new Bee(spec.url) }]),
    );

    const missing = rungOrder.filter((rung) => !byRung.has(rung));
    if (missing.length > 0) {
      throw new Error(
        `BEE_PUBLISHERS has no node for rung(s) ${missing.join(', ')}; every rung in ABR_LADDER needs one`,
      );
    }

    const unknown = specs.map((spec) => spec.rung).filter((rung) => !rungOrder.includes(rung));
    if (unknown.length > 0) {
      throw new Error(`BEE_PUBLISHERS names rung(s) ${unknown.join(', ')}, which ABR_LADDER does not have`);
    }

    return new BeePublisherPool(
      rungOrder.map((rung) => byRung.get(rung)!),
      byRung,
    );
  }

  /** The node a rung's segments and manifest feed go through. */
  public forRung(rung: string): BeePublisher {
    const publisher = this.byRung.get(rung) ?? this.byRung.get(SINGLE_PUBLISHER);
    if (publisher) {
      return publisher;
    }

    // Reachable when a stream recovered from disk names a rung the current ABR_LADDER no longer
    // has. It keeps the group and topics its siblings already published under, so dropping it would
    // strand a live ladder — it continues through the coordination head instead. Loud, because its
    // segments now land on a batch sized for a different rung.
    const fallback = this.ordered[0];
    this.logger.warn(
      `[BeePublisherPool] No node configured for rung "${rung}" — publishing through ${fallback.rung} ` +
        `(${fallback.url}) instead. This rung is spending a batch that was not sized for it.`,
    );
    return fallback;
  }

  /**
   * The node that coordination writes — the stream catalog, and a ladder's master playlist — go
   * through. Also where a stream with no rung at all lands, which is any single-rendition stream.
   *
   * The lowest rung's node, because it has the longest-lived postage batch and the least upload
   * pressure of the four, and because the master is the one address a viewer needs to open a stage
   * at all. Riding it on the 1080p node would take discovery down first, while three rungs were
   * still publishing perfectly well.
   *
   * TODO: the pool stays ordered so a dead node can be skipped by walking it. Failover is not wired
   * up yet, so losing this node blocks new viewers from joining while existing ones play on.
   */
  public coordinator(): BeePublisher {
    return this.ordered[0];
  }
}

/**
 * Parses BEE_PUBLISHERS: space-separated `rung@url<batch>`, empty when unset.
 *
 * Deliberately the same shape as ABR_LADDER — one variable, one entry per rung, parsed and
 * validated eagerly so a typo refuses to start rather than silently publishing a rung to the wrong
 * node and the wrong batch.
 *
 * Split on the *first* `@` and the *last* bracket, so a URL carrying userinfo or a port survives
 * intact. A rung name cannot contain either, and a batch id is hex, so the tail is unambiguous.
 */
export function parsePublisherSpecs(spec: string): PublisherSpec[] {
  const entries = spec.trim().split(/\s+/).filter(Boolean);
  if (entries.length === 0) {
    return [];
  }

  const specs = entries.map((entry) => parseEntry(entry));

  const seen = new Set<string>();
  for (const publisher of specs) {
    if (seen.has(publisher.rung)) {
      throw new Error(`BEE_PUBLISHERS has two nodes for rung "${publisher.rung}"`);
    }
    seen.add(publisher.rung);
  }

  return specs;
}

/**
 * One entry: `rung@url<batch>`.
 *
 * The batch is bracketed rather than introduced by a `#`, which is what this used to use and which
 * was a bad choice: `#` opens a comment in a `.env` file, so dotenv truncated the value at the first
 * one and handed the parser a URL with no batch on it. The error that produced named a string the
 * operator had never typed.
 *
 * `#` is still accepted, so a config already written that way keeps working — a quoted value was
 * always a legal way to escape it.
 */
function parseEntry(entry: string): PublisherSpec {
  const at = entry.indexOf('@');
  const open = entry.endsWith('>') ? entry.lastIndexOf('<') : entry.lastIndexOf('#');
  const close = entry.endsWith('>') ? entry.length - 1 : entry.length;

  if (at <= 0 || open <= at + 1 || open >= close - 1) {
    throw new Error(
      `BEE_PUBLISHERS entry "${entry}" must be rung@url<batch>, ` + `e.g. 360p@http://localhost:1633<0a1b2c…>`,
    );
  }

  const rung = entry.slice(0, at);
  const url = entry.slice(at + 1, open);
  const stamp = entry.slice(open + 1, close);

  if (!RUNG_NAME.test(rung)) {
    throw new Error(`BEE_PUBLISHERS rung name "${rung}" must match ${RUNG_NAME}`);
  }

  assertBatchId(`BEE_PUBLISHERS batch id for "${rung}"`, stamp);
  assertHttpUrl(`BEE_PUBLISHERS url for "${rung}"`, url);

  return { rung, url, stamp };
}

function assertBatchId(subject: string, stamp: string): void {
  if (!BATCH_ID.test(stamp)) {
    throw new Error(`${subject} must be 64 hex characters, got ${stamp.length} ("${stamp.slice(0, 8)}…")`);
  }
}

function assertHttpUrl(subject: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${subject} is not a URL: "${url}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${subject} must be http or https, got "${parsed.protocol}"`);
  }
}
