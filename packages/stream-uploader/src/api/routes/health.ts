import { Request, Response, Router } from 'express';

import { StreamOrchestrator } from '../../libs/StreamOrchestrator.js';
import { HEALTH_OK, NodeWaitReport } from '../../types.js';
import { deriveHealthStatus } from '../../utils/health.js';

const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;

/**
 * The one endpoint that answers while the boot is still waiting for its node, which is why it is the
 * one endpoint `refuseWhileWaiting` does not stop. A deploy page and a container healthcheck both
 * read this, and both need "waiting for the node at this url since then" rather than silence on a
 * closed port, which is what they got before the listener moved in front of the wait on 2026-09-17.
 */
export function createHealthRouter(
  streamOrchestrator: StreamOrchestrator,
  engineNames: string[],
  /**
   * Absent is a service whose boot has finished, which is every caller from before the uploader
   * listened ahead of its node, and every test but the two about the wait.
   */
  waitingForNode: () => NodeWaitReport | null = () => null,
): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    const waiting = waitingForNode();
    const signals = streamOrchestrator.getHealthSignals();
    const { status, reasons } = deriveHealthStatus(signals, streamOrchestrator.getSegmentStallMs(), waiting);

    res.status(status === HEALTH_OK ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE).json({
      status,
      reasons,
      // Only while it is waiting, so a healthy payload carries no field that reads as a node problem.
      // `waitingSince` sits at the top because it is what a page renders, and the rest of the wait is
      // under `node` because it describes that node rather than this service.
      ...(waiting === null
        ? {}
        : {
            waitingSince: waiting.waitingSince,
            node: { url: waiting.url, attempts: waiting.attempts, lastError: waiting.lastError },
          }),
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
