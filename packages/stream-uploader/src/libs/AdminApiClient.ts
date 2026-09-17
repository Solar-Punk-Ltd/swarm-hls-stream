import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MediaType, Rendition } from '../types.js';
import { getErrorMessage } from '../utils/common.js';

import { Logger } from './Logger.js';

/**
 * The admin service this uploader answers to when `ADMIN_API_URL` is set. See the "Admin mode"
 * section of the package README.
 *
 * ## What admin mode moves, and why it is a client rather than a catalog
 *
 * Without it, a broadcast is announced by whoever can reach the ingest port with the right key, the
 * uploader mints the feed topic, and the stream catalog on Swarm is the only record that the
 * broadcast exists. Admin mode inverts all three: a stream is *declared first* in the admin service,
 * which mints the topic and the publish key, and the uploader's job is to recognise the ingest
 * session as one of those declarations and to report where it got to. The catalog is then the
 * admin's to write, not this service's — see {@link StreamUploader} for what that suppresses.
 *
 * ## Why the two calls have such different failure policies
 *
 * `lookupByIngestId` runs inside a publish gate, with an engine waiting on the answer and a
 * broadcaster waiting on the engine. There is nothing to retry *into*: a publish that cannot be
 * resolved has to be refused, and refusing takes one round trip rather than three. It therefore
 * throws on everything except a clean 404, and the gate turns a throw into a refusal.
 *
 * `reportState` runs behind a broadcast that is already live. Nobody is waiting, the thing being
 * reported has already happened, and a lost report is a stream that plays perfectly and is
 * mislabelled in the admin's own list. So it retries, and it never throws: the caller reads the
 * outcome and decides, because the two callers want different things from a failure — see
 * {@link StateReportOutcome}.
 *
 * `reportRendition` follows `reportState`'s policy exactly, on the same ladder and the same timeout,
 * and for the same reason: a rung announcing itself is behind a broadcast that is already running.
 * What it is NOT is optional — the admin holds the ladder's merge state in admin mode, so a report
 * that never lands is a rung missing from the master every viewer resolves. The caller treats a
 * failure as a failed catalog announce and re-attempts on the announce cadence. See
 * `libs/AdminLadderSink.ts`.
 */

/** Minimum length for `ADMIN_API_TOKEN`, matching `API_AUTH_TOKEN`'s and the SRS webhook token's. */
export const MIN_ADMIN_API_TOKEN_LENGTH = 32;

/**
 * How long one lookup may take before the gate gives up on it.
 *
 * Bounded by what the engine is holding open, not by what the network might need. SRS waits on the
 * `on_publish` webhook before it admits a publisher and OME's admission timeout is 3000ms, so a
 * lookup that spends much longer than this turns "the admin is slow" into "the engine gave up on the
 * uploader", which is a worse failure than a refusal because it is invisible from this side.
 */
const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * How long one state report may take. Twice the lookup's, because nobody is waiting on it and the
 * report the admin has to act on — the VOD flip — is the one it does the most work for.
 */
const DEFAULT_REPORT_TIMEOUT_MS = 10_000;

/**
 * How many times a state report is attempted, and how long it waits in between.
 *
 * Tripling rather than doubling, so three attempts span four seconds rather than three, which is
 * long enough to cross an admin restart and short enough that a finalize is not held for the length
 * of a broadcast. The ladder has one fewer entry than the attempt count by construction: the wait is
 * what happens *between* two attempts, so a fourth attempt would wait 9s.
 */
export const MAX_STATE_REPORT_ATTEMPTS = 3;
export const STATE_REPORT_BACKOFF_MS = [1_000, 3_000] as const;

/** The states a report may claim. `live` on the first published manifest, `vod` once the recording is in the feed. */
export const ADMIN_STATE_LIVE = 'live' as const;
export const ADMIN_STATE_VOD = 'vod' as const;

export type AdminStateReport =
  | { state: typeof ADMIN_STATE_LIVE }
  | {
      state: typeof ADMIN_STATE_VOD;
      /** Feed index of the final manifest, which is what a viewer is pointed at. */
      index: number;
      /** Playing time of the recording in seconds. */
      duration: number;
    };

