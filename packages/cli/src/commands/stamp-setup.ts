import { Bee } from '@ethersphere/bee-js';

import { batchIdRecoveryNotice, reachedEnvFile, recordBatchId, STAMP_ENV_KEY } from '../lib/batch-id-record.js';
import { createBee } from '../lib/bee-client.js';
import { getEnvPath, loadEnv, resolveBeeUploaderTarget } from '../lib/config-reader.js';
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
import { waitForNode, waitForStamp } from '../lib/wait.js';

/**
 * Seams for the steps that reach the network or the chain, so the ordering around the spend can be
 * driven in a test. Every one defaults to the real implementation: a test can prove that the batch
 * id is recorded before anything that can throw, which is the part no amount of reading establishes.
 */
export interface StampSetupSeams {
  createBee?: (url: string) => Bee;
  buyStamp?: (bee: Bee, options: StampOptions) => Promise<string>;
  waitForNode?: (bee: Bee) => Promise<unknown>;
  waitForStamp?: (bee: Bee, batchId: string) => Promise<unknown>;
  envPath?: string;
  /** Defaults to `process.exit`. Tests pass one that throws, so a failure path cannot end the run. */
  exit?: (code: number) => never;
  /** Defaults to a terminal prompt. A test passes one that answers without a TTY. */
  confirm?: (question: string) => Promise<boolean>;
}

