import { Request, Response, Router } from 'express';

import { Logger } from '../libs/Logger.js';
import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';
import { optional, optionalBool, optionalInt } from '../utils/env.js';

import { reply, verifyAdmissionSignature } from './ome/http.js';
import { AppStream, OmeAdmissionPayload, OmeEngineOptions } from './ome/interfaces.js';
import { OmeHlsPuller } from './ome/OmeHlsPuller.js';
import { buildStreamId, parseAppStream, resolveMediaType } from './ome/utils.js';
import { EnginePlugin } from './types.js';

const logger = Logger.getInstance();

export function createOmeEngineFromEnv(): EnginePlugin {
  const hlsBaseUrl = optional('OME_HLS_URL', 'http://ome:8081');
  const pollIntervalMs = optionalInt('OME_HLS_POLL_INTERVAL_MS', 500);
  logger.info(`[Engine] OME engine loaded, HLS base: ${hlsBaseUrl}, poll interval: ${pollIntervalMs}ms`);
  return createOmeEngine(hlsBaseUrl, pollIntervalMs, {
    admissionSecret: optional('OME_ADMISSION_SECRET', ''),
    failOpen: optionalBool('OME_ADMISSION_FAIL_OPEN', false),
  });
}

export function createOmeEngine(
  hlsBaseUrl: string,
  pollIntervalMs: number,
  options: OmeEngineOptions = {},
): EnginePlugin {
  const pullers = new Map<string, OmeHlsPuller>();
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

// See https://airensoft.gitbook.io/ovenmediaengine/access-control/admission-webhooks
function handleAdmission(
  req: Request,
  res: Response,
  orchestrator: StreamOrchestrator,
  hlsBaseUrl: string,
  pollIntervalMs: number,
  pullers: Map<string, OmeHlsPuller>,
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

      const puller = new OmeHlsPuller(
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
