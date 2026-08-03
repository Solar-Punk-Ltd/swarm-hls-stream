import { Request, Response, Router } from 'express';

import { Logger } from '../libs/Logger.js';
import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';
import { getErrorMessage } from '../utils/common.js';
import { optional, optionalBool, optionalInt, required } from '../utils/env.js';
import { HLS_PROGRAM_DATE_TIME } from '../utils/hlsTags.js';
import { assertUsablePublishKeySecret, hasValidPublishKey, publishKeyFromUrl } from '../utils/publishKey.js';

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
    publishKeySecret: optional('PUBLISH_KEY_SECRET', ''),
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
  const publishKeySecret = options.publishKeySecret ?? '';
  if (publishKeySecret) {
    assertUsablePublishKeySecret(publishKeySecret);
  }
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

  const closedSessionTtlMs = options.closedSessionTtlMs ?? DEFAULT_CLOSED_SESSION_TTL_MS;
  const sessionsByStream = new Map<string, SessionRecord>();
  const sessions: SessionRegistry = {
    opened: (streamId, identity) => {
      if (!carriesAnyIdentity(identity)) {
        // Nothing to match a later closing against, so drop any earlier record rather than leaving a
        // stale one that would reject the closing this session does send.
        sessionsByStream.delete(streamId);
        return;
      }
      sessionsByStream.set(streamId, { phase: 'live', identity });
    },
    closed: (streamId) => {
      const now = Date.now();
      // Swept here rather than only where a record is read, because the ordinary end of a broadcast is
      // a stream that closes and never reopens, and nothing reads its record again. Expiring lazily
      // would therefore expire nothing on exactly the path that produces records, leaving one per
      // stream id ever closed, which is the growth this window exists to bound.
      for (const [id, record] of sessionsByStream) {
        if (record.phase === 'closed' && now - record.closedAt > closedSessionTtlMs) {
          sessionsByStream.delete(id);
        }
      }
      sessionsByStream.set(streamId, { phase: 'closed', closedAt: now });
    },
    forget: (streamId) => sessionsByStream.delete(streamId),
    reasonToIgnoreClosing: (streamId, identity) => {
      const record = sessionsByStream.get(streamId);
      if (!record) {
        return null;
      }
      if (record.phase === 'closed') {
        if (Date.now() - record.closedAt > closedSessionTtlMs) {
          sessionsByStream.delete(streamId);
          return null;
        }
        return 'already-closed';
      }
      return isProvablyNotTheLiveSession(record.identity, identity) ? 'replaced' : null;
    },
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
      if (!publishKeySecret) {
        // The signature above authenticates OME, and says nothing about who is publishing into it.
        // Without this an operator has no way to tell a deployment where SEC-28 applies from one
        // where ownership is still decided by the address alone.
        logger.warn(
          '[OME] No PUBLISH_KEY_SECRET configured, so publishers are not authenticated and stream ownership ' +
            'is judged only by the address OME reports. See SEC-28.',
        );
      }

      router.post('/admission', (req: Request, res: Response) => {
        if (!verifyAdmissionSignature(req, admissionSecret)) {
          logger.warn(`[OME] Rejected admission request with missing/invalid signature from ${req.ip}`);
          res.status(401);
          reply(res, { allowed: false, reason: 'invalid signature' });
          return;
        }
        handleAdmission(req, res, orchestrator, startPuller, stopPuller, failOpen, sessions, publishKeySecret);
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
      // A resumed puller has no admission behind it, so nothing re-records who holds the stream. Any
      // record surviving from before would be judged against the closing that is now the only thing
      // that can stop this puller, and a closed one would reject it outright.
      sessions.forget(streamId);
      logger.info(`[OME] Resuming HLS pull for recovered stream ${streamId}`);
      startPuller(orchestrator, streamId, app, stream);
    },
  };
}

// See https://airensoft.gitbook.io/ovenmediaengine/access-control/admission-webhooks
/**
 * What one admission says about which publishing session sent it.
 *
 * Two discriminators rather than one, because each covers a case the other cannot. Both were measured
 * against a real OvenMediaEngine rather than inferred: a publish, an abrupt kill and a republish
 * produced four admissions carrying both fields. The stream id is not among them, because both
 * sessions carry the same one, which is the whole of CON-21.
 *
 * Either half is null whenever the payload does not carry it whole, which is wider than the field
 * being absent. These are parsed from a webhook body, so the declared types are a claim rather than a
 * guarantee: JSON has no `undefined`, so an omitted field arrives as `null`, a socket already torn
 * down when the closing was sent reports port 0, and a time that is not a date parses to NaN. Each of
 * those says "no evidence", and reading one as evidence instead is what makes the guard drop a real
 * closing and leave the puller running with nothing left to stop it.
 */
