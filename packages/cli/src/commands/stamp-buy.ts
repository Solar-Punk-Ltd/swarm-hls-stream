import { createBee } from '../lib/bee-client.js';
import { loadEnv, NamedTarget, resolvePublisherTargets } from '../lib/config-reader.js';
import { selectPublisherByRung } from '../lib/nodes.js';
import { error, header, info, table } from '../lib/output.js';
import { buyStamp, resolveStampOptions } from '../lib/stamp.js';

/**
 * Buys one batch, on the node that publishes one named rung.
 *
 * The rung comes first and is required — `pnpm stamp:buy 360p` — because a batch is only spendable
 * by the node that bought it. Buying blind and configuring the id somewhere else is the mistake this
 * shape prevents.
 *
 * Nothing is written to `.env`. The batch id is printed in the form BEE_PUBLISHERS wants and putting
 * it there is the operator's job, so a config change is always something a person did on purpose.
 *
 * Amount and depth are the same for every rung. Sizing a batch to the rung it pays for is a real
 * concern — 1080p exhausts a given depth roughly 7x sooner than 360p — and is deliberately not done
 * here.
 */
export async function stampBuy(
  urlOverride?: string,
  rung?: string,
  amount?: string,
  depth?: number,
  immutable?: boolean,
): Promise<void> {
  loadEnv();

  let publisher: NamedTarget;
  try {
    publisher = selectPublisherByRung(resolvePublisherTargets(), rung);
  } catch (err) {
    error(err instanceof Error ? err.message : 'Unknown rung');
    process.exit(1);
  }

  // The rung picks which publisher; --url only changes where to reach it, for a tunnel or a
  // port-forward. The line printed at the end always names the configured URL, not the override.
  const configuredUrl = publisher.target!.url;
  const url = urlOverride ?? configuredUrl;
  const options = resolveStampOptions(amount, depth, immutable);

  header(`Buy stamp for rung ${publisher.rung} (${url})`);
  info(`Amount: ${options.amount}, Depth: ${options.depth}, Immutable: ${options.immutable}`);
  console.log('');

  try {
    const batchIdHex = await buyStamp(createBee(url), options);

    table('Batch ID', batchIdHex);
    console.log('');
    info('Put it in BEE_PUBLISHERS, replacing this rung’s entry:');
    info(`  ${publisher.rung}@${configuredUrl}#${batchIdHex}`);
  } catch (err) {
    error(`Failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exit(1);
  }
}
