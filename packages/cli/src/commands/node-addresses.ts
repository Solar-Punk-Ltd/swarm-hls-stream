import { loadEnv, resolveNodeTargets } from '../lib/config-reader.js';
import { forEachNode } from '../lib/nodes.js';
import { table } from '../lib/output.js';

export async function nodeAddresses(urlOverride?: string): Promise<void> {
  loadEnv();

  await forEachNode(resolveNodeTargets(), urlOverride, async (bee) => {
    const addresses = await bee.getNodeAddresses();
    table('Ethereum', addresses.ethereum.toHex());
    table('Overlay', addresses.overlay.toHex());
    table('Public key', addresses.publicKey.toHex());
  });
}
