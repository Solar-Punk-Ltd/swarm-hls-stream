import { Bee } from '@ethersphere/bee-js';

import { batchIdRecoveryNotice, reachedEnvFile, recordBatchId, STAMP_ENV_KEY } from '../lib/batch-id-record.js';
import { createBee } from '../lib/bee-client.js';
import { getEnvPath, loadEnv, resolveBeeUploaderTarget, SVC_BEE_UPLOADER } from '../lib/config-reader.js';
import { assertEnvKeyWritable } from '../lib/env-writer.js';
import { error, header, info, ok, table, warn } from '../lib/output.js';
import { buyStamp, resolveStampOptions, StampOptions } from '../lib/stamp.js';

/** See `StampSetupSeams`. Same reasoning: the ordering around the spend has to be testable. */
export interface StampBuySeams {
  createBee?: (url: string) => Bee;
  buyStamp?: (bee: Bee, options: StampOptions) => Promise<string>;
  envPath?: string;
  exit?: (code: number) => never;
}

export async function stampBuy(
  urlOverride?: string,
  amount?: string,
  depth?: number,
  immutable?: boolean,
  seams: StampBuySeams = {},
): Promise<string | null> {
  const makeBee = seams.createBee ?? createBee;
  const buy = seams.buyStamp ?? buyStamp;
  const exit = seams.exit ?? ((code: number) => process.exit(code));

  loadEnv();

  const target = resolveBeeUploaderTarget();
  const url = urlOverride ?? target.url;
  const options = resolveStampOptions(amount, depth, immutable);
  const envPath = seams.envPath ?? getEnvPath();

  header(`Buy stamp on ${SVC_BEE_UPLOADER} (${url})`);
  info(`Amount: ${options.amount}, Depth: ${options.depth}, Immutable: ${options.immutable}`);
  console.log('');

  // Same guarantee as stamp:setup, for the same reason: this spends money and the batch id is the
  // only durable product of it. Printing "Add to .env: ..." and leaving the operator to copy it out
  // of scrollback is how OPS-1 happened.
  try {
    assertEnvKeyWritable(envPath);
  } catch (err) {
    error(`Refusing to buy a stamp: ${err instanceof Error ? err.message : 'unknown'}`);
    info('Fix the path above and run pnpm stamp:buy again. No money has been spent.');
    return exit(1);
  }

  let batchIdHex: string;
  try {
    const bee = makeBee(url);
    batchIdHex = await buy(bee, options);
  } catch (err) {
    error(`Failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    return exit(1);
  }

  table('Batch ID', batchIdHex);
  console.log('');

  const record = recordBatchId(envPath, batchIdHex);
  if (!reachedEnvFile(envPath, record)) {
    for (const line of batchIdRecoveryNotice(envPath, batchIdHex, record, true)) {
      error(line);
    }
    return exit(1);
  }

  ok(`Written ${STAMP_ENV_KEY}=${batchIdHex} to .env`);
  warn('This replaced any previous STAMP value. The old batch still exists on chain.');

  return batchIdHex;
}
