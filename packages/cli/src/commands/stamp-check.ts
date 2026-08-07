import { createBee } from '../lib/bee-client.js';
import { loadEnv, resolveBeeUploaderTarget, SVC_BEE_UPLOADER } from '../lib/config-reader.js';
import { dim, error, header, ok, table, warn } from '../lib/output.js';
import { batchWarning, bucketCapacity } from '../lib/stamp.js';

export async function stampCheck(urlOverride?: string): Promise<void> {
  loadEnv();

  const target = resolveBeeUploaderTarget();
  const url = urlOverride ?? target.url;

  header(`Stamps on ${SVC_BEE_UPLOADER} (${url})`);

  try {
    const bee = createBee(url);
    const batches = await bee.getPostageBatches();

    if (batches.length === 0) {
      warn('No stamps found');
      return;
    }

    for (const batch of batches) {
      const status = batch.usable ? 'usable' : 'not usable';
      const statusFn = batch.usable ? ok : warn;
      statusFn(`${batch.batchID.toHex()}`);
      table('  Status', status);
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
  } catch (err) {
    error(`Failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exit(1);
  }
}
