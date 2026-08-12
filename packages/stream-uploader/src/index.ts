import { PrivateKey } from '@ethersphere/bee-js';

import { ApiServerHandle, startApiServer } from './api/server.js';
import { engineRegistry } from './engines/registry.js';
import { EnginePlugin } from './engines/types.js';
import { BeePublisherPool } from './libs/BeePublisherPool.js';
import { Logger } from './libs/Logger.js';
import { MasterFeedWriter } from './libs/MasterFeedWriter.js';
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
    const recoveryStore = new RecoveryStore(config.stateDir);

    // Only with the ladder on. A single-rendition stream has nothing to be multivariant about, and
    // publishing a one-entry master for it would buy a second feed and no choice.
    const masterWriter = config.abr ? new MasterFeedWriter(publishers, new PrivateKey(config.streamKey)) : undefined;

    const streamCatalog = new StreamCatalog(publishers, config.streamKey, config.streamListTopic, masterWriter);
    await streamCatalog.init();

    streamOrchestrator = new StreamOrchestrator(publishers, streamCatalog, recoveryStore, {
      streamKey: config.streamKey,
      manifestBeeUrl: config.manifestAccessUrl,
      maxQueueSize: config.maxQueueSize,
      recoveryTimeout: config.recoveryTimeout,
      segmentRedundancy: config.segmentRedundancy,
      ladder: config.abr?.ladder,
    });

    await streamOrchestrator.recoverStreams();

    const engines = loadEngines();
    apiServer = startApiServer(streamOrchestrator, config.apiPort, engines);
    logger.info('Stream uploader started — waiting for engine connections');
  } catch (error) {
    logger.error('Failed to start:', error);
    process.exit(1);
  }
}

start();
