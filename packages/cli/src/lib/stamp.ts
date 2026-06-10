import { Bee } from '@ethersphere/bee-js';
import { createInterface } from 'node:readline/promises';

import { info, ok } from './output.js';

const DEFAULT_AMOUNT = '10000000000';
const DEFAULT_DEPTH = 20;
const MIN_DEPTH = 17;
const MAX_DEPTH = 255;
const PLUR_PER_BZZ = 10n ** 16n;
const GNOSIS_BLOCK_TIME_SECONDS = 5n;

export interface StampOptions {
  amount: string;
  depth: number;
  immutable: boolean;
}

/**
 * Resolve stamp options from CLI args → env vars → defaults.
 * Amount is per-chunk in PLUR (1 BZZ = 10^16 PLUR); total cost = amount * 2^depth.
 */
export function resolveStampOptions(amount?: string, depth?: number, immutable?: boolean): StampOptions {
  const options: StampOptions = {
    amount: amount ?? process.env.STAMP_AMOUNT ?? DEFAULT_AMOUNT,
    depth: depth ?? (process.env.STAMP_DEPTH ? parseInt(process.env.STAMP_DEPTH, 10) : DEFAULT_DEPTH),
    immutable: immutable ?? (process.env.STAMP_IMMUTABLE === 'true'),
  };
  validateStampOptions(options);
  return options;
}

function validateStampOptions(options: StampOptions): void {
  if (!/^[1-9][0-9]*$/.test(options.amount)) {
    throw new Error(
      `Invalid stamp amount: "${options.amount}" — expected a positive integer in PLUR (1 BZZ = 10^16 PLUR)`,
    );
  }
  if (!Number.isInteger(options.depth) || options.depth < MIN_DEPTH || options.depth > MAX_DEPTH) {
    throw new Error(`Invalid stamp depth: ${options.depth} — expected an integer between ${MIN_DEPTH} and ${MAX_DEPTH}`);
  }
}

function plurToBzz(plur: bigint): string {
  const whole = plur / PLUR_PER_BZZ;
  const fraction = (plur % PLUR_PER_BZZ).toString().padStart(16, '0').slice(0, 4);
  return `${whole}.${fraction}`;
}

function totalCostBzz(options: StampOptions): string {
  return plurToBzz(BigInt(options.amount) * 2n ** BigInt(options.depth));
}

async function estimateTtl(bee: Bee, amount: string): Promise<string | null> {
  try {
    const { currentPrice } = await bee.getChainState();
    const price = BigInt(currentPrice);
    if (price <= 0n) {
      return null;
    }
    const seconds = (BigInt(amount) / price) * GNOSIS_BLOCK_TIME_SECONDS;
    const hours = seconds / 3600n;
    if (hours < 1n) {
      return `${seconds / 60n} minutes`;
    }
    if (hours < 48n) {
      return `${hours} hours`;
    }
    return `${hours / 24n} days`;
  } catch {
    return null;
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

/**
 * Buy a postage stamp. Shows the total cost and asks for confirmation on a TTY
 * (skipped with --yes). Returns the batch ID hex string.
 */
export async function buyStamp(bee: Bee, options: StampOptions, skipConfirm = false): Promise<string> {
  info(`Buying stamp (amount: ${options.amount} PLUR, depth: ${options.depth}, immutable: ${options.immutable})`);
  info(`Total cost: ${totalCostBzz(options)} BZZ`);

  const ttl = await estimateTtl(bee, options.amount);
  if (ttl) {
    info(`Estimated stamp TTL: ~${ttl}`);
  }

  if (!skipConfirm && process.stdin.isTTY) {
    const confirmed = await confirm('Proceed with purchase?');
    if (!confirmed) {
      throw new Error('Stamp purchase cancelled');
    }
  }

  const batchId = await bee.createPostageBatch(options.amount, options.depth, {
    immutableFlag: options.immutable,
    waitForUsable: false,
  });

  const hex = batchId.toHex();
  ok(`Stamp purchased: ${hex}`);
  return hex;
}
