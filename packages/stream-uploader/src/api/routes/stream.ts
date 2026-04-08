import { Request, Response, Router } from 'express';

import { Logger } from '../../libs/Logger.js';
import { StreamOrchestrator } from '../../libs/StreamOrchestrator.js';
import { REJECT_QUEUE_FULL, REJECT_UNKNOWN_STREAM } from '../../types.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ApiError } from '../middleware/errorHandler.js';

const logger = Logger.getInstance();

const RETRY_AFTER_SECONDS = '2';

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

      throw new ApiError(500, 'Unexpected error');
    }),
  );

  router.post(
    '/stop',
    asyncHandler(async (req: Request, res: Response) => {
      const { streamId } = req.body;

      if (!streamId) {
        throw new ApiError(400, 'streamId is required');
      }

      // Respond immediately, drain in background
      res.json({ ok: true });

      streamOrchestrator.stopStream(streamId).catch((error) => {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`Error during stream stop ${streamId}: ${msg}`);
      });
    }),
  );

  return router;
}