interface SessionIdentity {
  /**
   * `address:port`. Matched its own session's opening and closing and differed between the two
   * sessions: 44546 for the first, 22138 for the second.
   */
  socket: string | null;
  /**
   * `request.time` in epoch milliseconds. Monotone across admissions, so it orders two sessions the
   * socket cannot tell apart, which is any pair where the second reconnects on the port the first
   * used. See CON-23.
   */
  issuedAt: number | null;
}

function sessionIdentity(payload: OmeAdmissionPayload): SessionIdentity {
  return { socket: sessionSocket(payload), issuedAt: admissionTime(payload) };
}

function sessionSocket(payload: OmeAdmissionPayload): string | null {
  const address = publisherAddress(payload);
  const port = payload?.client?.port;
  const hasPort = typeof port === 'number' && Number.isInteger(port) && port > 0;
  return address !== null && hasPort ? `${address}:${port}` : null;
}

/**
 * The publisher's address, for `StreamClaimant`.
 *
 * `client.address` and not `client.real_ip`. The first is the peer OME is actually talking to, and the
 * second is whatever a proxy in front of it claimed, which is a header on the paths that populate it.
 * A guard that decides who may take a live stream id has to read the one an attacker cannot set.
 */
function publisherAddress(payload: OmeAdmissionPayload): string | null {
  const address = payload?.client?.address;
  return typeof address === 'string' && address.length > 0 ? address : null;
}

function admissionTime(payload: OmeAdmissionPayload): number | null {
  const time = payload?.request?.time;
  if (typeof time !== 'string') {
    return null;
  }
  const parsed = Date.parse(time);
  return Number.isNaN(parsed) ? null : parsed;
}

function carriesAnyIdentity(identity: SessionIdentity): boolean {
  return identity.socket !== null || identity.issuedAt !== null;
}

/**
 * Whether a `closing` can be shown to have been sent for some session other than the one now live.
 *
 * Strict only with evidence on both sides, and on either discriminator alone. Refusing a closing whose
 * session cannot be identified would leak a puller and never produce a VOD, which is worse than what
 * this guards against.
 *
 * The socket separates sessions that reconnect on a fresh source port, which is the ordinary case, and
 * says nothing about a publisher that reuses one, which a pinned local port, an SRT rendezvous or a
 * NAT holding its mapping all produce. The issue time separates any two sessions whose closing was
 * issued before the live one was admitted, which is the reordering this guards against, and says
 * nothing about a closing OME issued afterwards. Both times are OME's own, so the comparison never
 * crosses a clock boundary.
 */
function isProvablyNotTheLiveSession(live: SessionIdentity, closing: SessionIdentity): boolean {
  const differentSocket = live.socket !== null && closing.socket !== null && live.socket !== closing.socket;
  const issuedBeforeTheLiveSessionOpened =
    live.issuedAt !== null && closing.issuedAt !== null && closing.issuedAt < live.issuedAt;
  return differentSocket || issuedBeforeTheLiveSessionOpened;
}

/** How a session is named in a log line, from whichever discriminators its payload carried. */
function describeSession(identity: SessionIdentity): string {
  const named = [identity.socket, identity.issuedAt === null ? null : new Date(identity.issuedAt).toISOString()];
  const known = named.filter((part): part is string => part !== null);
  return known.length > 0 ? known.join(' at ') : 'an unidentified session';
}

/**
 * Which publishing session holds a stream id, and whether it still holds it.
 *
 * The closed state is the whole point of there being three. An accepted closing used to delete the
 * record, and an absent record means "no evidence", so from that instant until the next accepted
 * opening the guard was off: a repeat of the closing just honoured was acted on again and started a
 * second drain of a stream the first one had already retired. See CON-22.
 */
type SessionRecord =
  | { phase: 'live'; identity: SessionIdentity }
  /**
   * Carries no identity, because nothing reads one. A closed record answers "no session holds this
   * id", which is true of every identity at once, so keeping the departed session's would be a field
   * that only ever gets written. Mutation found it: replacing the expression that chose which identity
   * to store survived the suite, and no test could have killed it.
   */
  | { phase: 'closed'; closedAt: number };

/** Why a `closing` must not be acted on. Each spelling states only what the registry established. */
type IgnoredClosingReason = 'replaced' | 'already-closed';

const IGNORED_CLOSINGS: Record<
  IgnoredClosingReason,
  { replyReason: string; warn: (streamId: string, identity: SessionIdentity) => string }
> = {
  // Two admissions for one stream are independent requests against a 3000ms timeout, so a slow
  // `closing` for a dropped session can be processed after an `opening` OME did admit. Acting on it
  // would stop the live puller and VOD-finalize the session that replaced the sender. See CON-21.
  replaced: {
    replyReason: 'ok (closing for a replaced session)',
    warn: (streamId, identity) =>
      `[OME] Ignoring a closing for ${streamId} from ${describeSession(
        identity,
      )}: the session live on that id is a different one`,
  },
  'already-closed': {
    replyReason: 'ok (closing for a session already closed)',
    warn: (streamId) =>
      `[OME] Ignoring a closing for ${streamId}: its closing has already been acted on and nothing has opened on that id since`,
  },
};

