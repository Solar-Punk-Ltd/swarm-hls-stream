import { Request, Response, Router } from 'express';

import { Logger } from '../libs/Logger.js';
import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';
import { getErrorMessage } from '../utils/common.js';
import { optional, optionalBool, optionalInt, required } from '../utils/env.js';

import { reply, verifyAdmissionSignature } from './ome/http.js';
import { AppStream, OmeAdmissionPayload, OmeEngineOptions } from './ome/interfaces.js';
import { DEFAULT_FETCH_TIMEOUT_MS, OmeHlsPuller } from './ome/OmeHlsPuller.js';
import { buildStreamId, parseAppStream, parseStreamId, resolveMediaType } from './ome/utils.js';
import { EnginePlugin } from './types.js';

const logger = Logger.getInstance();

type StartPuller = (orchestrator: StreamOrchestrator, streamId: string, app: string, stream: string) => void;
type StopPuller = (streamId: string) => void;

export function createOmeEngineFromEnv(): EnginePlugin {
  const hlsBaseUrl = optional('OME_HLS_URL', 'http://ome:8081');
  const pollIntervalMs = optionalInt('OME_HLS_POLL_INTERVAL_MS', 500);
  const fetchTimeoutMs = optionalInt('OME_FETCH_TIMEOUT_MS', DEFAULT_FETCH_TIMEOUT_MS);
  logger.info(
    `[Engine] OME engine loaded, HLS base: ${hlsBaseUrl}, poll interval: ${pollIntervalMs}ms, fetch timeout: ${fetchTimeoutMs}ms`,
  );
  return createOmeEngine(hlsBaseUrl, pollIntervalMs, {
    admissionSecret: required('OME_ADMISSION_SECRET'),
    failOpen: optionalBool('OME_ADMISSION_FAIL_OPEN', false),
    fetchTimeoutMs,
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
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  // The puller lifecycle lives here (not inline in the admission handler) so crash-recovery can
  // restart it without a fresh admission call — OME never re-announces a session that stayed open
  // across the crash, so `resumeRecoveredStream` reuses exactly this path.
  const startPuller: StartPuller = (orchestrator, streamId, app, stream) => {
    if (pullers.has(streamId)) {
      return;
    }

    const onHalt = (): void => {
      pullers.delete(streamId);
      orchestrator.stopStream(streamId).catch((error) => {
        const msg = getErrorMessage(error);
        logger.error(`[OME] Error stopping stream ${streamId} after puller halt: ${msg}`);
      });
    };

    const puller = new OmeHlsPuller(streamId, app, stream, hlsBaseUrl, pollIntervalMs, orchestrator, {
      onHalt,
      fetchTimeoutMs,
    });
    pullers.set(streamId, puller);
    puller.start();
  };

  const stopPuller: StopPuller = (streamId) => {
    const puller = pullers.get(streamId);
    if (puller) {
      puller.stop();
      pullers.delete(streamId);
    }
  };

  return {
    name: 'ome',
    prefix: '/engines/ome',

    createRouter(orchestrator: StreamOrchestrator): Router {
      const router = Router();

      // Only reachable when the engine is constructed directly, since the env path now requires the
      // secret. Loud because the webhook is the ingest path: rejecting everything looks like a
      // broadcaster problem from the outside.
      if (!admissionSecret) {
        logger.warn('[OME] No admission secret configured, every admission request will be rejected');
      }

      router.post('/admission', (req: Request, res: Response) => {
        if (!verifyAdmissionSignature(req, admissionSecret)) {
          logger.warn(`[OME] Rejected admission request with missing/invalid signature from ${req.ip}`);
          res.status(401);
          reply(res, { allowed: false, reason: 'invalid signature' });
          return;
        }
        handleAdmission(req, res, orchestrator, startPuller, stopPuller, failOpen);
      });

      return router;
    },

    // OME is pull-based: after an uploader crash the orchestrator restores the stream, but no new
    // admission arrives (the broadcaster's session never closed), so nothing restarts the HLS puller.
    // Restart it here or the recovered stream produces no segments and is VOD-ed at the recovery timeout.
    resumeRecoveredStream(orchestrator: StreamOrchestrator, streamId: string): void {
      const { app, stream } = parseStreamId(streamId);
      if (!app || !stream) {
        logger.warn(`[OME] Cannot resume recovered stream with unrecognised id: ${streamId}`);
        return;
      }
      logger.info(`[OME] Resuming HLS pull for recovered stream ${streamId}`);
      startPuller(orchestrator, streamId, app, stream);
    },
  };
}

// See https://airensoft.gitbook.io/ovenmediaengine/access-control/admission-webhooks
function handleAdmission(
  req: Request,
  res: Response,
  orchestrator: StreamOrchestrator,
  startPuller: StartPuller,
  stopPuller: StopPuller,
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
      stopPuller(streamId);
      reply(res, { allowed: true, lifetime: 0, reason: 'ok' });

      orchestrator.stopStream(streamId).catch((error) => {
        const msg = getErrorMessage(error);
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
    startPuller(orchestrator, streamId, parsed.app, parsed.stream);

    reply(res, { allowed: true, lifetime: 0, reason: 'ok' });
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error(`[OME] Admission handler error: ${msg}`);
    if (failOpen) {
      reply(res, { allowed: true, reason: 'handler error (fail-open)' });
    } else {
      reply(res, { allowed: false, reason: 'handler error' });
    }
  }
}
