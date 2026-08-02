import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';

import { Logger } from '../libs/Logger.js';
import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';
import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MediaType } from '../types.js';
import { getErrorMessage } from '../utils/common.js';
import { optional, required } from '../utils/env.js';

import { assertUsableWebhookToken, hasValidWebhookToken, redactWebhookToken } from './srs/webhookToken.js';
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
  /**
   * The publisher's address, which SRS names `ip` in its `on_publish` body.
   *
   * Optional, and screened rather than trusted, for two reasons. It is a claim about the webhook body
   * rather than a fact, like every other field parsed here. And it has not been observed on this
   * deployment's SRS build the way OME's `client.address` was captured live on 2026-08-01, so a build
   * that omits it has to mean "no evidence" and not "a different publisher".
   */
  ip?: string;
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

/** The publisher's address, for `StreamClaimant`, or null when the webhook did not carry one whole. */
function publisherAddress(payload: SrsStreamPayload): string | null {
  return typeof payload?.ip === 'string' && payload.ip.length > 0 ? payload.ip : null;
}

export function createSrsEngineFromEnv(): EnginePlugin {
  const mediaPath = optional('SRS_MEDIA_PATH', './media');
  const webhookToken = required('SRS_WEBHOOK_TOKEN');
  const engine = createSrsEngine(mediaPath, { webhookToken });
  // After construction, not before. `required` covers a missing or empty value, but the charset and
  // length checks live inside createSrsEngine, so logging first announced a successfully loaded
  // engine and then threw for a token that was merely too short.
  logger.info(`[Engine] SRS engine loaded, media path: ${mediaPath}`);
  return engine;
}

/**
 * SRS cannot sign its callbacks and cannot send a header, so the credential travels in the hook URL
 * that entrypoint.sh writes into srs.conf.
 *
 * One factory, mounted twice on purpose. On the router it is the authorization guard, so a webhook
 * added later is covered without whoever adds it remembering, and mounting the router by itself is
 * safe. At app level, ahead of the body parsers, it is the resource guard. See `EnginePlugin`.
 */
function createWebhookGate(webhookToken: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!hasValidWebhookToken(req, webhookToken)) {
      // Named route, because the two webhooks fail in ways that need different responses: on_publish
      // rejected means no stream ever starts, on_hls rejected means the stream runs and every
      // segment is silently dropped. Redacted, because originalUrl is where the credential lives.
      logger.warn(
        `[SRS] Rejected webhook with missing or invalid token: ` +
          `${req.method} ${redactWebhookToken(req.originalUrl)} from ${req.ip}`,
      );
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

export function createSrsEngine(mediaRootPath: string, options: SrsEngineOptions = {}): EnginePlugin {
  const webhookToken = options.webhookToken ?? '';
  if (webhookToken) {
    assertUsableWebhookToken(webhookToken);
  } else {
    // Loud for the same reason `ome.ts` is loud about a missing admission secret: an engine that
    // rejects every webhook looks like a broadcaster problem from the outside, not a configuration
    // one, and nothing else in the process ever says otherwise.
    logger.warn('[SRS] No webhook token configured, every webhook will be rejected');
  }

  return {
    name: 'srs',
    prefix: '/engines/srs',

    createAuthMiddleware(): RequestHandler {
      return createWebhookGate(webhookToken);
    },

    createRouter(streamOrchestrator: StreamOrchestrator): Router {
      const router = Router();

      router.use(createWebhookGate(webhookToken));

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

    const accepted = streamOrchestrator.startStream(streamId, mediatype, { address: publisherAddress(payload) });
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
