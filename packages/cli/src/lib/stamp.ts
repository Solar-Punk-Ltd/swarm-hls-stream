import { Bee, BZZ, Duration, Utils } from '@ethersphere/bee-js';

import { info, ok, table, warn } from './output.js';

const DEFAULT_AMOUNT = '10000000000';
const DEFAULT_DEPTH = 20;

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
  return {
    amount: amount ?? process.env.STAMP_AMOUNT ?? DEFAULT_AMOUNT,
    depth: depth ?? (process.env.STAMP_DEPTH ? parseInt(process.env.STAMP_DEPTH, 10) : DEFAULT_DEPTH),
    immutable: immutable ?? process.env.STAMP_IMMUTABLE === 'true',
  };
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
  try {
    const { currentPrice } = await bee.getChainState();
    return { cost, duration: Utils.getStampDuration(options.amount, currentPrice, GNOSIS_BLOCK_SECONDS) };
  } catch (err) {
    return { cost, duration: null, durationUnavailable: err instanceof Error ? err.message : 'unknown error' };
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
