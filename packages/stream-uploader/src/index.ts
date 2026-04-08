import { Bee } from '@ethersphere/bee-js';

import { ApiServerHandle, startApiServer } from './api/server.js';
import { createSrsEngine } from './engines/srs.js';
import { EnginePlugin } from './engines/types.js';
import { Logger } from './libs/Logger.js';
import { RecoveryStore } from './libs/RecoveryStore.js';
import { StreamCatalog } from './libs/StreamCatalog.js';
import { StreamOrchestrator } from './libs/StreamOrchestrator.js';
import { config } from './utils/config.js';

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
  const engines: EnginePlugin[] = [];

  if (config.engine === 'srs') {
    engines.push(createSrsEngine(config.mediaPath));
    logger.info(`[Engine] SRS engine loaded, media path: ${config.mediaPath}`);
  } else if (config.engine && config.engine !== 'none') {
    logger.warn(`[Engine] Unknown engine: ${config.engine}, running with generic API only`);
  }

  return engines;
}

async function start() {
  try {
    const bee = new Bee(config.beeUrl);
    const recoveryStore = new RecoveryStore(config.stateDir);

    const streamCatalog = new StreamCatalog(bee, config.streamKey, config.streamListTopic, config.stamp);
    await streamCatalog.init();

    streamOrchestrator = new StreamOrchestrator(bee, streamCatalog, recoveryStore, {
      streamKey: config.streamKey,
      stamp: config.stamp,
      manifestBeeUrl: config.manifestAccessUrl,
      maxQueueSize: config.maxQueueSize,
      recoveryTimeout: config.recoveryTimeout,
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