/**
 * A stream the admin has already declared, resolved from the ingest id an engine reported.
 *
 * The fields this service acts on are `topic`, `publishKey`, `mediaType` and `id`. `owner`, `title`
 * and `status` are carried because they are in the contract and reading them back is how an operator
 * tells a resolved draft from a stale one in a log line; nothing here decides anything on them.
 */
export interface AdminStreamDraft {
  id: string;
  topic: string;
  owner: string;
  mediaType: MediaType;
  title: string;
  status: string;
  publishKey: string;
}

/**
 * What became of a state report.
 *
 * Three outcomes rather than a boolean, because `already-settled` is neither a success nor a failure
 * and the two callers must not treat it as either. The admin answers 409 when the transition it was
 * asked for cannot follow the state it holds, and the commonest way to reach that is a report this
 * uploader has already delivered — a finalize resumed after a crash, say. Retrying that forever
 * would strand the broadcast; counting it as a fresh success would announce a flip that this run did
 * not cause.
 */
export const STATE_REPORT_ACCEPTED = 'accepted' as const;
export const STATE_REPORT_ALREADY_SETTLED = 'already-settled' as const;
export const STATE_REPORT_FAILED = 'failed' as const;

export type StateReportOutcome =
  | typeof STATE_REPORT_ACCEPTED
  | typeof STATE_REPORT_ALREADY_SETTLED
  | typeof STATE_REPORT_FAILED;

/** Whether the admin now holds the state that was reported, however it got there. */
export function stateWasReported(outcome: StateReportOutcome): boolean {
  return outcome !== STATE_REPORT_FAILED;
}

/**
 * The ladder as the admin holds it after folding one rung's record into it.
 *
 * Only the fields this service acts on are declared. The route also answers the whole stream row and
 * the catalog feed write the report caused — both in the contract — and of those only the row's
 * `status` is read, so the rest is deliberately left unnamed rather than carried as fields nothing
 * reads.
 */
export interface RenditionReportResponse {
  /** Every rung the admin holds for this stream after the fold, ascending by height. */
  renditions: Rendition[];
  /**
   * The stream's status as the admin holds it after this report, or null when the body did not say.
   *
   * Read for one decision: whether a ladder that is `finished` has been reported `vod` yet. The admin
   * flips `flippedToFinished` once, on the report that completed the fold, and if the master write
   * behind that report failed the flip is gone for good; the status is what lets the next announce
   * see that the ladder is finished and the admin still says `live`, and report `vod` after all.
   */
  streamStatus: string | null;
  ladder: {
    /** Every rendition on record carries an index, and there is at least one. */
    finished: boolean;
    /** Finished now, and not finished before this report. At most one report per broadcast sees it. */
    flippedToFinished: boolean;
    /** The recording's playing time in seconds when finished, and null while it is not. */
    duration: number | null;
  };
}

interface AdminApiClientOptions {
  baseUrl: string;
  token: string;
  lookupTimeoutMs?: number;
  reportTimeoutMs?: number;
  /** Injected so a test can drive the retry ladder without spending its wall clock on the waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected the way the OME puller's is, so a network path can be driven without a socket. */
  fetcher?: typeof globalThis.fetch;
}

/**
 * "This attempt failed and the next one may not", kept apart from the `null` a settled failure
 * answers with, which for a rendition report is a value the caller acts on rather than a sentinel.
 */
const RENDITION_REPORT_RETRY = Symbol('rendition-report-retry');

/** Statuses that mean "ask again": the admin is there and could not answer this time. */
function isRetryableReportStatus(status: number): boolean {
  return status >= 500;
}

export function assertUsableAdminApiToken(token: string): void {
  if (token.length < MIN_ADMIN_API_TOKEN_LENGTH) {
    throw new Error(`ADMIN_API_TOKEN must be at least ${MIN_ADMIN_API_TOKEN_LENGTH} characters`);
  }
}

/**
 * Whether a body the admin sent back really is a draft.
 *
 * Screened rather than cast, because the fields decide who may publish and where the broadcast is
 * written. A body missing `publishKey` would otherwise arrive as `undefined`, and an undefined
 * expectation compared against a presented key is a comparison that can only be got wrong. A missing
 * `topic` would mint a feed at `Topic.fromString(undefined)`. Both are refusals, and a refusal has to
 * be spelled here rather than discovered three layers down.
 */
