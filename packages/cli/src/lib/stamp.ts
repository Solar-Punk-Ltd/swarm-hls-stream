import { Bee, BZZ, Duration, Utils } from '@ethersphere/bee-js';

import { info, ok, table, warn } from './output.js';

const DEFAULT_AMOUNT = '10000000000';
const DEFAULT_DEPTH = 20;

/**
 * Bounds a batch has to sit inside to be worth pricing. 17 is the smallest depth a Bee node accepts,
 * since a batch has 65,536 buckets and needs at least two chunks each. 41 is well past any batch this
 * project would buy and exists to stop a mistyped depth becoming a cost that overflows before anyone
 * sees it.
 */
const MIN_DEPTH = 17;
const MAX_DEPTH = 41;

/**
 * Gnosis Chain's block time in seconds. Postage is charged per chunk per block, so this is what
 * turns an amount into a duration, and there is no way to ask a Bee node for it.
 */
const GNOSIS_BLOCK_SECONDS = 5;

export interface StampOptions {
  amount: string;
  depth: number;
  immutable: boolean;
}

/** What the operator asked for on the command line, before defaults and env vars are applied. */
export interface StampCommandArgs {
  url?: string;
  amount?: string;
  depth?: number;
  immutable?: boolean;
  /** Skip the confirmation before the spend. The only way a non-interactive run can approve one. */
  assumeYes?: boolean;
}

/**
 * Resolve stamp options from CLI args → env vars → defaults.
 */
export function resolveStampOptions(amount?: string, depth?: number, immutable?: boolean): StampOptions {
  const resolved = {
    amount: amount ?? process.env.STAMP_AMOUNT ?? DEFAULT_AMOUNT,
    depth: depth ?? (process.env.STAMP_DEPTH ? parseInt(process.env.STAMP_DEPTH, 10) : DEFAULT_DEPTH),
    immutable: immutable ?? process.env.STAMP_IMMUTABLE === 'true',
  };
  assertBuyable(resolved);
  return resolved;
}

/**
 * Refuse a batch nothing downstream can price, at the point the numbers are resolved.
 *
 * Without this the first thing to notice is `BigInt()` inside bee-js, several calls later and inside
 * whichever `try` happens to enclose it. A mistyped amount surfaced as
 * `Could not check the wallet balance: Cannot convert lots to a BigInt`, which blames the operator's
 * node for a typo in their own command line, and on the buy path it escaped the `exit` seam entirely.
 */
function assertBuyable({ amount, depth }: StampOptions): void {
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    throw new Error(`Stamp amount must be a positive whole number of PLUR, got: ${amount}`);
  }
  if (!Number.isInteger(depth) || depth < MIN_DEPTH || depth > MAX_DEPTH) {
    throw new Error(`Stamp depth must be a whole number between ${MIN_DEPTH} and ${MAX_DEPTH}, got: ${depth}`);
  }
}

/**
 * What a purchase will cost and how long it will last, so the operator sees both before the spend
 * rather than discovering them afterwards.
 */
export interface StampQuote {
  cost: BZZ;
  /**
   * Null when the node could not report the current postage price, which is the one input a quote
   * cannot derive from the batch parameters alone. The cost stays exact either way.
   */
  duration: Duration | null;
  /** Why `duration` is null, so an unknown TTL is never shown without saying what went wrong. */
  durationUnavailable?: string;
}

/**
 * Cost is `amount * 2^depth` and needs nothing but the batch parameters. Duration needs the chain's
 * current price, so it is fetched separately and its failure does not cost the caller the cost.
 */
export async function quoteStamp(bee: Bee, options: StampOptions): Promise<StampQuote> {
  const cost = Utils.getStampCost(options.depth, options.amount);

  let currentPrice: number;
  try {
    ({ currentPrice } = await bee.getChainState());
  } catch (err) {
    const why = err instanceof Error ? err.message : 'unknown error';
    return { cost, duration: null, durationUnavailable: `the node could not report the postage price: ${why}` };
  }

  // A separate catch, because these are different answers wearing the same shape. `getStampDuration`
  // throws "Duration must be greater than 0" when the amount buys less than one block, and that is
  // not a failure to look something up: it is the lookup succeeding and the answer being that this
  // batch expires immediately, which is the moment the operator most needs to be told plainly.
  try {
    return { cost, duration: Utils.getStampDuration(options.amount, currentPrice, GNOSIS_BLOCK_SECONDS) };
  } catch {
    return {
      cost,
      duration: null,
      durationUnavailable: `this batch expires immediately: ${options.amount} PLUR buys under one block at the current price of ${currentPrice}`,
    };
  }
}

