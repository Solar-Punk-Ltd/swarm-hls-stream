import { Request, Response, Router } from 'express';

import { StreamOrchestrator } from '../../libs/StreamOrchestrator.js';
import { HEALTH_OK } from '../../types.js';
import { deriveHealthStatus } from '../../utils/health.js';

const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;

export function createHealthRouter(streamOrchestrator: StreamOrchestrator, engineNames: string[]): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    const signals = streamOrchestrator.getHealthSignals();
    const { status, reasons } = deriveHealthStatus(signals, streamOrchestrator.getSegmentStallMs());

    res.status(status === HEALTH_OK ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE).json({
      status,
      reasons,
      ...signals,
      engines: engineNames,
      // Static config rather than a signal, and here because this is the one place an operator and
      // the e2e preflight both already read. It is what tells a stage with one Bee node per rung
      // apart from a stage pushing every rung through one, which nothing outside the process could
      // see before. See BeePublisherPool.routing for what is and is not safe to say here.
      publishers: streamOrchestrator.publisherRouting(),
      // Which of those has stopped paying, beside the list of all of them, because `postage_refused`
      // on its own leaves an operator four rungs to go and read. Empty on a healthy service.
      refusedPublishers: streamOrchestrator.refusedPublishers(),
    });
  });

  return router;
}
