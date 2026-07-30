import { NextFunction, Request, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';

import { Logger } from '../libs/Logger.js';
import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';
import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MediaType } from '../types.js';
import { getErrorMessage } from '../utils/common.js';
import { optional, required } from '../utils/env.js';

import { assertUsableWebhookToken, hasValidWebhookToken } from './srs/webhookToken.js';
import { EnginePlugin } from './types.js';

const logger = Logger.getInstance();

export interface SrsEngineOptions {
  /** Shared secret SRS carries in its hook URL. Empty rejects every webhook, it does not disable the check. */
  webhookToken?: string;
}

// SRS webhook response codes
const SRS_ACCEPT = 0;
const SRS_REJECT = 1;

// SRS webhook actions
const SRS_ACTION_PUBLISH = 'on_publish';
const SRS_ACTION_UNPUBLISH = 'on_unpublish';
const SRS_ACTION_HLS = 'on_hls';

// `on_hls` reports `file` as SRS sees it, relative to its own working directory and under the
// default `hls_path`. The uploader reaches the same segment through its own mount of that volume,
// so only the part below the prefix is meaningful here.
const SRS_HLS_PATH_PREFIX = /^\.\/objs\/nginx\/html\//;

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

function srsResponse(res: Response, code: number): void {
  res.json(code);
}

function buildStreamId(app: string, stream: string): string {
  return `${app}/${stream}`;
}

export function createSrsEngineFromEnv(): EnginePlugin {
  const mediaPath = optional('SRS_MEDIA_PATH', './media');
  // Read before the log line, so a deployment missing it stops rather than reporting success first.
  const webhookToken = required('SRS_WEBHOOK_TOKEN');
  logger.info(`[Engine] SRS engine loaded, media path: ${mediaPath}`);
  return createSrsEngine(mediaPath, { webhookToken });
}

export function createSrsEngine(mediaRootPath: string, options: SrsEngineOptions = {}): EnginePlugin {
  const webhookToken = options.webhookToken ?? '';
  if (webhookToken) {
    assertUsableWebhookToken(webhookToken);
  }

  return {
    name: 'srs',
    prefix: '/engines/srs',

    createRouter(streamOrchestrator: StreamOrchestrator): Router {
      const router = Router();

      // SRS cannot sign its callbacks and cannot send a header, so the credential travels in the hook
      // URL that entrypoint.sh writes into srs.conf. Mounted on the router rather than in each
      // handler, so a webhook added later is covered without whoever adds it remembering.
      router.use((req: Request, res: Response, next: NextFunction) => {
        if (!hasValidWebhookToken(req, webhookToken)) {
          logger.warn(`[SRS] Rejected webhook with missing or invalid token from ${req.ip}`);
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        next();
      });

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
        const msg = getErrorMessage(error);
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
    const msg = getErrorMessage(error);
    logger.error(`[SRS] Stream handler error: ${msg}`);
    srsResponse(res, SRS_ACCEPT);
  }
}

/**
 * Absolute path of the segment SRS reported, or `undefined` when the reported path resolves outside
 * the media root.
 *
 * `file` arrives on an unauthenticated webhook and the caller both reads and deletes whatever it
 * names, so this is a containment boundary rather than a formatting step. Stripping the prefix is
 * not itself a defence: `path.resolve` drops the root entirely for an absolute input and walks out
 * of it for `../`, so the result is compared against the root instead of the input being screened
 * for suspicious-looking segments.
 */
export function resolveSegmentPath(mediaRootPath: string, file: string): string | undefined {
  const mediaRoot = path.resolve(mediaRootPath);
  const segmentPath = path.resolve(mediaRoot, file.replace(SRS_HLS_PATH_PREFIX, ''));

  return segmentPath.startsWith(mediaRoot + path.sep) ? segmentPath : undefined;
}

function handleHls(req: Request, res: Response, streamOrchestrator: StreamOrchestrator, mediaRootPath: string): void {
  try {
    const payload = req.body as SrsHlsPayload;
    const streamId = buildStreamId(payload.app, payload.stream);

    const segmentPath = resolveSegmentPath(mediaRootPath, payload.file);

    if (!segmentPath) {
      logger.warn(`[SRS] Rejected segment path outside the media root for ${streamId}: ${payload.file}`);
      srsResponse(res, SRS_ACCEPT);
      return;
    }

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
    const msg = getErrorMessage(error);
    logger.error(`[SRS] HLS handler error: ${msg}`);
    srsResponse(res, SRS_ACCEPT);
  }
}
