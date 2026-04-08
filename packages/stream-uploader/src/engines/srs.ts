import { Request, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';

import { Logger } from '../libs/Logger.js';
import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';
import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MediaType } from '../types.js';

import { EnginePlugin } from './types.js';

const logger = Logger.getInstance();

// SRS webhook response codes
const SRS_ACCEPT = '0';
const SRS_REJECT = '1';

// SRS webhook actions
const SRS_ACTION_PUBLISH = 'on_publish';
const SRS_ACTION_UNPUBLISH = 'on_unpublish';
const SRS_ACTION_HLS = 'on_hls';

type SrsStreamAction = typeof SRS_ACTION_PUBLISH | typeof SRS_ACTION_UNPUBLISH;
type SrsHlsAction = typeof SRS_ACTION_HLS;

interface SrsStreamPayload {
  action: SrsStreamAction;
  app: string;
  stream: string;
}

interface SrsHlsPayload {
  action: SrsHlsAction;
  app: string;
  stream: string;
  file: string;
  seq_no: number;
  duration: number;
}

function srsResponse(res: Response, code: string): void {
  res.type('json').send(code);
}

function buildStreamId(app: string, stream: string): string {
  return `${app}/${stream}`;
}

export function createSrsEngine(mediaRootPath: string): EnginePlugin {
  return {
    name: 'srs',
    prefix: '/engines/srs',

    createRouter(streamOrchestrator: StreamOrchestrator): Router {
      const router = Router();

      router.post('/streams', (req: Request, res: Response) => {
        handleStreams(req, res, streamOrchestrator);
      });

      router.post('/hls', (req: Request, res: Response) => {
        handleHls(req, res, streamOrchestrator, mediaRootPath);
      });

      return router;
    },
  };
}

function resolveMediaType(app: string): MediaType {
  return app === MEDIA_TYPE_AUDIO ? MEDIA_TYPE_AUDIO : MEDIA_TYPE_VIDEO;
}

function handleStreams(req: Request, res: Response, streamOrchestrator: StreamOrchestrator): void {
  try {
    const payload = req.body as SrsStreamPayload;
    const streamId = buildStreamId(payload.app, payload.stream);

    if (payload.action === SRS_ACTION_UNPUBLISH) {
      logger.info(`[SRS] Stream unpublished: ${streamId}`);
      srsResponse(res, SRS_ACCEPT);

      streamOrchestrator.stopStream(streamId).catch((error) => {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[SRS] Error during stream stop ${streamId}: ${msg}`);
      });
      return;
    }

    if (payload.action !== SRS_ACTION_PUBLISH) {
      srsResponse(res, SRS_ACCEPT);
      return;
    }

    const mediatype = resolveMediaType(payload.app);
    logger.info(`[SRS] Stream published: ${streamId} (${mediatype})`);

    const accepted = streamOrchestrator.startStream(streamId, mediatype);
    srsResponse(res, accepted ? SRS_ACCEPT : SRS_REJECT);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[SRS] Stream handler error: ${msg}`);
    srsResponse(res, SRS_ACCEPT);
  }
}

function handleHls(req: Request, res: Response, streamOrchestrator: StreamOrchestrator, mediaRootPath: string): void {
  try {
    const payload = req.body as SrsHlsPayload;
    const streamId = buildStreamId(payload.app, payload.stream);

    const relativePath = payload.file.replace(/^\.\/objs\/nginx\/html\//, '');
    const segmentPath = path.resolve(mediaRootPath, relativePath);

    if (!fs.existsSync(segmentPath)) {
      logger.warn(`[SRS] Segment file not found: ${segmentPath}`);
      srsResponse(res, SRS_ACCEPT);
      return;
    }

    const segmentData = fs.readFileSync(segmentPath);
    const result = streamOrchestrator.handleSegment(streamId, payload.seq_no, payload.duration, segmentData);

    if (result.accepted) {
      fs.rmSync(segmentPath, { force: true });
    } else {
      logger.warn(`[SRS] Segment ${payload.seq_no} not accepted for ${streamId}: ${result.reason}`);
    }

    srsResponse(res, SRS_ACCEPT);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[SRS] HLS handler error: ${msg}`);
    srsResponse(res, SRS_ACCEPT);
  }
}
