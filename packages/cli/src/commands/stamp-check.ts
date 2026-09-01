import { loadEnv, resolvePublisherTargets } from '../lib/config-reader.js';
import { forEachNode } from '../lib/nodes.js';
import { dim, ok, table, warn } from '../lib/output.js';

export async function stampCheck(urlOverride?: string): Promise<void> {
  loadEnv();

  await forEachNode(resolvePublisherTargets(), urlOverride, async (bee, node) => {
    const batches = await bee.getPostageBatches();

    if (batches.length === 0) {
      warn('No stamps found');
      return;
    }

    for (const batch of batches) {
      const hex = batch.batchID.toHex();
      const statusFn = batch.usable ? ok : warn;

      // Flagged because a node per rung means several batches, and the one the uploader is actually
      // spending is the only one whose utilization matters. A node holding a healthy batch that is
      // not the configured one looks fine here and still stops publishing when the real one fills.
      statusFn(`${hex}${node.stamp === hex ? '  <- configured' : ''}`);
      table('  Status', batch.usable ? 'usable' : 'not usable');
      table('  Depth', String(batch.depth));
      table('  Amount', batch.amount);
      table('  Utilization', String(batch.utilization));
      table('  Bucket depth', String(batch.bucketDepth));
      table('  Immutable', String(batch.immutableFlag));
      dim('');
    }

    if (node.stamp && !batches.some((batch) => batch.batchID.toHex() === node.stamp)) {
      warn(`Configured batch ${node.stamp} is not on this node — check BEE_PUBLISHERS`);
    }
  });
}
