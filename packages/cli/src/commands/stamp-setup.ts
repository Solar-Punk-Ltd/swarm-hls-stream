import { createBee } from '../lib/bee-client.js';
import { getEnvPath, loadEnv, resolveBeeUploaderTarget } from '../lib/config-reader.js';
import { writeEnvKey } from '../lib/env-writer.js';
import { error, header, info, ok, table, warn } from '../lib/output.js';
import { buyStamp, resolveStampOptions } from '../lib/stamp.js';
import { waitForNode, waitForStamp } from '../lib/wait.js';

export async function stampSetup(urlOverride?: string, amount?: string, depth?: number, immutable?: boolean): Promise<void> {
  loadEnv();

  const target = resolveBeeUploaderTarget();
  const url = urlOverride ?? target.url;
  const options = resolveStampOptions(amount, depth, immutable);
  const envPath = getEnvPath();

  header(`Stamp Setup (${url})`);

  // Step 1: Wait for node
  const bee = createBee(url);
  try {
    await waitForNode(bee);
  } catch (err) {
    error(err instanceof Error ? err.message : 'Node not reachable');
    process.exit(1);
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
      if (!hasGas) warn('Send xDAI (Gnosis Chain) for gas fees');
      if (!hasBzz) warn('Send BZZ tokens to buy postage stamps');
      console.log('');
      info(`Fund this address: ${addresses.ethereum.toHex()}`);
      info('Then run pnpm stamp:setup again');
      process.exit(1);
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
      writeEnvKey(envPath, 'STAMP', existingHex);
      ok(`Written STAMP=${existingHex} to .env`);
      console.log('');
      info('Run ./deploy/scripts/deploy.sh to deploy the full stack');
      return;
    }
  } catch (err) {
    warn(`Could not check existing stamps: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // Step 4: Buy a new stamp
  let batchIdHex: string;
  try {
    batchIdHex = await buyStamp(bee, options);
  } catch (err) {
    error(`Failed to buy stamp: ${err instanceof Error ? err.message : 'unknown'}`);
    process.exit(1);
  }

  // Step 5: Wait for stamp to become usable
  try {
    await waitForStamp(bee, batchIdHex);
  } catch (err) {
    error(err instanceof Error ? err.message : 'Stamp did not become usable');
    warn(`You can check later with: pnpm stamp:check`);
    writeEnvKey(envPath, 'STAMP', batchIdHex);
    warn(`Written STAMP=${batchIdHex} to .env (stamp may not be usable yet)`);
    process.exit(1);
  }

  // Step 6: Write to .env
  writeEnvKey(envPath, 'STAMP', batchIdHex);
  ok(`Written STAMP=${batchIdHex} to .env`);
  console.log('');
  info('Run ./deploy/scripts/deploy.sh to deploy the full stack');
}
