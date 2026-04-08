import express from 'express';
import http from 'http';

import { EnginePlugin } from '../engines/types.js';
import { Logger } from '../libs/Logger.js';
import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';

import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { requestLogger } from './middleware/requestLogger.js';
import { createHealthRouter } from './routes/health.js';
import { createStreamRouter } from './routes/stream.js';

const logger = Logger.getInstance();

export interface ApiServerHandle {
  close(): Promise<void>;
}

export function startApiServer(
  streamOrchestrator: StreamOrchestrator,
  port: number,
  engines: EnginePlugin[] = [],
): ApiServerHandle {
  const app = express();

  // Global middleware
  app.use(requestLogger);
  app.use('/stream/segment', express.raw({ type: '*/*', limit: '50mb' }));
  app.use(express.json());

  // Engine plugin routers
  for (const engine of engines) {
    app.use(engine.prefix, engine.createRouter(streamOrchestrator));
    logger.info(`[ApiServer] Engine mounted: ${engine.name} at ${engine.prefix}`);
  }

  // Core routes
  app.use('/stream', createStreamRouter(streamOrchestrator));
  app.use(
    '/health',
    createHealthRouter(
      streamOrchestrator,
      engines.map((e) => e.name),
    ),
  );

  // 404 + error handling
  app.use(notFound);
  app.use(errorHandler);

  const server = http.createServer(app);

  server.listen(port, () => {
    logger.info(`[ApiServer] Listening on port ${port}`);
  });

  return {
    async close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            logger.info('[ApiServer] Server closed');
            resolve();
          }
        });
      });
    },
  };
}
