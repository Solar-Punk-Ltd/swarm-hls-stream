import { Request, Response, Router } from 'express';

import { Logger } from '../../libs/Logger.js';
import { StreamOrchestrator } from '../../libs/StreamOrchestrator.js';
import {
  REJECT_DRAINING,
  REJECT_QUEUE_FULL,
  REJECT_UNKNOWN_STREAM,
  REJECT_UNUSABLE_DURATION,
  STREAM_LIFECYCLE_UNKNOWN,
} from '../../types.js';
import { getErrorMessage } from '../../utils/common.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ApiError } from '../middleware/errorHandler.js';
import { parseOrBadRequest } from '../schemas/parseRequest.js';
import {
  segmentHeadersSchema,
  startStreamBodySchema,
  stopStreamBodySchema,
  streamStatusQuerySchema,
} from '../schemas/streamRequests.js';

const logger = Logger.getInstance();

const RETRY_AFTER_SECONDS = '2';

/** Handed back by `POST /stream/stop`, so a caller does not have to know the route to poll. */
const STATUS_PATH = '/stream/status';

export function createStreamRouter(streamOrchestrator: StreamOrchestrator): Router {
  const router = Router();

  router.post(
    '/start',
    asyncHandler(async (req: Request, res: Response) => {
      const { streamId, mediatype } = parseOrBadRequest(startStreamBodySchema, req.body);

      streamOrchestrator.startStream(streamId, mediatype);
      res.json({ ok: true });
    }),
  );

  router.post(
    '/segment',
    asyncHandler(async (req: Request, res: Response) => {
      const headers = parseOrBadRequest(segmentHeadersSchema, req.headers);
      const streamId = headers['x-stream-id'];
      const segmentIndex = headers['x-segment-index'];
      const duration = headers['x-duration'];

      const data = Buffer.from(req.body);
      const result = streamOrchestrator.handleSegment(streamId, segmentIndex, duration, data);

      if (result.accepted) {
        res.json({ ok: true, queued: true });
        return;
      }

      if (result.reason === REJECT_QUEUE_FULL) {
        throw new ApiError(429, 'Queue full', RETRY_AFTER_SECONDS);
      }

      if (result.reason === REJECT_UNKNOWN_STREAM) {
        throw new ApiError(404, `Unknown stream: ${streamId}`);
      }

      // Not 404, because the stream exists, and not 429, because no amount of waiting reopens a
      // manifest that has been committed. The sender's copy is the only one left, so say so.
      if (result.reason === REJECT_DRAINING) {
        throw new ApiError(409, `Stream is finalizing and accepts no more segments: ${streamId}`);
      }

      // 400 rather than 409 or 429: no retry of the same request can succeed, because what is wrong
      // is the value the sender declared.
      if (result.reason === REJECT_UNUSABLE_DURATION) {
        throw new ApiError(400, `x-duration is not a usable segment length: ${req.headers['x-duration']}`);
      }

      throw new ApiError(500, 'Unexpected error');
    }),
  );

  /**
   * Answered before the drain runs, because a drain has five minutes to publish its VOD and no media
   * server's webhook will hold a connection that long. `202` rather than `200` says so, and the
   * outcome is read back from `GET /stream/status`.
   *
   * Until that existed, a stop that failed and one that worked were the same response: the drain
   * caught its own failure, so even the rejection this handler is watching for never arrived.
   */
  router.post(
    '/stop',
    asyncHandler(async (req: Request, res: Response) => {
      const { streamId } = parseOrBadRequest(stopStreamBodySchema, req.body);

      res.status(202).json({ ok: true, accepted: true, streamId, statusUrl: STATUS_PATH });

      streamOrchestrator.stopStream(streamId).catch((error) => {
        const msg = getErrorMessage(error);
        logger.error(`Error during stream stop ${streamId}: ${msg}`);
      });
    }),
  );

  router.get(
    '/status',
    asyncHandler(async (req: Request, res: Response) => {
      const { streamId } = parseOrBadRequest(streamStatusQuerySchema, req.query);

      const report = streamOrchestrator.getStreamStatus(streamId);

      // A stream nobody has heard of is a 404 rather than a state, so a caller polling a typo is not
      // told its broadcast is fine. It is also what a caller sees for a stop settled longer ago than
      // the outcome is kept, which is why the window is far wider than the drain deadline.
      if (report.state === STREAM_LIFECYCLE_UNKNOWN) {
        throw new ApiError(404, `Unknown stream: ${streamId}`);
      }

      res.json(report);
    }),
  );

  return router;
}
