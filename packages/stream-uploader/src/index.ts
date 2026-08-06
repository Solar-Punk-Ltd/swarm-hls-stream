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

import { ApiServerHandle, startApiServer } from './api/server.js';
import { engineRegistry } from './engines/registry.js';
import { EnginePlugin } from './engines/types.js';
import { CatalogIndexStore } from './libs/CatalogIndexStore.js';
import { Logger } from './libs/Logger.js';
import { RecoveryStore } from './libs/RecoveryStore.js';
import { StreamCatalog } from './libs/StreamCatalog.js';
import { StreamOrchestrator } from './libs/StreamOrchestrator.js';
import { config } from './utils/config.js';
import { loadEngineEnv } from './utils/env.js';

const logger = Logger.getInstance();

let apiServer: ApiServerHandle | undefined;
let streamOrchestrator: StreamOrchestrator | undefined;
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress...');
    return;
  }

  isShuttingDown = true;
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  try {
    if (streamOrchestrator) {
      await streamOrchestrator.cleanup();
      logger.info('All streams stopped');
    }

    if (apiServer) {
      await apiServer.close();
      apiServer = undefined;
    }

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', JSON.stringify(promise, null, 2));
  logger.error('Rejection reason:', reason);
  if (reason instanceof Error) {
    logger.error('Error stack:', reason.stack);
  }
});

function loadEngines(): EnginePlugin[] {
  const createEngine = engineRegistry[config.engine];

  if (createEngine) {
    loadEngineEnv(config.engine);
    return [createEngine()];
  }

  if (config.engine && config.engine !== 'none') {
    logger.warn(`[Engine] Unknown engine: ${config.engine}, running with generic API only`);
  }

  return [];
}

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

    streamOrchestrator = new StreamOrchestrator(bee, streamCatalog, recoveryStore, {
      streamKey: config.streamKey,
      stamp: config.stamp,
      manifestBeeUrl: config.manifestAccessUrl,
      maxQueueSize: config.maxQueueSize,
      recoveryTimeout: config.recoveryTimeout,
      orphanReapMs: config.orphanReapMs,
      segmentStallMs: config.segmentStallMs,
      segmentDedupWindow: config.segmentDedupWindow,
    });

    const recoveredStreamIds = await streamOrchestrator.recoverStreams();

    const engines = loadEngines();
    apiServer = startApiServer(streamOrchestrator, config.apiPort, { authToken: config.apiAuthToken, engines });

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
