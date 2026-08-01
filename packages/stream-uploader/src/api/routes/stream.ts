import { Request, Response, Router } from 'express';

import { Logger } from '../../libs/Logger.js';
import { StreamOrchestrator } from '../../libs/StreamOrchestrator.js';
import { REJECT_DRAINING, REJECT_QUEUE_FULL, REJECT_UNKNOWN_STREAM, STREAM_LIFECYCLE_UNKNOWN } from '../../types.js';
import { getErrorMessage } from '../../utils/common.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ApiError } from '../middleware/errorHandler.js';

const logger = Logger.getInstance();

const RETRY_AFTER_SECONDS = '2';

/** Handed back by `POST /stream/stop`, so a caller does not have to know the route to poll. */
const STATUS_PATH = '/stream/status';

export function createStreamRouter(streamOrchestrator: StreamOrchestrator): Router {
  const router = Router();

  router.post(
    '/start',
    asyncHandler(async (req: Request, res: Response) => {
      const { streamId, mediatype } = req.body;

      if (!streamId || !mediatype) {
        throw new ApiError(400, 'streamId and mediatype are required');
      }

      streamOrchestrator.startStream(streamId, mediatype);
      res.json({ ok: true });
    }),
  );

  router.post(
    '/segment',
    asyncHandler(async (req: Request, res: Response) => {
      const streamId = req.headers['x-stream-id'] as string;
      const segmentIndex = parseInt(req.headers['x-segment-index'] as string, 10);
      const duration = parseFloat(req.headers['x-duration'] as string);

      if (!streamId || isNaN(segmentIndex) || isNaN(duration)) {
        throw new ApiError(400, 'x-stream-id, x-segment-index, x-duration headers are required');
      }

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
      const { streamId } = req.body;

      if (!streamId) {
        throw new ApiError(400, 'streamId is required');
      }

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
      const streamId = req.query.streamId;

      if (typeof streamId !== 'string' || streamId.length === 0) {
        throw new ApiError(400, 'streamId query parameter is required');
      }

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
