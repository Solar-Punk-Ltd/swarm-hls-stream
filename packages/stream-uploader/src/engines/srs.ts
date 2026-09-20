import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';

import { AdminApiClient } from '../libs/AdminApiClient.js';
import { Logger } from '../libs/Logger.js';
import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';
import {
  AdminSession,
  MEDIA_TYPE_AUDIO,
  MEDIA_TYPE_VIDEO,
  MediaType,
  REJECT_DURABILITY_FAILED,
  SourceConnectionIdentity,
} from '../types.js';
import { AbrGuard, readAbrConfig } from '../utils/abrConfig.js';
import { getErrorMessage } from '../utils/common.js';
import { optional, required } from '../utils/env.js';
import { assertUsablePublishKeySecret, hasValidPublishKey, publishKeyFromParam } from '../utils/publishKey.js';
import { isUsableStreamId } from '../utils/streamId.js';
import { redactUrlSecrets } from '../utils/urlSecrets.js';

import { assertUsableWebhookToken, hasValidWebhookToken } from './srs/webhookToken.js';
import { ADMIN_PUBLISH_ALLOWED, isAuthRefusal, resolveAdminPublish } from './adminGate.js';
import { EngineFactoryDeps, EnginePlugin } from './types.js';

const logger = Logger.getInstance();

// Re-exported from where it used to be declared, so nothing that named it has to move.
export type { AbrGuard };

export interface SrsEngineOptions {
  /** The ABR ladder, when one is configured. Absent means single-rendition, which is the default. */
  abr?: AbrGuard;
  /** Shared secret SRS carries in its hook URL. Empty rejects every webhook, it does not disable the check. */
  webhookToken?: string;
  /**
   * Master secret every stream's publish key is derived from. See SEC-28.
   *
   * Empty **disables** publisher authentication, which is the opposite of what `webhookToken` does
   * with the same value, and the difference is deliberate. That token is between two services an
   * operator configures together, so an empty one is a misconfiguration. This one is between the
   * deployment and its broadcasters, who have to be issued keys before any of them can publish, so
   * defaulting it on would take every existing broadcaster off the air the moment the service was
   * upgraded.
   *
   * ⚠️ Ignored entirely when `adminApi` is set. See {@link SrsEngineOptions.adminApi}.
   */
  publishKeySecret?: string;
  /**
   * The admin service, when `ADMIN_API_URL` is set. Present, it **replaces** `publishKeySecret`
   * rather than adding to it: a publish is resolved against a stream the admin has declared and
   * authenticated with the key that declaration carries, so there is no local secret to derive from
   * and nothing for a deployment to configure per broadcaster. See `engines/adminGate.ts`.
   */
  adminApi?: AdminApiClient;
  /**
   * The address this service signs its feeds with. Read only in admin mode, where the gate refuses a
   * declaration owned by another feed key. See {@link EngineFactoryDeps.signerOwner}.
   */
  signerOwner?: string;
  /** Lifecycle-v1 admission, present only when the SRS-specific feature switch is enabled. */
  managedLifecycle?: { uploaderId: string };
  /** Internal SRS control endpoint. Injectable for the exact cutoff request test. */
  apiUrl?: string;
  /** Injectable transport for the SRS control request. */
  fetcher?: typeof globalThis.fetch;
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
  vhost: string;
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
  /**
   * The publish URL's query string, which is where a broadcaster's publish key travels. See SEC-28.
   *
   * Measured on 2026-08-03 against `ossrs/srs:6`, the image this deployment pins: it arrives as
   * `?key=...`, **leading question mark included**, on `on_publish` and again on `on_unpublish`.
   * Optional for the same reason `ip` is: a build that omits it has to mean "presented nothing".
   */
  param?: string;
  server_id?: string;
  service_id?: string;
  client_id?: string;
}

interface SrsHlsPayload {
  action: SrsHlsAction;
  vhost: string;
  app: string;
  stream: string;
  file: string;
  seq_no: number;
  duration: number;
  server_id?: string;
  service_id?: string;
  client_id?: string;
}

interface ManagedRungConnection {
  readonly streamId: string;
  readonly baseStreamId: string;
  readonly source: SourceConnectionIdentity;
}

function connectionKey(payload: SrsStreamPayload | SrsHlsPayload): string | null {
  if (!payload.server_id || !payload.service_id || !payload.client_id) {
    return null;
  }
  return `${payload.server_id}\u0000${payload.service_id}\u0000${payload.client_id}`;
}

function sameSourceConnection(left: SourceConnectionIdentity, right: SourceConnectionIdentity): boolean {
  return (
    left.serverId === right.serverId &&
    left.serviceId === right.serviceId &&
    left.clientId === right.clientId &&
    left.generation === right.generation
  );
}

function srsResponse(res: Response, code: number): void {
  res.json(code);
}

function buildStreamId(app: string, stream: string): string {
  return `${app}/${stream}`;
}

