import { Bee } from '@ethersphere/bee-js';

import { info, ok } from './output.js';

const DEFAULT_AMOUNT = '10000000000';
const DEFAULT_DEPTH = 20;

export interface StampOptions {
  amount: string;
  depth: number;
  immutable: boolean;
}

/**
 * Resolve stamp options from CLI args → env vars → defaults.
 */
export function resolveStampOptions(amount?: string, depth?: number, immutable?: boolean): StampOptions {
  return {
    amount: amount ?? process.env.STAMP_AMOUNT ?? DEFAULT_AMOUNT,
    depth: depth ?? (process.env.STAMP_DEPTH ? parseInt(process.env.STAMP_DEPTH, 10) : DEFAULT_DEPTH),
    immutable: immutable ?? (process.env.STAMP_IMMUTABLE === 'true'),
  };
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
