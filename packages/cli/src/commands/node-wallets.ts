import { loadEnv, resolveNodeTargets } from '../lib/config-reader.js';
import { forEachNode } from '../lib/nodes.js';
import { table, warn } from '../lib/output.js';

export async function nodeWallets(urlOverride?: string): Promise<void> {
  loadEnv();

  await forEachNode(resolveNodeTargets(), urlOverride, async (bee, node) => {
    const wallet = await bee.getWalletBalance();
    table('BZZ', wallet.bzzBalance.toDecimalString());
    table('xDAI', wallet.nativeTokenBalance.toDecimalString());
    table('Address', wallet.walletAddress);

    // Only publishers buy batches and settle cheques, so only they need funding. Said here because
    // with a node per rung there are four wallets to keep topped up per stage, and an unfunded one
    // shows up much later as a rung that silently stops publishing.
    if (node.rung && wallet.bzzBalance.toPLURBigInt() === 0n) {
      warn(`No BZZ — rung ${node.rung} cannot buy or extend a postage batch`);
    }
    if (node.rung && wallet.nativeTokenBalance.toWeiBigInt() === 0n) {
      warn(`No xDAI — rung ${node.rung} cannot pay gas`);
    }
  });
}
