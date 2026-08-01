import { Request, Response, Router } from 'express';

import { StreamOrchestrator } from '../../libs/StreamOrchestrator.js';
import { METRICS_CONTENT_TYPE, renderPrometheusMetrics } from '../../utils/metricsFormat.js';

/**
 * Prometheus exposition of totals that outlive the streams they describe.
 *
 * Mounted behind the same bearer gate as `/stream/*`, unlike `/health`. It reports when the last
 * segment landed and how many broadcasts have run, which is more than a liveness probe needs to give
 * away, and a scraper authenticates with one line of configuration.
 */
export function createMetricsRouter(streamOrchestrator: StreamOrchestrator): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.type(METRICS_CONTENT_TYPE).send(renderPrometheusMetrics(streamOrchestrator.getMetricsSnapshot()));
  });

  return router;
}
