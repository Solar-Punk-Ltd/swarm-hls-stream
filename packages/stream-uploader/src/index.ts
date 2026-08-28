import { PrivateKey } from '@ethersphere/bee-js';
import path from 'path';

// Side-effect import, and it must stay ahead of every other local import. `utils/env.js` runs
// `dotenv.config()` at module scope, and anything that reads `process.env` while being imported gets
// whatever the real environment held before the `.env` file was applied. `Logger` did exactly that,
// through `utils/common.js`, so `LOG_LEVEL` in the root `.env` was read too late and ignored, with
// no way for an operator to tell. `simple-import-sort` places side-effect imports ahead of the
// relative groups, so the ordering this depends on is the one the linter already enforces, and
// `test/envLoadOrder.test.ts` fails if it stops holding.
import './utils/env.js';

import { startApiServer } from './api/server.js';
import { loadEngines } from './engines/load.js';
import { BeePublisherPool } from './libs/BeePublisherPool.js';
import { CatalogIndexStore } from './libs/CatalogIndexStore.js';
import { bzzToPlur, ChequebookGate } from './libs/ChequebookGate.js';
import { Logger } from './libs/Logger.js';
import { MasterFeedWriter } from './libs/MasterFeedWriter.js';
import { registerCrashHandlers, registerShutdownSignals } from './libs/processSignals.js';
import { RecoveryStore } from './libs/RecoveryStore.js';
import { ServiceLifecycle } from './libs/ServiceLifecycle.js';
import { StreamCatalog } from './libs/StreamCatalog.js';
import { StreamOrchestrator } from './libs/StreamOrchestrator.js';
import { config } from './utils/config.js';

const logger = Logger.getInstance();
const lifecycle = new ServiceLifecycle((code) => process.exit(code), logger);

registerShutdownSignals(lifecycle);
registerCrashHandlers(logger);

/**
 * Which Bee nodes this stage publishes through.
 *
 * BEE_PUBLISHERS unset is the single-node deployment: one node, one batch, everything through it.
 * Set, it is one node per rung, and every rung of ABR_LADDER must appear — which only means
 * anything with a ladder to map onto, hence the refusal below rather than silently ignoring it.
 */
function buildPublishers(): BeePublisherPool {
  if (config.publishers.length === 0) {
    return BeePublisherPool.single(config.beeUrl, config.stamp);
  }

  if (!config.abr) {
    throw new Error('BEE_PUBLISHERS is set but ABR_ENABLED is false — per-rung publishers have no ladder to map onto');
  }

  return BeePublisherPool.perRung(
    config.publishers,
    config.abr.ladder.rungs().map((rung) => rung.name),
  );
}

async function start() {
  try {
    const publishers = buildPublishers();

    // First, ahead of recovery and the engines, because a dry chequebook is silent: the node answers
    // /health normally and stalls every paid push behind an allowance that never arrives. Refusing
    // here costs a restart. Reaching the engines first costs a broadcast that looks live and uploads
    // nothing. See ChequebookGate for the full account.
    await new ChequebookGate(publishers.nodes(), bzzToPlur(config.chequebookMinBzz), logger).assertFunded();

    const recoveryStore = new RecoveryStore(config.stateDir);

    // In a subdirectory so RecoveryStore's *.json scan of stateDir never picks it up as a stream.
    const catalogIndexStore = new CatalogIndexStore(path.join(config.stateDir, 'catalog', 'feed-index.json'));

    // Only with the ladder on. A single-rendition stream has nothing to be multivariant about, and
    // publishing a one-entry master for it would buy a second feed and no choice.
    const masterWriter = config.abr ? new MasterFeedWriter(publishers, new PrivateKey(config.streamKey)) : undefined;

    const streamCatalog = new StreamCatalog(
      publishers,
      config.streamKey,
      config.streamListTopic,
      catalogIndexStore,
      masterWriter,
    );
    await streamCatalog.init();

    const streamOrchestrator = new StreamOrchestrator(publishers, streamCatalog, recoveryStore, {
      streamKey: config.streamKey,
      maxQueueSize: config.maxQueueSize,
      recoveryTimeout: config.recoveryTimeout,
      orphanReapMs: config.orphanReapMs,
      segmentStallMs: config.segmentStallMs,
      segmentDedupWindow: config.segmentDedupWindow,
      segmentRedundancy: config.segmentRedundancy,
      ladder: config.abr?.ladder,
    });

    lifecycle.trackOrchestrator(streamOrchestrator);
    const recoveredStreamIds = await streamOrchestrator.recoverStreams();

    const engines = loadEngines(config.engine);
    const apiServer = startApiServer(streamOrchestrator, config.apiPort, {
      authToken: config.apiAuthToken,
      engines,
    });
    lifecycle.trackApiServer(apiServer);

    // An engine that pulls segments itself must re-attach its fetch loop to recovered streams.
    // Otherwise the recovered stream produces no segments and is finalized as VOD at the timeout.
    for (const streamId of recoveredStreamIds) {
      for (const engine of engines) {
        engine.resumeRecoveredStream?.(streamOrchestrator, streamId);
      }
    }

    logger.info('Stream uploader started — waiting for engine connections');
  } catch (error) {
    logger.error('Failed to start:', error);
    process.exit(1);
  }
}

start();
