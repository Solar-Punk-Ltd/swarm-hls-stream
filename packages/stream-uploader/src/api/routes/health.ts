import { Request, Response, Router } from 'express';

import { StreamOrchestrator } from '../../libs/StreamOrchestrator.js';

export function createHealthRouter(streamOrchestrator: StreamOrchestrator, engineNames: string[]): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      activeStreams: streamOrchestrator.getActiveStreamCount(),
      queuePressure: streamOrchestrator.getOverallQueuePressure(),
      engines: engineNames,
    });
  });

  return router;
}
