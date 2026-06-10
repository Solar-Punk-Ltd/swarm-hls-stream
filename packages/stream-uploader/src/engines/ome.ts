import { Request, Response, Router } from 'express';

import { Logger } from '../libs/Logger.js';
import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';
import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MediaType } from '../types.js';

import { HlsPuller } from './ome/HlsPuller.js';
import { EnginePlugin } from './types.js';

const logger = Logger.getInstance();

// See https://airensoft.gitbook.io/ovenmediaengine/access-control/admission-webhooks
interface OmeAdmissionRequest {
  direction: 'incoming' | 'outgoing';
  protocol: string;
  url: string;
  time?: string;
  new_url?: string;
  status?: 'opening' | 'closing';
}

interface OmeAdmissionPayload {
  client?: { address?: string; port?: number };
  request: OmeAdmissionRequest;
}

interface OmeAdmissionReply {
  allowed: boolean;
  new_url?: string | null;
  lifetime?: number;
  reason?: string;
}

function resolveMediaType(app: string): MediaType {
  return app === MEDIA_TYPE_AUDIO ? MEDIA_TYPE_AUDIO : MEDIA_TYPE_VIDEO;
}

function buildStreamId(app: string, stream: string): string {
  return `${app}/${stream}`;
}

// OME admission URLs look like `srt://host:port/app/stream` (or
// `srt://host:port/app/stream?streamid=...`). Extract (app, stream).
function parseAppStream(url: string): { app: string; stream: string } | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    return { app: parts[0], stream: parts[1] };
  } catch {
    return null;
  }
}

// OvenMediaEngine
export function createOmeEngine(hlsBaseUrl: string, pollIntervalMs: number): EnginePlugin {
  const pullers = new Map<string, HlsPuller>();

  return {
    name: 'ome',
    prefix: '/engines/ome',

    createRouter(orchestrator: StreamOrchestrator): Router {
      const router = Router();

      router.post('/admission', (req: Request, res: Response) => {
        handleAdmission(req, res, orchestrator, hlsBaseUrl, pollIntervalMs, pullers);
      });

      return router;
    },
  };
}

function reply(res: Response, body: OmeAdmissionReply): void {
  res.type('json').send(JSON.stringify(body));
}

function handleAdmission(
  req: Request,
  res: Response,
  orchestrator: StreamOrchestrator,
  hlsBaseUrl: string,
  pollIntervalMs: number,
  pullers: Map<string, HlsPuller>,
): void {
  try {
    const payload = req.body as OmeAdmissionPayload;
    const request = payload?.request;

    if (!request || request.direction !== 'incoming') {
      reply(res, { allowed: true, lifetime: 0, reason: 'ignored (not incoming)' });
      return;
    }

    const parsed = parseAppStream(request.url);
    if (!parsed) {
      logger.warn(`[OME] Could not parse app/stream from URL: ${request.url}`);
      reply(res, { allowed: false, reason: 'invalid url' });
      return;
    }

    const streamId = buildStreamId(parsed.app, parsed.stream);

    if (request.status === 'closing') {
      logger.info(`[OME] Stream closing: ${streamId}`);
      const puller = pullers.get(streamId);
      if (puller) {
        puller.stop();
        pullers.delete(streamId);
      }
      reply(res, { allowed: true, lifetime: 0, reason: 'ok' });

      orchestrator.stopStream(streamId).catch((error) => {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[OME] Error stopping stream ${streamId}: ${msg}`);
      });
      return;
    }

    // status === 'opening' (or absent — treat as opening)
    const mediatype = resolveMediaType(parsed.app);
    const accepted = orchestrator.startStream(streamId, mediatype);

    if (!accepted) {
      reply(res, { allowed: false, reason: 'orchestrator rejected' });
      return;
    }

    logger.info(`[OME] Stream opening: ${streamId} (${mediatype})`);

    // Spin up the HLS poller. Don't block the admission reply on it.
    if (!pullers.has(streamId)) {
      const puller = new HlsPuller(streamId, parsed.app, parsed.stream, hlsBaseUrl, pollIntervalMs, orchestrator);
      pullers.set(streamId, puller);
      puller.start();
    }

    reply(res, { allowed: true, lifetime: 0, reason: 'ok' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[OME] Admission handler error: ${msg}`);
    reply(res, { allowed: true, reason: 'handler error (fail-open)' });
  }
}