/**
 * The name, rendered so that putting it in a log line cannot forge one.
 *
 * `app` and `stream` are relayed by SRS from whatever a publisher typed into their own publish url, so
 * a refused name is by definition one nobody has screened. `JSON.stringify` escapes the newlines and
 * control characters that would otherwise let it write log lines of its own.
 */
function forLog(streamId: string): string {
  return JSON.stringify(streamId);
}

/** The publisher's address, for `StreamClaimant`, or null when the webhook did not carry one whole. */
function publisherAddress(payload: SrsStreamPayload): string | null {
  return typeof payload?.ip === 'string' && payload.ip.length > 0 ? payload.ip : null;
}

export function createSrsEngineFromEnv(deps: EngineFactoryDeps = {}): EnginePlugin {
  const mediaPath = optional('SRS_MEDIA_PATH', './media');
  const webhookToken = required('SRS_WEBHOOK_TOKEN');
  const publishKeySecret = optional('PUBLISH_KEY_SECRET', '');
  const engine = createSrsEngine(mediaPath, {
    webhookToken,
    publishKeySecret,
    abr: readAbrConfig() ?? undefined,
    adminApi: deps.adminApi,
    signerOwner: deps.signerOwner,
    managedLifecycle: deps.managedLifecycle,
  });
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
          `${req.method} ${redactUrlSecrets(req.originalUrl)} from ${req.ip}`,
      );
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

export function createSrsEngine(mediaRootPath: string, options: SrsEngineOptions = {}): EnginePlugin {
  const webhookToken = options.webhookToken ?? '';
  const adminApi = options.adminApi;
  const signerOwner = options.signerOwner;
  const managedLifecycle = options.managedLifecycle;
  const apiUrl = options.apiUrl ?? 'http://srs:1985';
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (managedLifecycle && !adminApi) {
    throw new Error('SRS lifecycle version 1 requires ADMIN_API_URL');
  }
  // Blanked rather than read alongside, so no later change can accidentally consult both. The two
  // modes answer the same question — is this publisher the owner of this stream — from two different
  // sources of truth, and a deployment in which they disagree has no right answer.
  const publishKeySecret = adminApi ? '' : options.publishKeySecret ?? '';
  if (adminApi) {
    // The one boot line that says which mode this engine is in. Loud rather than debug: an operator
    // reading a refusal has to be able to tell "no declaration for this ingest id" from "wrong
    // derived key" without reading the source, and this is the line that tells them which gate ran.
    logger.info(
      `[SRS] Admin mode: every publish is resolved against ${adminApi.describe()} and authenticated with the ` +
        'key that declaration carries. PUBLISH_KEY_SECRET is ignored.',
    );
  } else if (publishKeySecret) {
    assertUsablePublishKeySecret(publishKeySecret);
  } else {
    // Not an error, but it is the one control that separates a broadcaster from anyone who knows the
    // stream name, and the stream name is in every HLS URL. Silence here would leave an operator
    // believing SEC-28 applies to a deployment where it does not.
    logger.warn(
      '[SRS] No PUBLISH_KEY_SECRET configured, so publishers are not authenticated and stream ownership ' +
        'is judged only by the address SRS reports. See SEC-28.',
    );
  }
  if (webhookToken) {
    assertUsableWebhookToken(webhookToken);
  } else {
    // Loud for the same reason `ome.ts` is loud about a missing admission secret: an engine that
    // rejects every webhook looks like a broadcaster problem from the outside, not a configuration
    // one, and nothing else in the process ever says otherwise.
    logger.warn('[SRS] No webhook token configured, every webhook will be rejected');
  }

  const abr = options.abr;
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

    createAuthMiddleware(): RequestHandler {
      return createWebhookGate(webhookToken);
    },

    createRouter(streamOrchestrator: StreamOrchestrator): Router {
      const router = Router();
      if (managedLifecycle) {
        streamOrchestrator.registerManagedSourceDisconnector((identity) => {
          void disconnectSrsClient(apiUrl, identity.clientId, fetcher);
        });
      }

      // Base streams that authenticated, so their rungs — republished onto the ABR vhost with no key
      // of their own — can be admitted by that origin. Empty and unread without a ladder. See SEC-28.
      //
      // ⛔ A map rather than a set, because in admin mode the base carries the declaration its rungs
      // publish under: the source is what presents the key and is resolved against the admin, and the
      // rungs that follow it inherit that session without a lookup of their own. `null` is the
      // standalone deployment, where membership alone is the whole of what the base proved. Reading a
      // base as "present" therefore still means exactly what it meant, which is what keeps SEC-28's
      // rule — a rung is admitted only because its base authenticated — unchanged.
      const authenticatedBases = new Map<string, AdminSession | null>();
      const managedConnections = new Map<string, SourceConnectionIdentity>();
      const managedBases = new Map<string, SourceConnectionIdentity>();
      const managedRungConnections = new Map<string, ManagedRungConnection>();
      const legacyRungConnections = new Map<string, string>();
      const legacyConnections = new Set<string>();
      let sourceGeneration = 0;

      router.use(createWebhookGate(webhookToken));

      router.post('/streams', (req: Request, res: Response) => {
        // `void` rather than awaited, because express does not await a handler and a returned
        // rejection would be an unhandled one. Nothing is lost: `handleStreams` has its own catch
        // around everything, and outside admin mode it reaches no `await` before it answers, so a
        // deployment that has not opted in still responds in the same synchronous turn it always did.
        void handleStreams(
          req,
          res,
          streamOrchestrator,
          { publishKeySecret, adminApi, signerOwner },
          abr,
          authenticatedBases,
          managedLifecycle,
          managedConnections,
          managedBases,
          managedRungConnections,
          legacyRungConnections,
          legacyConnections,
          () => ++sourceGeneration,
        );
      });

      router.post('/hls', (req: Request, res: Response) => {
        handleHls(
          req,
          res,
          streamOrchestrator,
          mediaRootPath,
          abr,
          managedLifecycle,
          managedConnections,
          managedBases,
          managedRungConnections,
          legacyRungConnections,
        );
      });

      return router;
    },
  };
}