export async function stampSetup(args: StampCommandArgs = {}, seams: StampSetupSeams = {}): Promise<void> {
  const { url: urlOverride, amount, depth, immutable, assumeYes } = args;
  const makeBee = seams.createBee ?? createBee;
  const buy = seams.buyStamp ?? buyStamp;
  const awaitNode = seams.waitForNode ?? waitForNode;
  const awaitStamp = seams.waitForStamp ?? waitForStamp;
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

  header(`Stamp Setup (${url})`);

  // Step 1: Wait for node
  const bee = makeBee(url);
  try {
    await awaitNode(bee);
  } catch (err) {
    error(err instanceof Error ? err.message : 'Node not reachable');
    return exit(1);
  }

  // Step 2: Check for existing usable stamps.
  // Ahead of the wallet check on purpose. Listing is served from the node's local store and needs
  // no chain, while the balance needs a working Gnosis RPC. Reusing a batch spends nothing, so a
  // failing RPC must not block the one path that costs the operator nothing.
  let batches;
  try {
    batches = await bee.getPostageBatches();
  } catch (err) {
    // Indistinguishable from "there are none", and the difference costs a whole batch: carrying on
    // buys a duplicate and orphans whichever one STAMP does not name. See OPS-12.
    error(`Could not list existing stamps: ${err instanceof Error ? err.message : 'unknown'}`);
    info('Refusing to buy a stamp that may duplicate one you already own. No money has been spent.');
    info('Check with: pnpm stamp:check');
    return exit(1);
  }

  // Deliberately outside the try above, so the exits below are not caught and re-reported as a
  // listing failure. That is the same mistake the wallet block used to make.
  const usable = batches.filter((b) => b.usable);
  if (usable.length > 0) {
    warn(`Found ${usable.length} existing usable stamp(s):`);
    for (const batch of usable) {
      table('  Batch ID', batch.batchID.toHex());
      table('  Depth', String(batch.depth));
      table('  Amount', batch.amount);
      table('  Immutable', String(batch.immutableFlag));
    }
    console.log('');

    const existing = usable[0];
    const existingHex = existing.batchID.toHex();
    info(`Using existing stamp: ${existingHex}`);
    const reused = recordBatchId(envPath, existingHex);
    if (!reachedEnvFile(envPath, reused)) {
      for (const line of batchIdRecoveryNotice(envPath, existingHex, reused, false)) {
        error(line);
      }
      return exit(1);
    }
    ok(`Written ${STAMP_ENV_KEY}=${existingHex} to .env`);
    console.log('');
    info('Run ./deploy/scripts/deploy.sh to deploy the full stack');
    return;
  }

  // Step 3: Check the wallet balance, now that a purchase is actually on the cards.
  // The refusal is deliberately outside the try. It used to sit inside, so anything it threw was
  // caught by this catch and downgraded to "Could not check wallet", and the run bought a stamp
  // anyway. That made the branch untestable through the exit seam and one refactor away from being
  // untrue in production too.
  // Deliberately before the try below. `quoteStamp` reaches the chain for a price and swallows its
  // own failure, but the cost it computes is pure arithmetic that can still throw, and inside that
  // try any throw is reported as "Could not check the wallet balance" — the node blamed for a fault
  // that is not the node's.
  const quote = await quoteStamp(bee, options);

  let funding: { affordsBatch: boolean; hasGas: boolean; address: string; balance: string; cost: string };
  try {
    const addresses = await bee.getNodeAddresses();
    const wallet = await bee.getWalletBalance();

    table('Node address', addresses.ethereum.toHex());
    table('BZZ balance', wallet.bzzBalance.toDecimalString());
    table('xDAI balance', wallet.nativeTokenBalance.toDecimalString());
    console.log('');
    printStampQuote(options, quote);
    console.log('');

    funding = {
      // A batch costs `amount * 2^depth`, so "has any BZZ at all" was never the question. One PLUR
      // of dust passed the old check and the transaction then failed on chain, after the gas for it
      // had been spent. See OPS-5.
      affordsBatch: wallet.bzzBalance.gte(quote.cost),
      // No equivalent sufficiency check exists for gas: the fee depends on the chain's price at the
      // moment of the transaction, which nothing here can read, so this stays a non-zero check and
      // is deliberately not dressed up as more than that.
      hasGas: wallet.nativeTokenBalance.toWeiBigInt() > 0n,
      address: addresses.ethereum.toHex(),
      balance: wallet.bzzBalance.toSignificantDigits(6),
      cost: quote.cost.toSignificantDigits(6),
    };
  } catch (err) {
    // A failed check is not a passed check. This used to warn on one line and carry on to the
    // purchase with the balance unknown, which is the one state where proceeding is least
    // defensible: the next step spends money. See OPS-12.
    error(`Could not check the wallet balance: ${err instanceof Error ? err.message : 'unknown'}`);
    info('Refusing to buy a stamp without knowing the balance. No money has been spent.');
    return exit(1);
  }

  if (!funding.affordsBatch || !funding.hasGas) {
    error('Node wallet cannot pay for this batch');
    if (!funding.hasGas) {
      warn('Send xDAI (Gnosis Chain) for gas fees');
    }
    if (!funding.affordsBatch) {
      warn(`This batch costs ${funding.cost} BZZ and the node holds ${funding.balance} BZZ`);
      warn('Send BZZ, or buy a smaller batch with a lower depth or amount');
    }
    console.log('');
    info(`Fund this address: ${funding.address}`);
    info('Then run pnpm stamp:setup again. No money has been spent.');
    return exit(1);
  }

  ok('Wallet can pay for this batch');

  // Step 4: Establish that the result can be recorded, before spending anything.
  // A batch id that cannot be written down is worth nothing to the operator, and this is the last
  // moment refusing costs them nothing.
  try {
    assertEnvKeyWritable(envPath);
  } catch (err) {
    error(`Refusing to buy a stamp: ${err instanceof Error ? err.message : 'unknown'}`);
    info('Fix the path above and run pnpm stamp:setup again. No money has been spent.');
    return exit(1);
  }

  // Step 5: Ask. The cost and TTL are already on screen from step 3, and this is the last point at
  // which the operator can still stop. Deliberately after the writability check, so nobody is asked
  // to approve a purchase this run was going to refuse anyway.
  if (!assumeYes && !(await ask('Buy this stamp?'))) {
    info('Aborted. No money has been spent.');
    return exit(1);
  }

  // Step 6: Buy a new stamp
  let batchIdHex: string;
  try {
    batchIdHex = await buy(bee, options);
  } catch (err) {
    error(`Failed to buy stamp: ${err instanceof Error ? err.message : 'unknown'}`);
    return exit(1);
  }

  // Step 6: Record it immediately. Nothing that can throw may come between the spend and this,
  // including waiting for the batch to become usable, which routinely times out.
  const record = recordBatchId(envPath, batchIdHex);
  if (!reachedEnvFile(envPath, record)) {
    // The money is already gone, so this is a failure the operator has to act on. Exiting non-zero
    // matters as much as the message: `pnpm stamp:setup && ./deploy/scripts/deploy.sh` otherwise
    // carries straight on, and the run used to end by telling them to deploy.
    for (const line of batchIdRecoveryNotice(envPath, batchIdHex, record, true)) {
      error(line);
    }
    return exit(1);
  }
  ok(`Written ${STAMP_ENV_KEY}=${batchIdHex} to .env`);

  // Step 7: Wait for the stamp to become usable
  try {
    await awaitStamp(bee, batchIdHex);
  } catch (err) {
    error(err instanceof Error ? err.message : 'Stamp did not become usable');
    // Only sayable because the branch above returned when the write failed.
    warn(`The batch id is recorded in ${envPath}. Check later with: pnpm stamp:check`);
    return exit(1);
  }

  console.log('');
  info('Run ./deploy/scripts/deploy.sh to deploy the full stack');
}
