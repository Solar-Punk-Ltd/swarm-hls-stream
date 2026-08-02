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

export function printStampQuote(options: StampOptions, quote: StampQuote): void {
  table('Amount', options.amount);
  table('Depth', String(options.depth));
  table('Immutable', String(options.immutable));
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