async function disconnectSrsClient(apiUrl: string, clientId: string, fetcher: typeof globalThis.fetch): Promise<void> {
  const url = `${apiUrl.replace(/\/+$/, '')}/api/v1/clients/${encodeURIComponent(clientId)}`;
  try {
    const response = await fetcher(url, { method: 'DELETE' });
    const body = (await response.json()) as unknown;
    if (!response.ok || !body || typeof body !== 'object' || (body as Record<string, unknown>).code !== 0) {
      logger.error(`[SRS] Failed to disconnect managed publisher ${clientId}: SRS answered ${response.status}`);
    }
  } catch (error) {
    logger.error(`[SRS] Failed to disconnect managed publisher ${clientId}: ${getErrorMessage(error)}`);
  }
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
    logMisroutedRendition(streamId, payload.vhost, abr.vhost);
  } else {
    logger.debug(`[SRS] Ignoring source stream ${streamId} on vhost '${payload.vhost}' — the ladder is what publishes`);
  }

  return false;
}

/** A rendition that reached the wrong vhost, which SRS will re-transcode without limit. See ABR_VHOST. */
function logMisroutedRendition(streamId: string, actualVhost: string, expectedVhost: string): void {
  logger.error(
    `[SRS] Rendition ${streamId} arrived on vhost '${actualVhost}', expected '${expectedVhost}'. ` +
      `The transcode output's ?vhost= did not match — SRS falls back to __defaultVhost__, where the ` +
      `rendition is itself transcoded. Check ABR_VHOST and 'curl localhost:1985/api/v1/streams' for a ` +
      `stream count that keeps climbing.`,
  );
}

/**
 * Loopback is where SRS dials its own transcode republishes: `engines/srs/entrypoint.sh` points every
 * rung's output at `rtmp://127.0.0.1`, so a rung's publisher address is a loopback one. A rung carries
 * no publish key, and this origin, together with its base stream having authenticated, is the whole of
 * what admits it. See SEC-28.
 */
const SRS_LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopbackPublisher(payload: SrsStreamPayload): boolean {
  return typeof payload.ip === 'string' && SRS_LOOPBACK_ADDRESSES.has(payload.ip);
}

/**
 * How a stream webhook relates to the ladder, which is what decides how the publish authenticates and
 * whether the uploader ingests it. See SEC-28.
 *
 * `single` the ladder is off. The publish authenticates by its own key, exactly as it always has.
 * `source` the untranscoded broadcast, which a real broadcaster sends to the ingest vhost. It
 *   authenticates exactly as a single-rendition publish does — by its publish key, or in admin mode
 *   against the declaration for its ingest id — and is then left for SRS to transcode rather than
 *   ingested, because the ingest vhost stops segmenting once the ladder is on.
 * `rung` a transcode republish SRS dials from loopback onto the ABR vhost. It presents no key, so it
 *   is admitted only by that loopback origin and by its base stream having authenticated, and in
 *   admin mode it publishes under the declaration that base resolved. See {@link reasonToRefuseRung}.
 * `stray` a rendition whose `?vhost=` missed the ABR vhost, or a name on the ABR vhost that is no
 *   configured rung. Neither is ingested. A misrouted rendition is logged loudly, because otherwise
 *   the only symptom is a stream that never appears.
 */
type LadderStreamRole =
  | { kind: 'single' }
  | { kind: 'source' }
  | { kind: 'rung'; baseStreamId: string }
  | { kind: 'stray'; misroutedRendition: boolean };

function classifyLadderStream(payload: SrsStreamPayload, streamId: string, abr?: AbrGuard): LadderStreamRole {
  if (!abr) {
    return { kind: 'single' };
  }

  const match = abr.ladder.match(streamId);
  if (payload.vhost === abr.vhost) {
    // Only a transcode republish belongs on the ABR vhost. A name here that is no configured rung is
    // nothing the uploader can place on a ladder, so it is treated as stray and never ingested.
    return match ? { kind: 'rung', baseStreamId: match.baseStreamId } : { kind: 'stray', misroutedRendition: false };
  }

  // Off the ABR vhost with the ladder on. A rung name here is a rendition whose `?vhost=` missed and
  // fell back to the default vhost. Any other name is the untranscoded source, a real broadcaster.
  return match ? { kind: 'stray', misroutedRendition: true } : { kind: 'source' };
}