/**
 * How long a closed session stays on record. It only has to outlive the window in which a closing for
 * it can still arrive, which OME's 3000ms admission timeout bounds, and a record per stream id ever
 * closed would grow without bound where a record per live stream id does not. A live record never
 * expires, because a session may broadcast for as long as it likes.
 */
const DEFAULT_CLOSED_SESSION_TTL_MS = 60_000;

interface SessionRegistry {
  /** Record the session the orchestrator has just accepted, or clear the record when it carries no identity. */
  opened(streamId: string, identity: SessionIdentity): void;
  /** Record that the session holding this stream is gone, so a repeat of its closing is not acted on twice. */
  closed(streamId: string): void;
  /** Drop everything known about a stream, for a puller started with no admission behind it. */
  forget(streamId: string): void;
  reasonToIgnoreClosing(streamId: string, identity: SessionIdentity): IgnoredClosingReason | null;
}

function handleAdmission(
  req: Request,
  res: Response,
  orchestrator: StreamOrchestrator,
  startPuller: StartPuller,
  stopPuller: StopPuller,
  failOpen: boolean,
  sessions: SessionRegistry,
  publishKeySecret: string,
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
    const session = sessionIdentity(payload);

    if (request.status === 'closing') {
      // Screened before the session guard below rather than after it, which is a disclosure choice
      // rather than a behavioural one: both orders refuse the same closings, but the guard's reply
      // reason distinguishes `already-closed` from `replaced`, and answering that to a caller who has
      // not proved the key hands them a session-state oracle for any id they care to name.
      //
      // The one deployment this degrades is an upgrade in progress. A broadcaster who was already
      // publishing when the secret was turned on has no key in their url, so their closing is ignored
      // and their stream finalizes at the recovery timeout instead of promptly. Bounded, one-time, and
      // the alternative is honouring an unproven closing for the whole life of every such session.
      // See SEC-29.
      if (publishKeySecret && !hasValidPublishKey(publishKeySecret, streamId, publishKeyFromUrl(request.url))) {
        logger.warn(`[OME] Ignored a closing for ${streamId} with a missing or invalid publish key`);
        reply(res, { allowed: true, lifetime: 0, reason: 'ignored (invalid publish key)' });
        return;
      }

      const ignored = sessions.reasonToIgnoreClosing(streamId, session);
      if (ignored) {
        // Answered `allowed` because OME only wants the acknowledgement, and the session this was
        // sent for is gone either way.
        logger.warn(IGNORED_CLOSINGS[ignored].warn(streamId, session));
        reply(res, { allowed: true, lifetime: 0, reason: IGNORED_CLOSINGS[ignored].replyReason });
        return;
      }

      logger.info(`[OME] Stream closing: ${streamId}`);
      sessions.closed(streamId);
      stopPuller(streamId);
      reply(res, { allowed: true, lifetime: 0, reason: 'ok' });

      orchestrator.stopStream(streamId).catch((error) => {
        const msg = getErrorMessage(error);
        logger.error(`[OME] Error stopping stream ${streamId}: ${msg}`);
      });
      return;
    }

    // status === 'opening' (or absent — treat as opening)
    const isAuthenticated = hasValidPublishKey(publishKeySecret, streamId, publishKeyFromUrl(request.url));
    if (publishKeySecret && !isAuthenticated) {
      // Named as its own refusal rather than folded into the one below, and this is the opposite
      // choice from the one made there. That reason is deliberately uninformative because it would
      // otherwise tell a prober whether the id is live and when it goes quiet. This one is reachable
      // identically whether the id is live, idle or has never existed, so it discloses nothing about
      // the deployment, and the broadcaster who typed their key wrong is the likeliest caller.
      logger.warn(`[OME] Rejected an admission for ${streamId} with a missing or invalid publish key`);
      reply(res, { allowed: false, reason: 'invalid publish key' });
      return;
    }

    const mediatype = resolveMediaType(parsed.app);
    const accepted = orchestrator.startStream(streamId, mediatype, {
      address: publisherAddress(payload),
      isAuthenticated,
    });

    if (!accepted) {
      // Deliberately the same wording as every other refusal. The caller here is the one case that
      // may be an attacker probing a stream id they do not hold, and a reason naming the incumbent
      // would tell them whether the id is live and when it goes quiet.
      reply(res, { allowed: false, reason: 'orchestrator rejected' });
      return;
    }

    // Recorded only once the orchestrator has taken the stream, so a rejected announce cannot make
    // the live session's own closing look like it came from somewhere else.
    sessions.opened(streamId, session);

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
