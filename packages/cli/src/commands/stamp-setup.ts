import { Bee } from '@ethersphere/bee-js';

import { batchIdRecoveryNotice, recordBatchId, STAMP_ENV_KEY } from '../lib/batch-id-record.js';
import { createBee } from '../lib/bee-client.js';
import { getEnvPath, loadEnv, resolveBeeUploaderTarget } from '../lib/config-reader.js';
import { assertEnvKeyWritable } from '../lib/env-writer.js';
import { error, header, info, ok, table, warn } from '../lib/output.js';
import { buyStamp, resolveStampOptions, StampOptions } from '../lib/stamp.js';
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
}

export async function stampSetup(
  urlOverride?: string,
  amount?: string,
  depth?: number,
  immutable?: boolean,
  seams: StampSetupSeams = {},
): Promise<void> {
  const makeBee = seams.createBee ?? createBee;
  const buy = seams.buyStamp ?? buyStamp;
  const awaitNode = seams.waitForNode ?? waitForNode;
  const awaitStamp = seams.waitForStamp ?? waitForStamp;
  const exit = seams.exit ?? ((code: number) => process.exit(code));

  loadEnv();

  const target = resolveBeeUploaderTarget();
  const url = urlOverride ?? target.url;
  const options = resolveStampOptions(amount, depth, immutable);
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

  // Step 2: Check wallet balance
  try {
    const addresses = await bee.getNodeAddresses();
    const wallet = await bee.getWalletBalance();
    const bzz = wallet.bzzBalance.toDecimalString();
    const xdai = wallet.nativeTokenBalance.toDecimalString();

    table('Node address', addresses.ethereum.toHex());
    table('BZZ balance', bzz);
    table('xDAI balance', xdai);
    console.log('');

    const hasBzz = wallet.bzzBalance.toPLURBigInt() > 0n;
    const hasGas = wallet.nativeTokenBalance.toWeiBigInt() > 0n;

    if (!hasBzz || !hasGas) {
      error('Node wallet is not funded');
      if (!hasGas) {
        warn('Send xDAI (Gnosis Chain) for gas fees');
      }
      if (!hasBzz) {
        warn('Send BZZ tokens to buy postage stamps');
      }
      console.log('');
      info(`Fund this address: ${addresses.ethereum.toHex()}`);
      info('Then run pnpm stamp:setup again');
      return exit(1);
    }

    ok('Wallet is funded');
  } catch (err) {
    warn(`Could not check wallet: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // Step 3: Check for existing usable stamps
  try {
    const batches = await bee.getPostageBatches();
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
      for (const line of batchIdRecoveryNotice(envPath, existingHex, reused)) {
        warn(line);
      }
      if (reused.writtenTo[0] === envPath) {
        ok(`Written ${STAMP_ENV_KEY}=${existingHex} to .env`);
      }
      console.log('');
      info('Run ./deploy/scripts/deploy.sh to deploy the full stack');
      return;
    }
  } catch (err) {
    warn(`Could not check existing stamps: ${err instanceof Error ? err.message : 'unknown'}`);
  }

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

  // Step 5: Buy a new stamp
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
  const notice = batchIdRecoveryNotice(envPath, batchIdHex, record);
  if (notice.length > 0) {
    for (const line of notice) {
      error(line);
    }
  } else {
    ok(`Written ${STAMP_ENV_KEY}=${batchIdHex} to .env`);
  }

  // Step 7: Wait for the stamp to become usable
  try {
    await awaitStamp(bee, batchIdHex);
  } catch (err) {
    error(err instanceof Error ? err.message : 'Stamp did not become usable');
    warn('The batch id above is already recorded. Check later with: pnpm stamp:check');
    return exit(1);
  }

  console.log('');
  info('Run ./deploy/scripts/deploy.sh to deploy the full stack');
}
