import { Request, Response, Router } from 'express';

import { Logger } from '../libs/Logger.js';
import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';
import { getErrorMessage } from '../utils/common.js';
import { optional, optionalBool, optionalInt, required } from '../utils/env.js';
import { HLS_PROGRAM_DATE_TIME } from '../utils/hlsTags.js';

import { reply, verifyAdmissionSignature } from './ome/http.js';
import { AppStream, OmeAdmissionPayload, OmeEngineOptions, OmeEngineSeams } from './ome/interfaces.js';
import { DEFAULT_FETCH_TIMEOUT_MS, OmeHlsPuller } from './ome/OmeHlsPuller.js';
import { buildStreamId, parseAppStream, parseStreamId, resolveMediaType } from './ome/utils.js';
import { EnginePlugin } from './types.js';

const logger = Logger.getInstance();

type StartPuller = (orchestrator: StreamOrchestrator, streamId: string, app: string, stream: string) => void;
type StopPuller = (streamId: string) => void;

export function createOmeEngineFromEnv(seams: OmeEngineSeams = {}): EnginePlugin {
  const hlsBaseUrl = optional('OME_HLS_URL', 'http://ome:8081');
  // A zero poll interval is legitimate, meaning poll as fast as each tick completes. A zero abort
  // window is not: it cancels every request before it can answer, which is how an operator writing
  // the natural value for "disabled" silently turns the puller off.
  const pollIntervalMs = optionalInt('OME_HLS_POLL_INTERVAL_MS', 500, { min: 0 });
  const fetchTimeoutMs = optionalInt('OME_FETCH_TIMEOUT_MS', DEFAULT_FETCH_TIMEOUT_MS, { min: 1 });
  logger.info(
    `[Engine] OME engine loaded, HLS base: ${hlsBaseUrl}, poll interval: ${pollIntervalMs}ms, fetch timeout: ${fetchTimeoutMs}ms`,
  );
  return createOmeEngine(hlsBaseUrl, pollIntervalMs, {
    admissionSecret: required('OME_ADMISSION_SECRET'),
    failOpen: optionalBool('OME_ADMISSION_FAIL_OPEN', false),
    fetchTimeoutMs,
    fetcher: seams.fetcher,
  });
}

/**
 * What the origin was last seen serving for one stream. `newest` is null when playlists were read and
 * none carried a date-time, which is a different state from never having watched the stream at all and
 * is the only thing that can tell an unprotected origin from a first announce.
 */
interface ObservedSegmentTime {
  newest: number | null;
  recordedAt: number;
}

/**
 * How long a stream's observation stays usable as a handover floor. A reconnect races the origin's
 * idle timeout and is over in seconds, so anything older describes a different broadcast, and holding
 * every stream id ever announced would grow without bound.
 */
const OBSERVED_SEGMENT_TIME_TTL_MS = 120_000;

function recallSegmentTime(
  observed: Map<string, ObservedSegmentTime>,
  streamId: string,
): ObservedSegmentTime | undefined {
  const record = observed.get(streamId);
  if (record && Date.now() - record.recordedAt > OBSERVED_SEGMENT_TIME_TTL_MS) {
    observed.delete(streamId);
    return undefined;
  }
  return record;
}