/**
 * The fields of a Bee postage batch this module reads, so a caller need not hold a whole one.
 *
 * `usage` and `duration` are bee-js's own, deliberately. `usage` is `utilization / 2^(depth -
 * bucketDepth)` and this module used to compute that itself, which put a second copy of the library's
 * formula in a place nothing would have noticed drifting.
 */
export interface BatchLimits {
  depth: number;
  bucketDepth: number;
  utilization: number;
  usage: number;
  duration: Duration;
  immutableFlag: boolean;
}

/**
 * Chunks one bucket of this batch holds, which is the denominator `utilization` is counted against.
 *
 * ⚠️ `utilization` is the count in the **fullest** bucket, not an average and not a total, so a batch
 * is out of room long before its nominal `2^depth` chunks are used. Depth 22 gives 65,536 buckets of
 * 64 chunks, and the first bucket to reach 64 is the end of the batch. bee-js documents the
 * relationship on `PostageBatch.utilization` but does not expose the number, so it is derived here to
 * be shown beside the count rather than to be compared against anything.
 */
export function bucketCapacity(batch: Pick<BatchLimits, 'depth' | 'bucketDepth'>): number {
  return 2 ** (batch.depth - batch.bucketDepth);
}

/**
 * The owner's thresholds for stopping and asking, rather than anything Bee enforces. A sweep's rows
 * are only comparable inside one sitting, so a batch that runs out halfway wastes the runs already
 * in it, and both of these are set to fire before that rather than during it.
 */
const CROWDED_USAGE = 0.75;
const SHORT_TTL_DAYS = 2;

/**
 * Why this batch wants attention, or null while it wants none.
 *
 * ⛔ Measured 2026-08-04, and the reason this exists: batch `01cc77f9` at depth 22 read 9.4% used on
 * 08-03 and 64/64 on 08-04. One day of sweep traffic took it from nearly empty to full while its TTL,
 * the only thing anything watched, still had days on it.
 *
 * A mutable batch is the dangerous one and it is also the quiet one: a full bucket **overwrites its
 * oldest chunk** rather than refusing the upload, so a live stream carries on exactly as before while
 * its earliest segments stop being retrievable. Nothing logs it and every health signal stays green.
 * An immutable batch refuses the upload instead, which stops a broadcast and is far easier to notice.
 */
export function batchWarning(batch: BatchLimits): string | null {
  const reasons: string[] = [];
  const full = `${Math.round(batch.usage * 100)}% full`;

  if (batch.usage >= CROWDED_USAGE) {
    reasons.push(
      batch.immutableFlag
        ? `${full}, so it will start refusing uploads`
        : `${full} and mutable, so a full bucket overwrites its oldest chunk and older segments stop being retrievable with nothing logged`,
    );
  }
  if (batch.duration.toDays() < SHORT_TTL_DAYS) {
    reasons.push(`${batch.duration.toDays().toFixed(2)} days left`);
  }

  return reasons.length > 0 ? reasons.join(', and ') : null;
}

export function printStampQuote(options: StampOptions, quote: StampQuote): void {
  table('Amount', options.amount);
  table('Depth', String(options.depth));
  // Spelled out rather than shown as a boolean, because this is the moment the choice is paid for
  // and the two failure modes are nothing alike. `STAMP_IMMUTABLE` defaults to false, so an operator
  // who passes no flag is buying the quiet one without being told which one that is.
  table(
    'Immutable',
    options.immutable
      ? 'yes, so a full batch refuses uploads'
      : 'no, so a full batch overwrites its own oldest chunks and older segments stop being retrievable',
  );
  table('Cost', `${quote.cost.toSignificantDigits(6)} BZZ`);
  if (quote.duration) {
    table('Lasts for', quote.duration.represent());
  } else {
    warn(`Could not work out how long this batch would last: ${quote.durationUnavailable}`);
  }
}

/**
 * Buy a postage stamp. Returns the batch ID hex string.
 */
export async function buyStamp(bee: Bee, options: StampOptions): Promise<string> {
  info(`Buying stamp (amount: ${options.amount}, depth: ${options.depth}, immutable: ${options.immutable})...`);

  const batchId = await bee.createPostageBatch(options.amount, options.depth, {
    immutableFlag: options.immutable,
    waitForUsable: false,
  });

  const hex = batchId.toHex();
  ok(`Stamp purchased: ${hex}`);
  return hex;
}
