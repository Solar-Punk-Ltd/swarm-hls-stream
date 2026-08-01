import { Bee } from '@ethersphere/bee-js';

import { batchIdRecoveryNotice, reachedEnvFile, recordBatchId, STAMP_ENV_KEY } from '../lib/batch-id-record.js';
import { createBee } from '../lib/bee-client.js';
import { getEnvPath, loadEnv, resolveBeeUploaderTarget, SVC_BEE_UPLOADER } from '../lib/config-reader.js';
import { confirm } from '../lib/confirm.js';
import { assertEnvKeyWritable } from '../lib/env-writer.js';
import { error, header, info, ok, table, warn } from '../lib/output.js';
import {
  buyStamp,
  printStampQuote,
  quoteStamp,
  resolveStampOptions,
  StampCommandArgs,
  StampOptions,
} from '../lib/stamp.js';

/** See `StampSetupSeams`. Same reasoning: the ordering around the spend has to be testable. */
export interface StampBuySeams {
  createBee?: (url: string) => Bee;
  buyStamp?: (bee: Bee, options: StampOptions) => Promise<string>;
  envPath?: string;
  exit?: (code: number) => never;
  /** Defaults to a terminal prompt. A test passes one that answers without a TTY. */
  confirm?: (question: string) => Promise<boolean>;
}

export async function stampBuy(args: StampCommandArgs = {}, seams: StampBuySeams = {}): Promise<string | null> {
  const { url: urlOverride, amount, depth, immutable, assumeYes } = args;
  const makeBee = seams.createBee ?? createBee;
  const buy = seams.buyStamp ?? buyStamp;
  const exit = seams.exit ?? ((code: number) => process.exit(code));
  const ask = seams.confirm ?? confirm;

  loadEnv();

  const target = resolveBeeUploaderTarget();
  const url = urlOverride ?? target.url;
  const options = resolveStampOptions(amount, depth, immutable);
  const envPath = seams.envPath ?? getEnvPath();

  header(`Buy stamp on ${SVC_BEE_UPLOADER} (${url})`);

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

  let bee: Bee;
  try {
    bee = makeBee(url);
  } catch (err) {
    error(`Failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    return exit(1);
  }

  // The command used to print the amount and depth and buy. Neither number says what the purchase
  // costs or how long the batch lasts, and both are derived rather than looked up, so an operator
  // typing a depth one digit out had nothing on screen that would have told them. See OPS-7.
  const quote = await quoteStamp(bee, options);
  printStampQuote(options, quote);
  console.log('');

  if (!assumeYes && !(await ask('Buy this stamp?'))) {
    info('Aborted. No money has been spent.');
    return exit(1);
  }

  let batchIdHex: string;
  try {
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