export function createOmeEngine(
  hlsBaseUrl: string,
  pollIntervalMs: number,
  options: OmeEngineOptions = {},
): EnginePlugin {
  const pullers = new Map<string, OmeHlsPuller>();
  const observedSegmentTimes = new Map<string, ObservedSegmentTime>();
  const admissionSecret = options.admissionSecret ?? '';
  const failOpen = options.failOpen ?? false;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const fetcher = options.fetcher;

  // The puller lifecycle lives here (not inline in the admission handler) so crash-recovery can
  // restart it without a fresh admission call — OME never re-announces a session that stayed open
  // across the crash, so `resumeRecoveredStream` reuses exactly this path.
  const startPuller: StartPuller = (orchestrator, streamId, app, stream) => {
    // An announce for a stream already being pulled means the origin restarted its session, and the
    // orchestrator has already finalized the old uploader and spawned a fresh one. Keeping the old
    // puller left the two halves disagreeing about which session is live: it carries the previous
    // session's `lastSeq`, so it discards every index the new session publishes, forever. See CON-16.
    // The replacement has to be told where the outgoing session's media ends, or it ingests whatever
    // the origin is still serving. OME keeps a dropped publisher's HLS output up until the SRT session
    // is reaped, five seconds when measured, and the admission webhook that lands the reconnect fires
    // inside that window. See CON-20.
    //
    // Read from the per-stream record rather than off the outgoing puller, because OME sends a
    // `closing` between two announces whenever it rejects a republish as a duplicate name, 111ms after
    // answering in the measured case. That closing destroys the puller, and reading the floor off the
    // puller therefore lost it on exactly the retry this protects.
    const observed = recallSegmentTime(observedSegmentTimes, streamId);
    const staleBefore = observed?.newest ?? undefined;
    const stale = pullers.get(streamId);
    if (stale) {
      logger.info(`[OME] Stream ${streamId} announced again, replacing its HLS puller`);
      stale.stop();
      pullers.delete(streamId);
    }
    if (observed && staleBefore === undefined) {
      // Gated on having watched this stream before and seen no date-time, not on the predecessor still
      // being in the map. A floor that matches nothing reads from the outside exactly like a floor
      // that is holding, and this is the one line that separates them, so it has to mean what it says.
      logger.warn(
        `[OME] Replacing the puller for ${streamId} with no ${HLS_PROGRAM_DATE_TIME} to go on, so the replaced session's media cannot be told from the new session's and will be delivered into it`,
      );
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
      fetcher,
      staleBefore,
      onSegmentTimeObserved: (newest) => {
        observedSegmentTimes.set(streamId, { newest, recordedAt: Date.now() });
      },
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

  const liveSessions = new Map<string, string>();
  const sessions: SessionRegistry = {
    remember: (streamId, key) => {
      if (key === null) {
        // Nothing to match a later closing against, so forget any earlier key rather than leaving a
        // stale one that would reject the closing this session does send.
        liveSessions.delete(streamId);
        return;
      }
      liveSessions.set(streamId, key);
    },
    belongsToReplacedSession: (streamId, key) => {
      const live = liveSessions.get(streamId);
      // Strict only with evidence on both sides. Refusing to stop a stream whose identity is unknown
      // would leak a puller and never produce a VOD, which is worse than what this guards against.
      return live !== undefined && key !== null && live !== key;
    },
    // Bounds the map for streams that close and never reopen. It changes no behaviour on its own,
    // because an accepted opening overwrites the key anyway, so a mutation removing it survives the
    // suite and no behavioural test can see the difference. Kept for the same reason
    // OBSERVED_SEGMENT_TIME_TTL_MS exists: holding every stream id ever announced grows without bound.
    forget: (streamId) => liveSessions.delete(streamId),
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
        handleAdmission(req, res, orchestrator, startPuller, stopPuller, failOpen, sessions);
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
/**
 * Identity of one publishing session, from the socket OME reports on every admission.
 *
 * Measured against a real OvenMediaEngine rather than inferred: a publish, an abrupt kill and a
 * republish produced four admissions, and `client.port` matched its own session's opening and
 * closing while differing between the two sessions. The stream id cannot do this, because both
 * sessions carry the same one, which is the whole of CON-21.
 *
 * Null whenever the payload does not carry a whole socket, which is a wider condition than the field
 * being absent. This is parsed from a webhook body, so the declared types are a claim rather than a
 * guarantee: JSON has no `undefined`, so an omitted field arrives as `null`, and a socket already
 * torn down when the closing was sent reports port 0. Each of those says "no identity", and building
 * a key out of one instead turns it into "a different identity", which is what makes the guard below
 * drop a real closing and leave the puller running with nothing to stop it.
 */
function sessionKey(payload: OmeAdmissionPayload): string | null {
  const client = payload?.client;
  if (!client) {
    return null;
  }
  const { address, port } = client;
  const hasAddress = typeof address === 'string' && address.length > 0;
  const hasPort = typeof port === 'number' && Number.isInteger(port) && port > 0;
  return hasAddress && hasPort ? `${address}:${port}` : null;
}

/** Which publishing session currently holds a stream id, so a late closing can be told from a live one. */
interface SessionRegistry {
  remember(streamId: string, key: string | null): void;
  /** True only when both sides have an identity and they differ, so an unknown identity is never rejected. */
  belongsToReplacedSession(streamId: string, key: string | null): boolean;
  forget(streamId: string): void;
}

function handleAdmission(
  req: Request,
  res: Response,
  orchestrator: StreamOrchestrator,
  startPuller: StartPuller,
  stopPuller: StopPuller,
  failOpen: boolean,
  sessions: SessionRegistry,
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
    const session = sessionKey(payload);

    if (request.status === 'closing') {
      if (sessions.belongsToReplacedSession(streamId, session)) {
        // Two admissions for one stream are independent requests against a 3000ms timeout, so a slow
        // `closing` for a dropped session can be processed after an `opening` OME did admit. Acting on
        // it would stop the live puller and VOD-finalize the session that replaced the sender. See
        // CON-21. Answered `allowed` because OME only wants the acknowledgement, and the session this
        // was sent for is already gone.
        logger.warn(
          `[OME] Ignoring a closing for ${streamId} from ${session}: that session has already been replaced and the live one is not it`,
        );
        reply(res, { allowed: true, lifetime: 0, reason: 'ok (closing for a replaced session)' });
        return;
      }

      logger.info(`[OME] Stream closing: ${streamId}`);
      sessions.forget(streamId);
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

    // Recorded only once the orchestrator has taken the stream, so a rejected announce cannot make
    // the live session's own closing look like it came from somewhere else.
    sessions.remember(streamId, session);

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
