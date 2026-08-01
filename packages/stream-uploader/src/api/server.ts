import express from 'express';
import http from 'http';

import { EnginePlugin, RawBodyRequest } from '../engines/types.js';
import { Logger } from '../libs/Logger.js';
import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';

import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { createAuthRejectionObserver } from './middleware/observeAuthRejections.js';
import { requestLogger } from './middleware/requestLogger.js';
import { createAuthMiddleware } from './middleware/requireAuth.js';
import { createHealthRouter } from './routes/health.js';
import { createMetricsRouter } from './routes/metrics.js';
import { createStreamRouter } from './routes/stream.js';

const logger = Logger.getInstance();

export interface ApiServerHandle {
  close(): Promise<void>;
}

export interface ApiAppOptions {
  /** Shared bearer token for the control and ingest routes. Not optional: there is no unauthenticated mode. */
  authToken: string;
  engines?: EnginePlugin[];
}

export function createApiApp(streamOrchestrator: StreamOrchestrator, options: ApiAppOptions): express.Express {
  const { authToken, engines = [] } = options;
  const app = express();

  // Global middleware
  app.use(requestLogger);
  // Ahead of every gate, so the refusal is counted whichever one answers. See OBS-15.
  app.use(createAuthRejectionObserver(() => streamOrchestrator.recordAuthRejection()));

  // Ahead of the body parsers on purpose. Behind them, an anonymous caller gets 50MB of process
  // memory allocated per connection before the gate can refuse: measured at 117MB to 583MB of RSS
  // for eight concurrent unauthenticated bodies, with the 401 arriving only once each was fully
  // read. `/health` is outside the gate deliberately, as a liveness endpoint that
  // `deploy/scripts/health.sh` reads, which accepts no input and spends nothing.
  app.use('/stream', createAuthMiddleware(authToken));
  // `/metrics` names when the last segment landed and how many broadcasts have run, which is more
  // than a liveness probe should give away, so it is gated where `/health` is not.
  app.use('/metrics', createAuthMiddleware(authToken));

  // Same reason, for the engine webhooks. Without this the engine's own router-level gate still
  // refuses the request, but only after express.json has read and parsed the body, so an anonymous
  // caller gets a 500 from the parser instead of a 401 and can drive unhandled-error lines into the
  // log at will. Each engine also gates its own router, so this is the resource guard rather than
  // the authorization guard.
  for (const engine of engines) {
    const gate = engine.createAuthMiddleware?.();
    if (gate) {
      app.use(engine.prefix, gate);
    }
  }

  app.use('/stream/segment', express.raw({ type: '*/*', limit: '50mb' }));
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf;
      },
    }),
  );

  // Engine plugin routers
  for (const engine of engines) {
    app.use(engine.prefix, engine.createRouter(streamOrchestrator));
    logger.info(`[ApiServer] Engine mounted: ${engine.name} at ${engine.prefix}`);
  }

  // Core routes
  app.use('/stream', createStreamRouter(streamOrchestrator));
  app.use('/metrics', createMetricsRouter(streamOrchestrator));
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

  return app;
}

export function startApiServer(
  streamOrchestrator: StreamOrchestrator,
  port: number,
  options: ApiAppOptions,
): ApiServerHandle {
  const server = http.createServer(createApiApp(streamOrchestrator, options));

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
