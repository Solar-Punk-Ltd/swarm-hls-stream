import { createBee } from '../lib/bee-client.js';
import { loadEnv, resolveBeeUploaderTarget, SVC_BEE_UPLOADER } from '../lib/config-reader.js';
import { dim, error, header, ok, table, warn } from '../lib/output.js';

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
      table('  Utilization', String(batch.utilization));
      table('  Bucket depth', String(batch.bucketDepth));
      table('  Immutable', String(batch.immutableFlag));
      dim('');
    }
  } catch (err) {
    error(`Failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exit(1);
  }
}
