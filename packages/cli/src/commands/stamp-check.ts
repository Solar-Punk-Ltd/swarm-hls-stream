import { loadEnv, resolvePublisherTargets } from '../lib/config-reader.js';
import { forEachNode } from '../lib/nodes.js';
import { dim, ok, table, warn } from '../lib/output.js';
import { batchWarning, bucketCapacity } from '../lib/stamp.js';

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
      // Beside its denominator rather than as the bare count Bee reports. `Utilization: 50` says
      // nothing on its own, and reading it as a share of the whole batch is the mistake it invites.
      table(
        '  Fullest bucket',
        `${batch.utilization} / ${bucketCapacity(batch)} chunks (${Math.round(batch.usage * 100)}%)`,
      );
      table('  TTL', `${batch.duration.toDays().toFixed(2)} days`);
      table('  Immutable', String(batch.immutableFlag));

      const attention = batchWarning(batch);
      if (attention) {
        warn(`  ${attention}`);
      }
      dim('');
    }

    if (node.stamp && !batches.some((batch) => batch.batchID.toHex() === node.stamp)) {
      warn(`Configured batch ${node.stamp} is not on this node — check BEE_PUBLISHERS`);
    }
  });
}
