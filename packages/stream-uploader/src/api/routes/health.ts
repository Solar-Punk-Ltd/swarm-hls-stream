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
    });
  });

  return router;
}
