import { createBee } from '../lib/bee-client.js';
import { loadEnv, resolveBeeUploaderTarget, SVC_BEE_UPLOADER } from '../lib/config-reader.js';
import { error, header, info, table } from '../lib/output.js';
import { buyStamp, resolveStampOptions } from '../lib/stamp.js';

export async function stampBuy(urlOverride?: string, amount?: string, depth?: number, immutable?: boolean): Promise<string | null> {
  loadEnv();

  const target = resolveBeeUploaderTarget();
  const url = urlOverride ?? target.url;
  const options = resolveStampOptions(amount, depth, immutable);

  header(`Buy stamp on ${SVC_BEE_UPLOADER} (${url})`);
  info(`Amount: ${options.amount}, Depth: ${options.depth}, Immutable: ${options.immutable}`);
  console.log('');

  try {
    const bee = createBee(url);
    const batchIdHex = await buyStamp(bee, options);

    table('Batch ID', batchIdHex);
    console.log('');
    info(`Add to .env: STAMP=${batchIdHex}`);

    return batchIdHex;
  } catch (err) {
    error(`Failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exit(1);
  }
}
