import { Bee } from '@ethersphere/bee-js';
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
import { CatalogIndexStore } from './libs/CatalogIndexStore.js';
import { Logger } from './libs/Logger.js';
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

async function start() {
  try {
    const bee = new Bee(config.beeUrl);
    const recoveryStore = new RecoveryStore(config.stateDir);

    // In a subdirectory so RecoveryStore's *.json scan of stateDir never picks it up as a stream.
    const catalogIndexStore = new CatalogIndexStore(path.join(config.stateDir, 'catalog', 'feed-index.json'));
    const streamCatalog = new StreamCatalog(
      bee,
      config.streamKey,
      config.streamListTopic,
      config.stamp,
      catalogIndexStore,
    );
    await streamCatalog.init();

    const streamOrchestrator = new StreamOrchestrator(bee, streamCatalog, recoveryStore, {
      streamKey: config.streamKey,
      stamp: config.stamp,
      manifestBeeUrl: config.manifestAccessUrl,
      maxQueueSize: config.maxQueueSize,
      recoveryTimeout: config.recoveryTimeout,
      orphanReapMs: config.orphanReapMs,
      segmentStallMs: config.segmentStallMs,
      segmentDedupWindow: config.segmentDedupWindow,
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
