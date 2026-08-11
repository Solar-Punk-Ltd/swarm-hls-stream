import { loadEnv, resolveNodeTargets } from '../lib/config-reader.js';
import { forEachNode } from '../lib/nodes.js';
import { ok, table } from '../lib/output.js';

export async function nodeStatus(urlOverride?: string): Promise<void> {
  loadEnv();

  await forEachNode(resolveNodeTargets(), urlOverride, async (bee) => {
    const health = await bee.getHealth();
    ok(`Status: ${health.status}`);
    table('Version', health.version);

    try {
      const topology = await bee.getTopology();
      table('Connected peers', String(topology.connected));
    } catch {
      table('Connected peers', 'unavailable');
    }
  });
}