/**
 * Why a transcode republish may not be admitted, or null to admit it. See SEC-28.
 *
 * A rung carries no key: the transcode URL in `engines/srs/entrypoint.sh` has no `?key=`. Its base
 * stream having authenticated is what an attacker who merely knows the name cannot forge, and the
 * loopback origin is what keeps a co-tenant on the shared host from publishing a rung of its own.
 *
 * ⛔ In admin mode a base that authenticated always carries the declaration it resolved to, so a base
 * recorded with no session is a state no live sequence can produce. Refused rather than admitted
 * anyway: a rung started without one would mint a group of its own and publish a ladder the admin
 * never learns about and no viewer could find, which is precisely what `StreamOrchestrator.startStream`
 * refuses the generic `POST /stream/start` for.
 */
function reasonToRefuseRung(
  payload: SrsStreamPayload,
  baseStreamId: string,
  authenticatedBases: Map<string, AdminSession | null>,
  adminMode: boolean,
): string | null {
  if (!isLoopbackPublisher(payload)) {
    return 'it is not from the transcode loopback';
  }
  if (!authenticatedBases.has(baseStreamId)) {
    return 'its base stream never authenticated';
  }
  if (adminMode && !authenticatedBases.get(baseStreamId)) {
    return 'its base stream authenticated without a declaration, which admin mode has nothing to publish under';
  }
  return null;
}

function stopStreamQuietly(streamOrchestrator: StreamOrchestrator, streamId: string): void {
  streamOrchestrator.stopStream(streamId).catch((error) => {
    const msg = getErrorMessage(error);
    logger.error(`[SRS] Error during stream stop ${streamId}: ${msg}`);
  });
}

/**
 * What a publish has to prove, in whichever of the two mutually exclusive ways this deployment uses.
 *
 * Both fields together rather than one parameter each, because they are one decision: exactly one of
 * them is ever set, `createSrsEngine` is where that is enforced, and a signature that takes them
 * separately invites a later call site to pass both.
 */
interface SrsPublishGate {
  /** Derived-key mode. Empty means publishers are not authenticated, which is the default. */
  publishKeySecret: string;
  /** Admin mode. Set, the secret above is empty and every publish is resolved against a declaration. */
  adminApi?: AdminApiClient;
  /** The owner every feed this service writes resolves under, compared with each declaration's. */
  signerOwner?: string;
}