function asDraft(body: unknown): AdminStreamDraft | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const candidate = body as Record<string, unknown>;
  const strings = ['id', 'topic', 'owner', 'title', 'status', 'publishKey'] as const;
  for (const field of strings) {
    if (typeof candidate[field] !== 'string' || (candidate[field] as string).length === 0) {
      return null;
    }
  }
  if (candidate.mediaType !== MEDIA_TYPE_VIDEO && candidate.mediaType !== MEDIA_TYPE_AUDIO) {
    return null;
  }
  return candidate as unknown as AdminStreamDraft;
}

/**
 * Whether one entry of a merged ladder really is a rendition.
 *
 * Screened rather than cast, for the reason {@link asDraft} is and then one step further: what is
 * built out of these is the master playlist every viewer of the broadcast resolves, through
 * `buildMasterPlaylist`. A missing `topic` would address a rung's feed at `Topic.fromString(undefined)`,
 * a missing `bandwidth` would write `BANDWIDTH=undefined` into a tag hls.js parses, and a `height`
 * that is not a number would sort the ladder into an order no player can climb. Every one of those is
 * a broadcast that publishes and cannot be played, discovered by a viewer rather than here.
 *
 * ⛔ `index` and `duration` are either both present or both absent, which is the contract's own rule
 * and `keepingWhatFinished`'s: the index names a position inside the feed the topic addresses and the
 * duration is what the entry that points at it carries, so one without the other is a recording
 * nothing can be said about.
 */
function isRendition(value: unknown): value is Rendition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || candidate.name.length === 0) {
    return false;
  }
  if (typeof candidate.topic !== 'string' || candidate.topic.length === 0) {
    return false;
  }
  for (const field of ['width', 'height', 'bandwidth', 'avgBandwidth'] as const) {
    if (typeof candidate[field] !== 'number' || !Number.isFinite(candidate[field])) {
      return false;
    }
  }
  const finished = candidate.index !== undefined;
  if (finished !== (candidate.duration !== undefined)) {
    return false;
  }
  return !finished || (typeof candidate.index === 'number' && typeof candidate.duration === 'number');
}

/** Whether a body the admin sent back really is a merged ladder. See {@link isRendition}. */
function asRenditionReport(body: unknown): RenditionReportResponse | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const candidate = body as Record<string, unknown>;
  if (!Array.isArray(candidate.renditions) || !candidate.renditions.every(isRendition)) {
    return null;
  }
  const ladder = candidate.ladder;
  if (typeof ladder !== 'object' || ladder === null) {
    return null;
  }
  const state = ladder as Record<string, unknown>;
  if (typeof state.finished !== 'boolean' || typeof state.flippedToFinished !== 'boolean') {
    return null;
  }
  if (state.duration !== null && typeof state.duration !== 'number') {
    return null;
  }
  // Optional rather than screened: a body without it is still a ladder, and the caller then falls
  // back to the flip alone, which is what it had before the status was read at all.
  const stream = candidate.stream;
  const status =
    typeof stream === 'object' && stream !== null && typeof (stream as Record<string, unknown>).status === 'string'
      ? ((stream as Record<string, unknown>).status as string)
      : null;
  return {
    renditions: candidate.renditions as Rendition[],
    streamStatus: status,
    ladder: {
      finished: state.finished,
      flippedToFinished: state.flippedToFinished,
      duration: state.duration as number | null,
    },
  };
}

