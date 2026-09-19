import { NextFunction, Request, RequestHandler, Response } from 'express';

import { NodeWaitReport } from '../../types.js';

import { ApiErrorResponse } from './errorHandler.js';

const HTTP_SERVICE_UNAVAILABLE = 503;

/**
 * How long a caller is asked to wait before trying again.
 *
 * Five seconds against a boot that is itself backing off up to thirty: short enough that an engine
 * is back within a few seconds of the node answering, long enough that a publisher retrying in a
 * loop is not one more thing happening to a stage that is already unwell.
 */
const RETRY_AFTER_SECONDS = '5';

/**
 * Refuse the routes that need a node behind them while the boot is still waiting for one.
 *
 * ## Why a refusal rather than letting the request through
 *
 * The orchestrator exists from the first second now, so a request that arrives during the wait
 * reaches a real object whose catalog has never been read. `startStream` would take it, a broadcast
 * would run, and nothing would announce it: the entry a viewer finds a stream by is written from the
 * feed index that `StreamCatalog.init` had not yet loaded. That is worse than a refusal in the way
 * that matters most here, because it is silent, and it is the failure that made this a middleware
 * rather than a note in the route.
 *
 * `/health` is deliberately outside it. A probe asking what is wrong must be answered while this is
 * on, and it is the one endpoint that reports the waiting state rather than being stopped by it.
 * `/metrics` is outside it too: its counters are facts about this process rather than about the node,
 * and a scraper losing them exactly while something is wrong loses them when they were most useful.
 */
export function refuseWhileWaiting(waitingForNode: () => NodeWaitReport | null): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const waiting = waitingForNode();
    if (waiting === null) {
      next();
      return;
    }

    const response: ApiErrorResponse = {
      ok: false,
      error: `The uploader is waiting for its Bee node at ${waiting.url}, so it cannot take this yet`,
      statusCode: HTTP_SERVICE_UNAVAILABLE,
    };

    res.status(HTTP_SERVICE_UNAVAILABLE).set('Retry-After', RETRY_AFTER_SECONDS).json(response);
  };
}
