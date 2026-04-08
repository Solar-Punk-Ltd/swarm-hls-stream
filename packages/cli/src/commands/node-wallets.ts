import { createBee } from '../lib/bee-client.js';
import { loadEnv, resolveBeeGatewayTarget, resolveBeeUploaderTarget, SVC_BEE_GATEWAY, SVC_BEE_UPLOADER } from '../lib/config-reader.js';
import { error, header, table } from '../lib/output.js';

export async function nodeWallets(urlOverride?: string): Promise<void> {
  loadEnv();

  const targets = [
    { name: SVC_BEE_UPLOADER, target: resolveBeeUploaderTarget() },
    { name: SVC_BEE_GATEWAY, target: resolveBeeGatewayTarget() },
  ];

  for (const { name, target } of targets) {
    if (!target) {
      header(`${name} (disabled)`);
      continue;
    }

    const url = urlOverride ?? target.url;
    header(`${name} (${url})`);

    try {
      const bee = createBee(url);
      const wallet = await bee.getWalletBalance();
      table('BZZ', wallet.bzzBalance.toDecimalString());
      table('xDAI', wallet.nativeTokenBalance.toDecimalString());
      table('Address', wallet.walletAddress);
    } catch (err) {
      error(`Unreachable: ${err instanceof Error ? err.message : 'unknown error'}`);
    }

    if (urlOverride) break;
  }
}