export class AdminApiClient {
  private readonly logger = Logger.getInstance();
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly lookupTimeoutMs: number;
  private readonly reportTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: AdminApiClientOptions) {
    assertUsableAdminApiToken(options.token);
    // Trailing slash removed once here rather than guarded at each call site: `${base}/api/...` with
    // a configured `http://admin:9877/` would otherwise produce a double slash, which an admin behind
    // a router answers 404 to, and a 404 on a lookup means "no such stream" rather than "bad url".
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
    this.reportTimeoutMs = options.reportTimeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  /** Where this client is pointed, for the one boot line that says which mode the service is in. */
  public describe(): string {
    return this.baseUrl;
  }

  /**
   * The stream the admin declared for this ingest id, or null when it has declared none.
   *
   * ⛔ Null means exactly one thing: the admin answered 404, so nobody announced this ingest id. Every
   * other outcome throws, including a 200 whose body is not a draft, because the caller turns null
   * into "refuse this publish and say why" and a failed lookup must never be spelled that way. The
   * two are indistinguishable to the broadcaster and completely different to whoever is on call.
   *
   * @param streamId the engine's own `app/stream`, which is the key the admin filed the draft under.
   */
  public async lookupByIngestId(streamId: string): Promise<AdminStreamDraft | null> {
    // Encoded per segment even though `isUsableStreamId` has already restricted these to
    // `[A-Za-z0-9._-]`, where encoding is a no-op. The screening lives in the engines and this is a
    // url; a caller added later that skips it must not be able to write a path of its own.
    const path = streamId
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const url = `${this.baseUrl}/api/internal/streams/by-ingest/${path}`;

    const response = await this.send(url, { method: 'GET' }, this.lookupTimeoutMs);

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Admin API answered ${response.status} for ${url}`);
    }

    const draft = asDraft(await this.readJson(response));
    if (draft === null) {
      throw new Error(`Admin API answered 200 for ${url} with a body that is not a stream`);
    }
    return draft;
  }

  /**
   * Tell the admin where a broadcast got to.
   *
   * Never throws: a report is about something that has already happened, and the callers are a live
   * manifest publish and a finalize, neither of which is improved by an exception travelling up
   * through it. The verdict comes back as a value instead, and the caller decides what a failure
   * costs — the live report is retried on the catalog announce's own cadence, the VOD report leaves
   * the recovery entry on disk for the next boot.
   */
  public async reportState(id: string, report: AdminStateReport): Promise<StateReportOutcome> {
    const url = `${this.baseUrl}/api/internal/streams/${encodeURIComponent(id)}/state`;
    const body = JSON.stringify(report);

    for (let attempt = 1; attempt <= MAX_STATE_REPORT_ATTEMPTS; attempt++) {
      const outcome = await this.attemptReport(url, body, report, attempt);
      if (outcome !== null) {
        return outcome;
      }
      const wait = STATE_REPORT_BACKOFF_MS[attempt - 1];
      if (wait !== undefined) {
        await this.sleep(wait);
      }
    }

    this.logger.error(
      `[Admin] Gave up reporting ${report.state} for stream ${id} after ${MAX_STATE_REPORT_ATTEMPTS} attempts. ` +
        'The broadcast itself is unaffected; the admin now holds a state older than the feed.',
    );
    return STATE_REPORT_FAILED;
  }

  /**
   * Fold one rung of a ladder into the ladder the admin holds, and read back what it now holds.
   *
   * ⛔ Never throws, exactly like {@link reportState}, and for the same reason: the caller is a live
   * announce path and a finalize, neither of which is improved by an exception travelling up through
   * it. `null` is the one failure value — the admin refused it, or could not be reached across the
   * whole ladder — and the caller turns that into a failed announce, which the uploader re-attempts on
   * `CATALOG_ANNOUNCE_RETRY_MS`. The fold is idempotent, so a whole report repeating is safe.
   *
   * ⚠️ A 409 is NOT `already-settled` here, which is where this parts company with `reportState`. The
   * admin answers it for a stream that is still a draft or has a catalog write in flight, so it means
   * "not yet" rather than "already": retrying inside the ladder buys nothing for the first and the
   * announce cadence covers the second.
   *
   * @param id the admin's own id for the stream, which is the ladder rather than the rung.
   */
  public async reportRendition(id: string, rendition: Rendition): Promise<RenditionReportResponse | null> {
    const url = `${this.baseUrl}/api/internal/streams/${encodeURIComponent(id)}/renditions`;
    const body = JSON.stringify(rendition);

    for (let attempt = 1; attempt <= MAX_STATE_REPORT_ATTEMPTS; attempt++) {
      const outcome = await this.attemptRenditionReport(url, body, rendition.name, attempt);
      if (outcome !== RENDITION_REPORT_RETRY) {
        return outcome;
      }
      const wait = STATE_REPORT_BACKOFF_MS[attempt - 1];
      if (wait !== undefined) {
        await this.sleep(wait);
      }
    }

    this.logger.error(
      `[Admin] Gave up reporting rendition ${rendition.name} for stream ${id} after ` +
        `${MAX_STATE_REPORT_ATTEMPTS} attempts. The rung is publishing; the ladder the admin holds is ` +
        'missing it, so the master cannot be written from it until a later announce lands.',
    );
    return null;
  }

  /**
   * One attempt at a rendition report: the merged ladder, `null` for a settled refusal, or the retry
   * sentinel for a failure worth repeating.
   *
   * A sentinel rather than `null` for the retryable case, because `null` is already the value the
   * caller acts on and the two must not collide. Everything else mirrors {@link attemptReport}.
   */
  private async attemptRenditionReport(
    url: string,
    body: string,
    rung: string,
    attempt: number,
  ): Promise<RenditionReportResponse | null | typeof RENDITION_REPORT_RETRY> {
    try {
      const response = await this.send(
        url,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body },
        this.reportTimeoutMs,
      );

      if (response.ok) {
        const report = asRenditionReport(await this.readJson(response));
        if (report === null) {
          this.logger.error(
            `[Admin] Report of rendition ${rung} answered 200 for ${url} with a body that is not a ladder`,
          );
        }
        return report;
      }
      if (!isRetryableReportStatus(response.status)) {
        this.logger.error(`[Admin] Report of rendition ${rung} refused with ${response.status} for ${url}`);
        return null;
      }
      this.logger.warn(
        `[Admin] Report of rendition ${rung} answered ${response.status} for ${url}, attempt ${attempt}`,
      );
      return RENDITION_REPORT_RETRY;
    } catch (error) {
      this.logger.warn(
        `[Admin] Report of rendition ${rung} to ${url} did not complete on attempt ${attempt}: ${getErrorMessage(
          error,
        )}`,
      );
      return RENDITION_REPORT_RETRY;
    }
  }

  /**
   * One attempt at a report, or null when the attempt failed in a way that is worth repeating.
   *
   * Null rather than a thrown error for the retryable case, so the loop above reads as the policy it
   * is. A 4xx that is not 409 ends the loop immediately: a rejected token or an unknown id does not
   * become true by being asked again, and spending four seconds discovering that delays a finalize.
   */
  private async attemptReport(
    url: string,
    body: string,
    report: AdminStateReport,
    attempt: number,
  ): Promise<StateReportOutcome | null> {
    try {
      const response = await this.send(
        url,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body },
        this.reportTimeoutMs,
      );

      if (response.ok) {
        return STATE_REPORT_ACCEPTED;
      }
      if (response.status === 409) {
        this.logger.warn(
          `[Admin] Refused the ${report.state} report for ${url} as an invalid transition, which is what it ` +
            'answers for a state it already holds. Treating the state as settled rather than retrying.',
        );
        return STATE_REPORT_ALREADY_SETTLED;
      }
      if (!isRetryableReportStatus(response.status)) {
        this.logger.error(`[Admin] Report of ${report.state} refused with ${response.status} for ${url}`);
        return STATE_REPORT_FAILED;
      }
      this.logger.warn(`[Admin] Report of ${report.state} answered ${response.status} for ${url}, attempt ${attempt}`);
      return null;
    } catch (error) {
      // A timeout, a refused connection, a DNS failure: the admin was not reachable at all, which is
      // the case the retry ladder exists for.
      this.logger.warn(
        `[Admin] Report of ${report.state} to ${url} did not complete on attempt ${attempt}: ${getErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * One request, with the bearer token and an abort window on it.
   *
   * `AbortSignal.timeout` rather than a timer of our own, because node's fetch has no default
   * timeout at all: a connection the admin accepts and then holds open would otherwise stall a
   * publish gate for as long as the socket lives, which is exactly the failure
   * `BEE_REQUEST_TIMEOUT_MS` was added for on the bee side.
   */
  private send(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return this.fetcher(url, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** A body that is not JSON is a body that is not a draft, and the caller says so for both. */
  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}
