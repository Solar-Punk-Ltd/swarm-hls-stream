import { Request, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';

import { AbrLadder } from '../libs/AbrLadder.js';
import { Logger } from '../libs/Logger.js';
import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';
import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MediaType } from '../types.js';
import { getErrorMessage } from '../utils/common.js';
import { config } from '../utils/config.js';
import { optional } from '../utils/env.js';

import { EnginePlugin } from './types.js';

const logger = Logger.getInstance();

// SRS webhook response codes
const SRS_ACCEPT = 0;
const SRS_REJECT = 1;

// SRS webhook actions
const SRS_ACTION_PUBLISH = 'on_publish';
const SRS_ACTION_UNPUBLISH = 'on_unpublish';
const SRS_ACTION_HLS = 'on_hls';

type SrsStreamAction = typeof SRS_ACTION_PUBLISH | typeof SRS_ACTION_UNPUBLISH;
type SrsHlsAction = typeof SRS_ACTION_HLS;

interface SrsStreamPayload {
  action: SrsStreamAction;
  vhost: string;
  app: string;
  stream: string;
}

interface SrsHlsPayload {
  action: SrsHlsAction;
  vhost: string;
  app: string;
  stream: string;
  file: string;
  seq_no: number;
  duration: number;
}

/** The vhost the ladder's rungs are republished onto, and the rungs to expect there. */
interface AbrGuard {
  vhost: string;
  ladder: AbrLadder;
}

function srsResponse(res: Response, code: number): void {
  res.json(code);
}

function buildStreamId(app: string, stream: string): string {
  return `${app}/${stream}`;
}

export function createSrsEngineFromEnv(): EnginePlugin {
  const mediaPath = optional('SRS_MEDIA_PATH', './media');
  logger.info(`[Engine] SRS engine loaded, media path: ${mediaPath}`);
  return createSrsEngine(mediaPath, config.abr ?? undefined);
}

export function createSrsEngine(mediaRootPath: string, abr?: AbrGuard): EnginePlugin {
  if (abr) {
    logger.info(
      `[Engine] SRS ABR ladder on vhost '${abr.vhost}': ${abr.ladder
        .rungs()
        .map((r) => r.name)
        .join(', ')}`,
    );
  }

  return {
    name: 'srs',
    prefix: '/engines/srs',

    createRouter(streamOrchestrator: StreamOrchestrator): Router {
      const router = Router();

      router.post('/streams', (req: Request, res: Response) => {
        handleStreams(req, res, streamOrchestrator, abr);
      });

      router.post('/hls', (req: Request, res: Response) => {
        handleHls(req, res, streamOrchestrator, mediaRootPath, abr);
      });

      return router;
    },
  };
}

function resolveMediaType(app: string): MediaType {
  return app === MEDIA_TYPE_AUDIO ? MEDIA_TYPE_AUDIO : MEDIA_TYPE_VIDEO;
}

/**
 * Whether this webhook is about a stream the uploader should be publishing.
 *
 * With the ladder on, only the ABR vhost carries renditions; the ingest vhost carries the
 * untranscoded source, which exists to be transcoded and nothing else. A *rendition* arriving on
 * the ingest vhost is a different matter — it means the engine's `?vhost=` did not match and SRS
 * fell back to the default vhost, which is also where a rendition starts being transcoded into
 * further renditions without limit. That is worth saying loudly, because the symptom otherwise is
 * just a stream that never appears.
 */
function isPublishable(payload: SrsStreamPayload | SrsHlsPayload, streamId: string, abr?: AbrGuard): boolean {
  if (!abr || payload.vhost === abr.vhost) {
    return true;
  }

  if (abr.ladder.match(streamId)) {
    logger.error(
      `[SRS] Rendition ${streamId} arrived on vhost '${payload.vhost}', expected '${abr.vhost}'. ` +
        `The transcode output's ?vhost= did not match — SRS falls back to __defaultVhost__, where the ` +
        `rendition is itself transcoded. Check ABR_VHOST and 'curl localhost:1985/api/v1/streams' for a ` +
        `stream count that keeps climbing.`,
    );
  } else {
    logger.debug(`[SRS] Ignoring source stream ${streamId} on vhost '${payload.vhost}' — the ladder is what publishes`);
  }

  return false;
}

function handleStreams(req: Request, res: Response, streamOrchestrator: StreamOrchestrator, abr?: AbrGuard): void {
  try {
    const payload = req.body as SrsStreamPayload;
    const streamId = buildStreamId(payload.app, payload.stream);

    if (!isPublishable(payload, streamId, abr)) {
      srsResponse(res, SRS_ACCEPT);
      return;
    }

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

function handleHls(
  req: Request,
  res: Response,
  streamOrchestrator: StreamOrchestrator,
  mediaRootPath: string,
  abr?: AbrGuard,
): void {
  try {
    const payload = req.body as SrsHlsPayload;
    const streamId = buildStreamId(payload.app, payload.stream);

    if (!isPublishable(payload, streamId, abr)) {
      srsResponse(res, SRS_ACCEPT);
      return;
    }

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
    const msg = getErrorMessage(error);
    logger.error(`[SRS] HLS handler error: ${msg}`);
    srsResponse(res, SRS_ACCEPT);
  }
}
