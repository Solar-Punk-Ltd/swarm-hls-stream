import { createBee } from '../lib/bee-client.js';
import { loadEnv, resolveBeeGatewayTarget, resolveBeeUploaderTarget, SVC_BEE_GATEWAY, SVC_BEE_UPLOADER } from '../lib/config-reader.js';
import { error, header, ok, table } from '../lib/output.js';

export async function nodeStatus(urlOverride?: string): Promise<void> {
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
      const health = await bee.getHealth();
      ok(`Status: ${health.status}`);
      table('Version', health.version);

      try {
        const topology = await bee.getTopology();
        table('Connected peers', String(topology.connected));
      } catch {
        table('Connected peers', 'unavailable');
      }
    } catch (err) {
      error(`Unreachable: ${err instanceof Error ? err.message : 'unknown error'}`);
    }

    // Only check the first target if url override is set
    if (urlOverride) break;
  }
}
