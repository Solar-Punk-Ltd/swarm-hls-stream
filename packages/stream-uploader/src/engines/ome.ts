import { Request, Response, Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { Logger } from '../libs/Logger.js';
import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';
import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MediaType } from '../types.js';

import { HlsPuller } from './ome/HlsPuller.js';
import { AppStream } from './ome/interfaces.js';
import { EnginePlugin, RawBodyRequest } from './types.js';

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

export function parseAppStream(url: string): AppStream {
  let parts: string[] = [];

  try {
    const u = new URL(url);
    parts = u.pathname.split('/').filter(Boolean);

    if (parts.length < 2) {
      const streamid = u.searchParams.get('streamid');
      if (streamid) {
        parts = new URL(streamid).pathname.split('/').filter(Boolean);
      }
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    logger.error(`[OME] Could not parse app/stream from URL: ${url} (${errorMsg})`);
    throw new Error(`Could not parse app/stream from URL: ${url} (${errorMsg})`);
  }

  return { app: parts[0], stream: parts[1] };
}

export interface OmeEngineOptions {
  admissionSecret?: string;
  failOpen?: boolean;
}

export function createOmeEngine(
  hlsBaseUrl: string,
  pollIntervalMs: number,
  options: OmeEngineOptions = {},
): EnginePlugin {
  const pullers = new Map<string, HlsPuller>();
  const admissionSecret = options.admissionSecret ?? '';
  const failOpen = options.failOpen ?? false;

  return {
    name: 'ome',
    prefix: '/engines/ome',

    createRouter(orchestrator: StreamOrchestrator): Router {
      const router = Router();

      if (!admissionSecret) {
        logger.warn('[OME] OME_ADMISSION_SECRET is not set — admission webhook accepts unauthenticated requests');
      }

      router.post('/admission', (req: Request, res: Response) => {
        if (!verifyAdmissionSignature(req, admissionSecret)) {
          logger.warn(`[OME] Rejected admission request with missing/invalid signature from ${req.ip}`);
          res.status(401);
          reply(res, { allowed: false, reason: 'invalid signature' });
          return;
        }
        handleAdmission(req, res, orchestrator, hlsBaseUrl, pollIntervalMs, pullers, failOpen);
      });

      return router;
    },
  };
}

function verifyAdmissionSignature(req: Request, secret: string): boolean {
  if (!secret) {
    return true;
  }

  const signature = req.get('x-ome-signature');
  const rawBody = (req as RawBodyRequest).rawBody;
  if (!signature || !rawBody) {
    return false;
  }

  const expected = createHmac('sha1', secret).update(rawBody).digest('base64url');
  const received = Buffer.from(signature);
  const computed = Buffer.from(expected);
  return received.length === computed.length && timingSafeEqual(received, computed);
}

function reply(res: Response, body: OmeAdmissionReply): void {
  res.json(body);
}

function handleAdmission(
  req: Request,
  res: Response,
  orchestrator: StreamOrchestrator,
  hlsBaseUrl: string,
  pollIntervalMs: number,
  pullers: Map<string, HlsPuller>,
  failOpen: boolean,
): void {
  try {
    const payload = req.body as OmeAdmissionPayload;
    const request = payload?.request;

    if (!request || request.direction !== 'incoming') {
      reply(res, { allowed: true, lifetime: 0, reason: 'ignored (not incoming)' });
      return;
    }

    let parsed: AppStream;
    try {
      parsed = parseAppStream(request.url);
    } catch {
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
      const onHalt = (): void => {
        pullers.delete(streamId);
        orchestrator.stopStream(streamId).catch((error) => {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[OME] Error stopping stream ${streamId} after puller halt: ${msg}`);
        });
      };

      const puller = new HlsPuller(
        streamId,
        parsed.app,
        parsed.stream,
        hlsBaseUrl,
        pollIntervalMs,
        orchestrator,
        onHalt,
      );
      pullers.set(streamId, puller);
      puller.start();
    }

    reply(res, { allowed: true, lifetime: 0, reason: 'ok' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[OME] Admission handler error: ${msg}`);
    if (failOpen) {
      reply(res, { allowed: true, reason: 'handler error (fail-open)' });
    } else {
      reply(res, { allowed: false, reason: 'handler error' });
    }
  }
}
