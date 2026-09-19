import express from 'express';
import http from 'http';

import { EnginePlugin, RawBodyRequest } from '../engines/types.js';
import { Logger } from '../libs/Logger.js';
import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';
import { NodeWaitReport } from '../types.js';

import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { createAuthRejectionObserver } from './middleware/observeAuthRejections.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { refuseWhileWaiting } from './middleware/refuseWhileWaiting.js';
import { requestLogger } from './middleware/requestLogger.js';
import { createAuthMiddleware } from './middleware/requireAuth.js';
import { createHealthRouter } from './routes/health.js';
import { createMetricsRouter } from './routes/metrics.js';
import { createStreamRouter } from './routes/stream.js';
import {
  DEFAULT_REQUEST_LIMITS,
  GLOBAL_RATE_KEY,
  MAX_CONTROL_BODY,
  MAX_SEGMENT_BODY,
  RequestLimits,
  segmentRateKey,
} from './requestLimits.js';

const logger = Logger.getInstance();

export interface ApiServerHandle {
  close(): Promise<void>;
}

interface ApiAppOptions {
  /** Shared bearer token for the control and ingest routes. Not optional: there is no unauthenticated mode. */
  authToken: string;
  engines?: EnginePlugin[];
  /** Overridden by tests, which drive a rate they configure rather than trying to exceed the real one. */
  limits?: RequestLimits;
  /**
   * What the boot is still waiting for, or null once it has finished.
   *
   * A function rather than a value because the app is built once, in the first second, and the answer
   * changes underneath it when the node finally answers. Omitted, the service is ready from its first
   * request, which is what every caller before D16 assumed and what every API test but the two about
   * the wait still drives.
   */
  waitingForNode?: () => NodeWaitReport | null;
}

export function createApiApp(streamOrchestrator: StreamOrchestrator, options: ApiAppOptions): express.Express {
  const { authToken, engines = [], limits = DEFAULT_REQUEST_LIMITS, waitingForNode = () => null } = options;
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

  // Behind the credential gates and ahead of everything that costs anything: a caller arriving while
  // the boot is still waiting for its node is told so before a rate limiter counts it or a parser
  // reads its body. `/health` is left out on purpose, as the endpoint that reports the wait, and so
  // is `/metrics`, whose counters describe this process rather than the node. See the middleware.
  const waitingGate = refuseWhileWaiting(waitingForNode);
  app.use('/stream', waitingGate);
  for (const engine of engines) {
    app.use(engine.prefix, waitingGate);
  }

  // Behind the gate, so an anonymous flood is refused by the cheaper check and cannot spend the
  // authenticated caller's budget, and ahead of the body parsers, so a refused request is answered
  // before its body is read. The global limit is mounted first on purpose: it is what bounds how
  // many distinct keys the per-stream limiter can hold inside one window.
  app.use(
    '/stream',
    createRateLimiter({
      windowMs: limits.windowMs,
      max: limits.globalMax,
      keyOf: () => GLOBAL_RATE_KEY,
      message: 'Too many requests',
    }),
  );
  app.use(
    '/stream/segment',
    createRateLimiter({
      windowMs: limits.windowMs,
      max: limits.perStreamMax,
      keyOf: segmentRateKey,
      // Deliberately not the wording of a full queue. Too fast and too deep are different faults
      // with different remedies, and `/stream/segment` already answers 429 `Queue full` from
      // backpressure, so a caller that cannot tell them apart will retry into the wrong one.
      message: 'Too many segments for this stream',
    }),
  );

  app.use('/stream/segment', express.raw({ type: '*/*', limit: MAX_SEGMENT_BODY }));
  app.use(
    express.json({
      limit: MAX_CONTROL_BODY,
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
      waitingForNode,
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
