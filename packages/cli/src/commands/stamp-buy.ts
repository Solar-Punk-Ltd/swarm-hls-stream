import { Bee, BZZ } from '@ethersphere/bee-js';

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
  let options: StampOptions;
  try {
    options = resolveStampOptions(amount, depth, immutable);
  } catch (err) {
    error(err instanceof Error ? err.message : 'Invalid stamp options');
    return exit(1);
  }
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

  // The same affordability refusal `stamp:setup` makes, on the command that has no other guard at
  // all. Showing a cost the wallet cannot pay and then asking to confirm it is OPS-5's harm with a
  // prompt in front of it: the operator approves, and the transaction reverts after its gas is gone.
  // A balance the node cannot report is not a refusal here, because this command never promised to
  // check one, so it warns and lets the operator decide.
  //
  // The refusal is deliberately OUTSIDE the try. Inside it, `exit(1)` throws through the seam and is
  // caught by this very catch, downgraded to "could not check the balance", and the run carries on to
  // buy. That is OPS-12's mistake exactly, and the test for this refusal is what caught it here.
  let balance: BZZ | null = null;
  try {
    balance = (await bee.getWalletBalance()).bzzBalance;
  } catch (err) {
    warn(`Could not check the wallet balance: ${err instanceof Error ? err.message : 'unknown'}`);
    warn('Buying anyway if you confirm, but the transaction will fail if the node cannot pay.');
  }

  if (balance !== null && balance.lt(quote.cost)) {
    error(`This batch costs ${quote.cost.toSignificantDigits(6)} BZZ`);
    error(`The node holds ${balance.toSignificantDigits(6)} BZZ, so the purchase would fail on chain`);
    info('Send BZZ, or buy a smaller batch with a lower depth or amount. No money has been spent.');
    return exit(1);
  }

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