async function handleStreams(
  req: Request,
  res: Response,
  streamOrchestrator: StreamOrchestrator,
  gate: SrsPublishGate,
  abr?: AbrGuard,
  authenticatedBases: Map<string, AdminSession | null> = new Map(),
  managedLifecycle?: { uploaderId: string },
  managedConnections: Map<string, SourceConnectionIdentity> = new Map(),
  managedBases: Map<string, SourceConnectionIdentity> = new Map(),
  managedRungConnections: Map<string, ManagedRungConnection> = new Map(),
  legacyRungConnections: Map<string, string> = new Map(),
  legacyConnections: Set<string> = new Set(),
  nextSourceGeneration: () => number = () => 0,
): Promise<void> {
  const { publishKeySecret, adminApi, signerOwner } = gate;
  // Read before the try, so the catch below can tell a publish from anything else. A handler error on
  // a publish has to refuse when a secret is configured, and the action is the only thing that says
  // which kind of webhook was being handled.
  const action = (req.body as SrsStreamPayload | undefined)?.action;

  try {
    const payload = req.body as SrsStreamPayload;
    const streamId = buildStreamId(payload.app, payload.stream);

    // `utils/streamId.ts` states this rule as belonging to both ends, the schema for ids an operator
    // sends over HTTP and this for names a media engine relays over a webhook. OME's `parseAppStream`
    // has applied it since SEC-25. SRS never did, so the one engine that ships was the one admitting
    // whatever a publisher typed. An unpublish is answered rather than refused, for the same reason it
    // is everywhere else here: SRS reads any non-zero answer as a failure to retry, and the session an
    // unpublish names is already gone from its side.
    if (!isUsableStreamId(streamId)) {
      logger.warn(`[SRS] Refused a webhook naming an unusable app/stream: ${forLog(streamId)}`);
      srsResponse(res, payload.action === SRS_ACTION_PUBLISH ? SRS_REJECT : SRS_ACCEPT);
      return;
    }

    // How this stream authenticates depends on what it is to the ladder. ABR had folded this decision
    // into a single `isPublishable` gate that answered SRS_ACCEPT above the key check, so a real
    // broadcaster on the ingest vhost was admitted with no key whenever the ladder was on. See SEC-28.
    const role = classifyLadderStream(payload, streamId, abr);

    if (payload.action === SRS_ACTION_UNPUBLISH) {
      if (role.kind === 'stray') {
        srsResponse(res, SRS_ACCEPT);
        return;
      }

      if (role.kind === 'rung') {
        const key = connectionKey(payload);
        const managedRung = managedLifecycle && key ? managedRungConnections.get(key) : undefined;
        const legacyRung = managedLifecycle && key ? legacyRungConnections.get(key) : undefined;
        if (managedLifecycle && (managedRung || legacyRung || managedBases.has(role.baseStreamId))) {
          if (
            managedRung &&
            managedRung.streamId === streamId &&
            managedRung.baseStreamId === role.baseStreamId
          ) {
            managedRungConnections.delete(key as string);
          }
          if (legacyRung === streamId) {
            legacyRungConnections.delete(key as string);
            if (isLoopbackPublisher(payload)) {
              logger.info(`[SRS] Rung unpublished: ${streamId}`);
              stopStreamQuietly(streamOrchestrator, streamId);
            }
          }
          srsResponse(res, SRS_ACCEPT);
          return;
        }
        // No key to parse, so the acknowledgement is safe to send first. The base-authenticated
        // requirement is dropped on the stop side on purpose: a source that has already unpublished
        // has cleared its base, and a rung has to be able to stop cleanly rather than linger until the
        // orphan reaper takes it. The loopback origin is the gate.
        srsResponse(res, SRS_ACCEPT);
        if (isLoopbackPublisher(payload)) {
          logger.info(`[SRS] Rung unpublished: ${streamId}`);
          stopStreamQuietly(streamOrchestrator, streamId);
        }
        return;
      }

      if (managedLifecycle) {
        const key = connectionKey(payload);
        const identity = key ? managedConnections.get(key) : undefined;
        const isLegacy = key ? legacyConnections.has(key) : false;
        srsResponse(res, SRS_ACCEPT);
        if (identity) {
          streamOrchestrator.markManagedSourceUnpublished(streamId, identity);
          managedConnections.delete(key as string);
          if (role.kind === 'source') {
            authenticatedBases.delete(streamId);
          }
        } else if (isLegacy) {
          legacyConnections.delete(key as string);
          stopStreamQuietly(streamOrchestrator, streamId);
        }
        return;
      }

      // `single` or `source`: authenticated by the broadcaster's own key, which SRS repeats on the
      // unpublish. Extracted before anything is answered, so a `param` that cannot be parsed reaches
      // the catch below with the response still unsent. See SEC-29.
      //
      // ⚠️ In admin mode `publishKeySecret` is blank, so this check is off and an unpublish is
      // gated only by the webhook token — exactly as it is for every deployment that never set
      // PUBLISH_KEY_SECRET. Deliberate rather than overlooked: the expected key lives in the
      // declaration, so proving one here would mean a second lookup on the stop path, with an admin
      // outage then able to keep a finished broadcast from finalizing. The caller still has to hold
      // the webhook token, which is a service-to-service secret SRS is configured with.
      const isAuthenticated = hasValidPublishKey(publishKeySecret, streamId, publishKeyFromParam(payload.param));

      // SRS reads any non-zero answer as a failure to retry, and an unpublish is not a request that
      // can usefully be refused: the session it names is already gone from SRS's side. So a refusal
      // here is expressed by not acting, and SRS is acknowledged either way.
      srsResponse(res, SRS_ACCEPT);

      if (publishKeySecret && !isAuthenticated) {
        // Neither the key nor `param` is logged, only that one was missing or wrong.
        logger.warn(`[SRS] Ignored an unpublish of ${streamId} with a missing or invalid publish key`);
        // Reported rather than observed, because this answers 200 and the observer counts 401. See OBS-15.
        streamOrchestrator.recordAuthRejection();
        return;
      }

      if (role.kind === 'source') {
        // Its rungs must not outlive their base. Only after the key check, so a forged unpublish
        // cannot evict a live broadcaster's base and take the whole ladder down with it.
        authenticatedBases.delete(streamId);
        logger.info(`[SRS] Ladder source unpublished: ${streamId}`);
        return;
      }

      logger.info(`[SRS] Stream unpublished: ${streamId}`);
      stopStreamQuietly(streamOrchestrator, streamId);
      return;
    }

    if (payload.action !== SRS_ACTION_PUBLISH) {
      srsResponse(res, SRS_ACCEPT);
      return;
    }

    if (role.kind === 'stray') {
      // Not a stream the uploader publishes. Accept so SRS keeps running, ingest nothing. The
      // misrouted case is loud because otherwise the only symptom is a stream that never appears.
      if (role.misroutedRendition && abr) {
        logMisroutedRendition(streamId, payload.vhost, abr.vhost);
      } else {
        logger.debug(`[SRS] Ignoring ${streamId} on vhost '${payload.vhost}', no configured rung by that name`);
      }
      srsResponse(res, SRS_ACCEPT);
      return;
    }

    if (role.kind === 'rung') {
      const refusal = reasonToRefuseRung(payload, role.baseStreamId, authenticatedBases, adminApi !== undefined);
      if (refusal) {
        logger.warn(`[SRS] Rejected a rung publish of ${streamId}: ${refusal}`);
        // Reported rather than observed. SRS_REJECT rides inside a 200, so the status-code observer
        // never sees it. See OBS-15.
        streamOrchestrator.recordAuthRejection();
        srsResponse(res, SRS_REJECT);
        return;
      }

      logger.info(`[SRS] Rung published: ${streamId}`);
      const mediatype = resolveMediaType(payload.app);
      const claimant = { address: publisherAddress(payload), isAuthenticated: true };
      const admin = authenticatedBases.get(role.baseStreamId) ?? undefined;
      const managedBase = managedLifecycle ? managedBases.get(role.baseStreamId) : undefined;
      const key = connectionKey(payload);
      if (managedLifecycle && !key) {
        logger.error(`[SRS] Refused lifecycle-v1 rung publish ${streamId}: callback omitted connection identity`);
        srsResponse(res, SRS_REJECT);
        return;
      }
      let accepted: boolean;
      if (managedBase && admin) {
        accepted = streamOrchestrator.provisionManagedRendition(
          streamId,
          role.baseStreamId,
          managedBase,
          mediatype,
          claimant,
          admin,
        );
        if (accepted) {
          managedRungConnections.set(key as string, {
            streamId,
            baseStreamId: role.baseStreamId,
            source: managedBase,
          });
        }
      } else {
        accepted = streamOrchestrator.startStream(
          streamId,
          mediatype,
          claimant,
          // ⛔ The base's declaration, not a lookup of this rung's own. A rung's ingest id is
          // `video/<uuid>_720p`, which the admin has declared nothing under and never will: the
          // ladder is one declared stream and the rungs are what the transcoder makes of it.
          admin,
        );
        if (managedLifecycle && accepted) {
          legacyRungConnections.set(key as string, streamId);
        }
      }
      srsResponse(res, accepted ? SRS_ACCEPT : SRS_REJECT);
      return;
    }

    if (adminApi) {
      // `single` or `source`, and both resolve the same way: by the ingest id the broadcaster
      // published under — `video/<uuid>` either way, since a source is what a rung is transcoded from
      // — and by the key that declaration carries. What differs is what happens next, and only that.
      const mediatype = resolveMediaType(payload.app);
      const verdict = await resolveAdminPublish(
        adminApi,
        '[SRS]',
        streamId,
        mediatype,
        publishKeyFromParam(payload.param),
        signerOwner,
      );

      if (verdict.kind !== ADMIN_PUBLISH_ALLOWED) {
        if (isAuthRefusal(verdict.kind)) {
          // Reported rather than observed: SRS_REJECT rides inside a 200, so the status-code observer
          // never sees it. See OBS-15.
          streamOrchestrator.recordAuthRejection();
        }
        srsResponse(res, SRS_REJECT);
        return;
      }

      if (managedLifecycle && 'mode' in verdict.draft && verdict.draft.mode === 'managed') {
        const lifecycle = verdict.draft.lifecycle;
        if (
          lifecycle.uploaderId !== managedLifecycle.uploaderId ||
          lifecycle.permission === 'closed' ||
          (lifecycle.permission === 'claimed' && lifecycle.uploaderId !== managedLifecycle.uploaderId)
        ) {
          srsResponse(res, SRS_REJECT);
          return;
        }
        const key = connectionKey(payload);
        if (!key) {
          logger.error(`[SRS] Refused managed publish ${streamId}: callback omitted server_id, service_id or client_id`);
          srsResponse(res, SRS_REJECT);
          return;
        }
        const claimDecision = streamOrchestrator.beginManagedClaimAttempt({
          lifecycleVersion: 1,
          streamId,
          adminStreamId: verdict.draft.id,
          topic: verdict.draft.topic,
          mediaType: mediatype,
          revision: lifecycle.revision,
          runNumber: lifecycle.runNumber,
          uploaderId: lifecycle.uploaderId,
        });
        if (!claimDecision) {
          srsResponse(res, SRS_REJECT);
          return;
        }
        if (claimDecision.needsClaim) {
          const claimed = await adminApi.claimManagedRun(verdict.draft.id, lifecycle.runNumber, {
            lifecycleVersion: 1,
            expectedRevision: claimDecision.expectedRevision,
            uploaderId: lifecycle.uploaderId,
            requestId: claimDecision.requestId,
          });
          if (!streamOrchestrator.completeManagedClaim(streamId, claimed)) {
            srsResponse(res, SRS_REJECT);
            return;
          }
        }
        const identity: SourceConnectionIdentity = {
          serverId: payload.server_id as string,
          serviceId: payload.service_id as string,
          clientId: payload.client_id as string,
          generation: nextSourceGeneration(),
        };
        const admitted = streamOrchestrator.provisionManagedSource(
          streamId,
          mediatype,
          identity,
          { address: publisherAddress(payload), isAuthenticated: true },
          verdict.session,
        );
        if (admitted) {
          managedConnections.set(key, identity);
          managedBases.set(streamId, identity);
          if (role.kind === 'source') {
            authenticatedBases.set(streamId, verdict.session);
          }
        }
        srsResponse(res, admitted ? SRS_ACCEPT : SRS_REJECT);
        return;
      }

      if (role.kind === 'source') {
        // Not ingested, exactly as outside admin mode: the uploader publishes the ladder's rungs and
        // the source exists to be transcoded into them. What is remembered is the declaration rather
        // than a bare "this name authenticated", because the rungs that follow carry no key AND no
        // ingest id the admin has ever heard of, so this is the only point at which the broadcast
        // they belong to can be established. SRS_ACCEPT lets SRS go on to transcode it.
        authenticatedBases.set(streamId, verdict.session);
        logger.info(`[SRS] Ladder source authenticated: ${streamId}, declared as admin stream ${verdict.session.id}`);
        srsResponse(res, SRS_ACCEPT);
        return;
      }

      logger.info(`[SRS] Stream published: ${streamId} (${mediatype})`);
      const admitted = streamOrchestrator.startStream(
        streamId,
        mediatype,
        // Proven by the declaration's own key, so the takeover rules in `reasonToRefuseTakeover`
        // apply exactly as they do for a derived key. See SEC-26 and SEC-28.
        { address: publisherAddress(payload), isAuthenticated: true },
        verdict.session,
      );
      const legacyKey = connectionKey(payload);
      if (managedLifecycle && admitted && legacyKey) {
        legacyConnections.add(legacyKey);
      }
      srsResponse(res, admitted ? SRS_ACCEPT : SRS_REJECT);
      return;
    }

    // `single` or `source`: a real broadcaster, authenticated by its own publish key. Parsed before
    // any response so a `param` that cannot be parsed reaches the catch with the response unsent. See
    // SEC-28 and SEC-29.
    const isAuthenticated = hasValidPublishKey(publishKeySecret, streamId, publishKeyFromParam(payload.param));
    if (publishKeySecret && !isAuthenticated) {
      // The key itself is never logged, and neither is `param`, which is where it lives.
      logger.warn(`[SRS] Rejected a publish of ${streamId} with a missing or invalid publish key`);
      // Reported rather than observed. `SRS_REJECT` rides inside a 200, so the status-code observer
      // never sees it, and a live deployment refusing keyless publishes reported nothing. See OBS-15.
      streamOrchestrator.recordAuthRejection();
      srsResponse(res, SRS_REJECT);
      return;
    }

    if (role.kind === 'source') {
      // The uploader ingests the ladder's rungs, not the untranscoded source. Recording that the
      // source authenticated is the only thing that later admits those rungs, which arrive on the ABR
      // vhost with no key of their own. SRS_ACCEPT lets SRS go on to transcode it.
      //
      // `null` rather than a session: outside admin mode there is no declaration, and membership of
      // this map is the whole of what the base proved.
      authenticatedBases.set(streamId, null);
      logger.info(`[SRS] Ladder source authenticated: ${streamId}`);
      srsResponse(res, SRS_ACCEPT);
      return;
    }

    const mediatype = resolveMediaType(payload.app);
    logger.info(`[SRS] Stream published: ${streamId} (${mediatype})`);

    const accepted = streamOrchestrator.startStream(streamId, mediatype, {
      address: publisherAddress(payload),
      isAuthenticated,
    });
    srsResponse(res, accepted ? SRS_ACCEPT : SRS_REJECT);
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error(`[SRS] Stream handler error: ${msg}`);
    // A publish that threw before it could be screened is a publish that was never authenticated, and
    // answering SRS_ACCEPT admits it. `publishKeyFromParam` can throw for a `param` that is not a
    // string, which a real SRS never sends but a caller holding the webhook token can, and this catch
    // is wide enough to swallow anything a later change puts on the credential path. OME's equivalent
    // catch already honours `failOpen` and defaults to refusing, so this is the asymmetric half.
    //
    // Only when a secret is configured: without one nothing is authenticated anyway, and refusing
    // here would change the behaviour of a deployment that never opted in. Admin mode counts as
    // configured — it is the *only* thing standing between a publisher and a declared stream there,
    // and `publishKeySecret` is blanked in that mode, so reading it alone would fail this open.
    if ((publishKeySecret || adminApi) && action === SRS_ACTION_PUBLISH) {
      srsResponse(res, SRS_REJECT);
      return;
    }
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

/**
 * A segment SRS has finished writing.
 *
 * Legacy paths answer `SRS_ACCEPT`, including the ones that drop the segment. Answering a rejection
 * does not redeliver it. SRS keeps the stream running and silently drops every later segment, so a
 * managed durability failure rejects the callback and closes the source instead of pretending that
 * retry is possible. Other dropped segments are accounted so manifests do not present a media hole
 * as contiguous and the health signal can observe the loss.
 */
function handleHls(
  req: Request,
  res: Response,
  streamOrchestrator: StreamOrchestrator,
  mediaRootPath: string,
  abr?: AbrGuard,
  managedLifecycle?: { uploaderId: string },
  managedConnections: Map<string, SourceConnectionIdentity> = new Map(),
  managedBases: Map<string, SourceConnectionIdentity> = new Map(),
  managedRungConnections: Map<string, ManagedRungConnection> = new Map(),
  legacyRungConnections: Map<string, string> = new Map(),
): void {
  try {
    const payload = req.body as SrsHlsPayload;
    const streamId = buildStreamId(payload.app, payload.stream);

    // Ahead of the path resolution below, so a name nobody screened never reaches the filesystem at
    // all. No loss is recorded: an unusable name never started a stream, so there is no broadcast for
    // the gap to belong to.
    if (!isUsableStreamId(streamId)) {
      logger.warn(`[SRS] Refused a segment naming an unusable app/stream: ${forLog(streamId)}`);
      srsResponse(res, SRS_ACCEPT);
      return;
    }

    const role = classifyLadderStream(payload, streamId, abr);

    const key = connectionKey(payload);
    const managedRung = managedLifecycle && key ? managedRungConnections.get(key) : undefined;
    const legacyRung = managedLifecycle && key ? legacyRungConnections.get(key) : undefined;
    if (managedLifecycle && role.kind === 'rung') {
      const currentSource = managedBases.get(role.baseStreamId);
      const managedBindingIsCurrent =
        managedRung &&
        managedRung.streamId === streamId &&
        managedRung.baseStreamId === role.baseStreamId &&
        currentSource &&
        sameSourceConnection(managedRung.source, currentSource);
      if (!managedBindingIsCurrent && legacyRung !== streamId) {
        srsResponse(res, SRS_ACCEPT);
        return;
      }
    }

    const segmentPath = resolveSegmentPath(mediaRootPath, payload.file);

    if (!segmentPath) {
      logger.warn(`[SRS] Rejected segment path outside the media root for ${streamId}: ${payload.file}`);
      streamOrchestrator.handleSegmentLoss(streamId, payload.seq_no, 1);
      srsResponse(res, SRS_ACCEPT);
      return;
    }

    if (!fs.existsSync(segmentPath)) {
      logger.warn(`[SRS] Segment file not found: ${segmentPath}`);
      streamOrchestrator.handleSegmentLoss(streamId, payload.seq_no, 1);
      srsResponse(res, SRS_ACCEPT);
      return;
    }

    const segmentData = fs.readFileSync(segmentPath);
    const managedIdentity = managedLifecycle && key ? managedConnections.get(key) : undefined;
    const managedRungSource = managedRung?.source;
    if (!managedIdentity && !isPublishable(payload, streamId, abr)) {
      srsResponse(res, SRS_ACCEPT);
      return;
    }
    const result = managedIdentity
      ? role.kind === 'source'
        ? streamOrchestrator.handleManagedSourceProgress(streamId, managedIdentity, payload.duration, segmentData)
        : streamOrchestrator.handleManagedSegment(
            streamId,
            managedIdentity,
            payload.seq_no,
            payload.duration,
            segmentData,
          )
      : managedRungSource && role.kind === 'rung'
        ? streamOrchestrator.handleManagedRenditionSegment(
            streamId,
            role.baseStreamId,
            managedRungSource,
            payload.seq_no,
            payload.duration,
            segmentData,
          )
        : streamOrchestrator.handleSegment(streamId, payload.seq_no, payload.duration, segmentData);

    if (result.accepted) {
      fs.rmSync(segmentPath, { force: true });
    } else {
      logger.warn(`[SRS] Segment ${payload.seq_no} not accepted for ${streamId}: ${result.reason}`);
      if (result.reason === REJECT_DURABILITY_FAILED && (managedIdentity || managedRungSource)) {
        streamOrchestrator.failManagedSource(
          role.kind === 'rung' ? role.baseStreamId : streamId,
          managedIdentity ?? (managedRungSource as SourceConnectionIdentity),
        );
        srsResponse(res, SRS_REJECT);
        return;
      }
      streamOrchestrator.handleSegmentLoss(streamId, payload.seq_no, 1);
    }

    srsResponse(res, SRS_ACCEPT);
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error(`[SRS] HLS handler error: ${msg}`);
    if (managedLifecycle) {
      const payload = req.body as Partial<SrsHlsPayload>;
      const key = connectionKey(payload as SrsHlsPayload);
      const identity = key ? managedConnections.get(key) ?? managedRungConnections.get(key)?.source : undefined;
      if (identity && typeof payload.app === 'string' && typeof payload.stream === 'string') {
        const streamId = buildStreamId(payload.app, payload.stream);
        const role = classifyLadderStream(payload as SrsHlsPayload, streamId, abr);
        streamOrchestrator.failManagedSource(role.kind === 'rung' ? role.baseStreamId : streamId, identity);
        srsResponse(res, SRS_REJECT);
        return;
      }
    }
    srsResponse(res, SRS_ACCEPT);
  }
}
