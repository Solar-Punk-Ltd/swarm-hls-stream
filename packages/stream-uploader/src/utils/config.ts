import { assertUsableAdminApiToken } from '../libs/AdminApiClient.js';
import { parsePublisherSpecs, PublisherSpec } from '../libs/BeePublisherPool.js';
import { gatePolicyFor, parseStartGateMode, START_GATE_CHEQUEBOOK_WARN } from '../libs/StartGates.js';

import { readAbrConfig } from './abrConfig.js';
import { optional, optionalInt, optionalNumber, required } from './env.js';

/**
 * How much SWAP chequebook balance every Bee node must hold before the uploader will start.
 *
 * 0.5 BZZ is the same number `e2e/suites/preflight/chequebook-funding.test.ts` demands before a paid
 * sitting, kept in step deliberately so the service and the suite refuse at the same point.
 *
 * **The measure is `availableBalance`, never `totalBalance`.** Total counts value the node has
 * already promised away in cheques its peers have not cashed, so a node with nothing left to spend
 * still reports a healthy total. Available is what remains uncommitted, which is the only one of the
 * two that answers whether the next segment can be paid for.
 *
 * Zero is a legal setting and means "read every chequebook but accept any balance". It does not
 * disable the check: a chequebook that cannot be read at all is still reported, because a node
 * running with SWAP off has none to fill. Under the shipped `chequebook-warn` that report is a
 * warning on `/health` and the uploader starts. Under `refuse` it stops the boot.
 */
const DEFAULT_CHEQUEBOOK_MIN_BZZ = 0.5;

/**
 * A floor this high is a typo rather than a policy. It also keeps the conversion into PLUR, which
 * multiplies by 1e16, well inside the range where the arithmetic stays finite.
 */
const MAX_CHEQUEBOOK_MIN_BZZ = 1000;

/**
 * How much time a postage batch must have left before the uploader will start on it.
 *
 * Twelve hours. A batch that expires mid-broadcast stops keeping everything stored under it, the
 * whole broadcast and its recording, so the floor has to outlast the longest run a deployment books.
 * Half a day is longer than the 3 to 6 hour broadcasts booked here and short enough that a two-day
 * batch, which is what this stack buys, clears it for most of its life. A deployment that streams
 * for longer than half a day raises this to cover the run.
 *
 * Both earlier values are on the record. It was a day until 2026-09-15. A day is longer than any
 * sitting anyone books here, so the floor refused batches that had hours of life left and every run
 * those batches could have carried, which is a gate failing closed on work it was never meant to
 * stop. The correction to an hour landed the same day and overshot the other way: an hour is
 * shorter than a single booked broadcast, so the gate would admit a batch that expires part way
 * through and takes the broadcast with it. The owner ruled twelve later that day, in the middle.
 */
const DEFAULT_STAMP_MIN_TTL_HOURS = 12;
const MAX_STAMP_MIN_TTL_HOURS = 24 * 365;

/**
 * How full a postage batch may be before the uploader will start on it.
 *
 * An immutable batch that reaches capacity stops accepting chunks, and that arrives as a failed
 * upload rather than as a warning. 0.9 leaves a tenth of the batch for the run ahead.
 *
 * ⚠️ It is deliberately a ceiling on a ratio rather than a byte figure, because how fast a batch
 * fills depends on the rung: across the shipped ladder 1080p burns roughly seven times the bytes of
 * 360p, so no single amount of headroom means the same thing on two rungs.
 */
const DEFAULT_STAMP_MAX_UTILIZATION = 0.9;

/**
 * Nominal seconds of media per fragment, matching `HLS_FRAGMENT`'s default in `docker-compose.yml`.
 *
 * ⚠️ It is what the deployment **asks** the engine to cut at, never what a segment measured. Under
 * a ladder the two agree, because each rung is re-GOPed at `ABR_FPS x HLS_FRAGMENT` and SRS then
 * cuts exactly there. On a single-rendition stream the publisher's own keyframe interval decides the
 * segment and this is only a floor, so a broadcaster sending a longer GOP produces segments longer
 * than this. Those are dated by what they really held, and it is the gap entries and the budgets
 * derived from this that then describe a stage nobody is running. See `deploy/README.md`.
 *
 * The bounds are the range SRS itself will work in: below a frame the entrypoint refuses the GOP
 * arithmetic outright, and an hour is `isUsableDuration`'s own ceiling on a segment.
 */
const DEFAULT_HLS_FRAGMENT_SECONDS = 0.5;
const MIN_HLS_FRAGMENT_SECONDS = 0.01;
const MAX_HLS_FRAGMENT_SECONDS = 3600;

/**
 * How long the uploader waits for one HTTP request to a Bee node before it gives up on that request.
 *
 * ⛔⛔⛔ **There was no such bound, and a node that answered nothing held a queue for ever.** Every
 * pooled client was built as `new Bee(url)` with no options, and bee-js hands axios
 * `timeout: options?.timeout ?? 0`, which axios reads as no timeout at all. A node that accepted the
 * connection and then went silent therefore never failed: the upload queue runs at concurrency 1, so
 * one such call stopped that rung, and the same call on the coordinator stopped the catalog for every
 * stream on the stage.
 *
 * **The default is derived, not chosen.** Every bee call the service makes sits inside
 * `retryUntilDeadlineAsync`, and the shortest window any of them gets is 10s: `CATALOG_RETRY_WINDOW_MS`
 * in `StreamCatalog.ts` and `MASTER_RETRY_WINDOW_MS` in `MasterFeedWriter.ts`, against 15s for the
 * three in `StreamUploader.ts`. The first backoff is 350ms before jitter halves it, so two whole
 * attempts fit inside 10s for any timeout up to 4825ms. 4s is that with room left over, and it keeps a
 * retry worth having: shorten a window below 8.35s and this becomes the wrong number, which is why
 * `test/config.test.ts` reads those windows out of the files that declare them and re-derives it.
 *
 * The two startup gates and the reachability probe in front of them are what this no longer bounds.
 * The gates' reads have no retry around them and answer off the chain rather than out of the node, so
 * they were the calls this derivation was never about, and the probe reads through the same pool so
 * that a node the gates would wait twenty seconds for is not failed in four. All three run on
 * START_GATE_TIMEOUT_MS below, since 2026-09-17.
 */
const DEFAULT_BEE_REQUEST_TIMEOUT_MS = 4000;

/**
 * How long one startup gate's read of a node, or the liveness probe in front of the gates, may take
 * before it gives up on that node.
 *
 * ⛔ Separate from BEE_REQUEST_TIMEOUT_MS above, and the separation is the fix rather than a tidy-up.
 * A chequebook balance and a postage batch are answered from the chain, not from the node's own
 * memory, so they are the slowest reads the service makes, while the 4000ms above is derived from
 * the retry windows of the upload loop and describes nothing about them. On 2026-09-16 a live ABR
 * uploader spent its whole life restarting on "timeout of 4000ms exceeded" from a chequebook read,
 * which was a number borrowed from another question being applied to this one.
 *
 * Twenty seconds is long enough for a cold node to answer a chain-backed read and short enough that a
 * `warn` pass over a hanging pool of four nodes finishes in under three minutes before the wait goes
 * round again. The API is listening throughout either way, since D16. It costs nothing on a healthy
 * boot, where both gates finish in milliseconds.
 */
const DEFAULT_START_GATE_TIMEOUT_MS = 20_000;

/**
 * Ten minutes, and a ceiling rather than decoration.
 *
 * A chain-backed read that has not answered in ten minutes is a node that is not answering, and since
 * decision D16 this budget is spent per node per attempt of a wait that retries for as long as it
 * takes.
 *
 * ⚠️ What this ceiling catches is the two-zero slip: 2000000 is 33 minutes for one read and over four
 * hours for a `warn` pass over four nodes, and it is refused here. The one-zero slip is not caught
 * and cannot be without refusing settings an operator may mean: 200000 sits under this ceiling, is
 * accepted, and costs about 26 minutes a pass. `CHEQUEBOOK_MIN_BZZ` has a maximum for the same
 * reason and with the same limit: a typo must not be a setting, as far as a range can tell.
 */
const MAX_START_GATE_TIMEOUT_MS = 600_000;

/**
 * One Bee node per rung, or empty for the single-node deployment described by BEE_URL and STAMP.
 *
 * Parsed eagerly and allowed to throw, for the same reason ABR_LADDER is: a publisher list that
 * does not match the ladder means rungs paying out of the wrong postage batch, and a startup
 * refusal is far easier to diagnose than a rung that goes quiet hours later.
 */
function readPublisherSpecs(): PublisherSpec[] {
  return parsePublisherSpecs(optional('BEE_PUBLISHERS', ''));
}

/** Where the admin service lives, or null for the standalone deployment this service has always been. */
interface AdminConfig {
  apiUrl: string;
  apiToken: string;
}

/**
 * Admin mode, which `ADMIN_API_URL` alone turns on.
 *
 * One variable decides it, and everything else admin mode needs is then `required` rather than
 * optional, so a half-configured admin deployment refuses to start instead of silently running as a
 * standalone one. The token is not optional-with-a-warning for the same reason `API_AUTH_TOKEN` is
 * not: it is the only thing between the admin's internal routes and anyone who can reach them.
 *
 * ⛔ The ladder used to be refused here, on the grounds that admin mode gives a broadcast one topic
 * and a ladder needs one feed per rung plus a master feed the admin knows nothing about. The two now
 * agree about what a stream *is*, and the agreement is this: **the declared topic is the ladder's
 * master feed**. Each rung publishes on a topic derived from the group and its own rung name, which
 * is stable for the life of the declaration, so a rung that restarts continues the feed it was
 * already on. The ladder's merge state — one record per rung, which the catalog feed used to hold —
 * moves into the admin, which merges each rung's report and writes `renditions` into its own catalog
 * entry. The
 * uploader writes the master from the ladder the admin hands back and reports `live` and `vod` at
 * ladder granularity. See the "Admin mode" section of the package README and `libs/AdminLadderRegistry.ts`.
 */
function readAdminConfig(): AdminConfig | null {
  const apiUrl = optional('ADMIN_API_URL', '');
  if (!apiUrl) {
    return null;
  }

  const apiToken = required('ADMIN_API_TOKEN');
  assertUsableAdminApiToken(apiToken);
  return { apiUrl, apiToken };
}

/**
 * Read before the object below, because whether STAMP is required depends on it.
 *
 * Parsing here rather than inline also means a mistyped pool is refused before any other variable
 * is looked at, which is the refusal an operator can act on.
 */
const publishers = readPublisherSpecs();

export const config = {
  beeUrl: required('BEE_URL'),
  /**
   * The batch a single-node deployment publishes through, and nothing when there is a node per rung.
   *
   * `BeePublisherPool.single` is the only reader of this in the whole service, and `buildPublishers`
   * reaches it only when BEE_PUBLISHERS named no pool. Requiring it regardless stopped a funded ABR
   * deployment at startup for a batch nothing in it would ever spend, and the only way past was to
   * invent one. An invented batch id is worse than an absent one: it is indistinguishable from a
   * real one until something tries to pay with it.
   */
  stamp: publishers.length === 0 ? required('STAMP') : optional('STAMP', ''),
  publishers,
  beeRequestTimeoutMs: optionalInt('BEE_REQUEST_TIMEOUT_MS', DEFAULT_BEE_REQUEST_TIMEOUT_MS, { min: 1 }),
  /**
   * Which of the two startup gates stops the uploader when it cannot clear a node.
   *
   * The owner ruled the two apart on 2026-09-17: the chequebook gate warns and the postage gate
   * refuses a reading the node answered while warning on one it could not get, which is
   * `chequebook-warn` and the shipped default. `warn` is both warning, `refuse` is both refusing. See
   * `libs/StartGates.ts` for why a full batch is not the same risk as a low chequebook.
   *
   * The name is written out here rather than taken from the constant `StartGates.ts` quotes it by,
   * because `deploy/test/uploaderEnv.test.js` scrapes these reads for their literal to prove every
   * knob reaches the container and is documented. A knob read through a constant is one that gate
   * cannot see, which is the shape it exists to catch.
   */
  startGates: gatePolicyFor(parseStartGateMode(optional('UPLOADER_START_GATES', START_GATE_CHEQUEBOOK_WARN))),
  startGateTimeoutMs: optionalInt('START_GATE_TIMEOUT_MS', DEFAULT_START_GATE_TIMEOUT_MS, {
    min: 1,
    max: MAX_START_GATE_TIMEOUT_MS,
  }),
  chequebookMinBzz: optionalNumber('CHEQUEBOOK_MIN_BZZ', DEFAULT_CHEQUEBOOK_MIN_BZZ, {
    min: 0,
    max: MAX_CHEQUEBOOK_MIN_BZZ,
  }),
  stampMinTtlHours: optionalNumber('STAMP_MIN_TTL_HOURS', DEFAULT_STAMP_MIN_TTL_HOURS, {
    min: 0,
    max: MAX_STAMP_MIN_TTL_HOURS,
  }),
  stampMaxUtilization: optionalNumber('STAMP_MAX_UTILIZATION', DEFAULT_STAMP_MAX_UTILIZATION, {
    min: 0,
    max: 1,
  }),
  streamKey: required('STREAM_KEY'),
  streamListTopic: required('STREAM_LIST_TOPIC'),
  apiAuthToken: required('API_AUTH_TOKEN'),
  // Zero is a real port here: it asks the OS for an ephemeral one. Every other floor is 1, because
  // zero would disable the thing the variable configures rather than tune it.
  apiPort: optionalInt('API_PORT', 3000, { min: 0, max: 65535 }),
  stateDir: optional('STATE_DIR', './state'),
  maxQueueSize: optionalInt('MAX_QUEUE_SIZE', 100, { min: 1 }),
  recoveryTimeout: optionalInt('RECOVERY_TIMEOUT', 60000, { min: 1 }),
  /**
   * How long something that is expected to be delivering may deliver nothing before this service
   * stops believing in it.
   *
   * ⛔ **Two readers, one question, and the second one LENGTHENS a broadcast rather than reporting on
   * it.** `/health` answers `segment_stall` past this, and `reasonToRefuseTakeover` reads it as the
   * window after which a quiet id may be taken. Since the reconnect window it is also the grace an
   * encoder that has just announced its return gets for its first segment to arrive, so the maximum a
   * dead broadcast is held is `ORPHAN_REAP_MS + SEGMENT_STALL_MS` rather than `ORPHAN_REAP_MS` alone.
   * See {@link StreamOrchestrator.holdTheReaperForAFirstSegment}, which also says why it is this
   * value and not one of its own.
   */
  segmentStallMs: optionalInt('SEGMENT_STALL_MS', 30000, { min: 1 }),
  fragmentSeconds: optionalNumber('HLS_FRAGMENT', DEFAULT_HLS_FRAGMENT_SECONDS, {
    min: MIN_HLS_FRAGMENT_SECONDS,
    max: MAX_HLS_FRAGMENT_SECONDS,
  }),
  /**
   * How long a live stream may receive nothing before it is finalized as a VOD. See #86.
   *
   * ⛔ **It is the reconnect window as well, and on the SRS path it is what ends a broadcast nothing
   * else ends.** An `on_unpublish` reports a disconnect and finalizes nothing, so this governs both
   * an engine that died without saying anything and an encoder that stopped, dropped or froze: an
   * encoder back inside it resumes the same session, and one that is not gets its recording here.
   * `POST /stream/stop` and the post-crash recovery timeout still end a broadcast on their own and
   * are not governed by this. See `StreamOrchestrator.noteDisconnect`.
   *
   * ⚠️ **The maximum a dead broadcast is held is this PLUS `SEGMENT_STALL_MS`**, because an encoder
   * that announces its return near the end of the window is given one of those for its first segment
   * to arrive. That grace is measured from this deadline rather than from the announce, so however
   * many times it announces the end moves by at most one grace.
   *
   * **Deliberately its own value rather than either neighbour above, and lowering it is dangerous.**
   * `SEGMENT_STALL_MS` is a health *reporting* threshold at half this, and ending a broadcast on it
   * would kill streams that recover: a twenty second write outage has been measured freezing a
   * viewer and then resuming correctly. `RECOVERY_TIMEOUT` is the right size but the wrong knob,
   * because it is tuned for how fast a *restarted process* gives up on streams it restored, and an
   * operator shortening it for crisper restarts would silently start reaping live broadcasts over
   * ordinary engine hiccups.
   *
   * The floor to keep it above is the longest silence a healthy broadcast can produce, which is the
   * engine's own retry window. Both shipped engines use 60s.
   */
  orphanReapMs: optionalInt('ORPHAN_REAP_MS', 60000, { min: 1 }),
  // Deliberately far above anything reachable: what an engine can re-deliver is bounded by its
  // playlist window, which is single digits of segments. The number exists to bound memory, not to
  // tune behaviour, so it is set where changing it can never change what is accepted. See CON-8.
  segmentDedupWindow: optionalInt('SEGMENT_DEDUP_WINDOW', 10000, { min: 1 }),
  /**
   * Erasure-coding parity on segment uploads. `0` turns parity off, which cuts upload bytes and,
   * the part that shows on a live stream, the number of chunks a viewer retrieves before a segment
   * can play.
   *
   * The default is deliberately `1`, which is what this has always uploaded. Turning parity off is
   * the new behaviour ABR offers and it trades durability for latency, so it stays opt-in until it
   * has been measured against the content-decay results. `min: 0` because 0 is a real setting here,
   * unlike every bound above it.
   */
  segmentRedundancy: optionalInt('SEGMENT_REDUNDANCY', 1, { min: 0 }),
  engine: optional('ENGINE', ''),
  abr: readAbrConfig(),
  /**
   * The admin service, or null for the standalone deployment. Everything admin mode changes hangs
   * off this one value being non-null. See {@link readAdminConfig}.
   */
  admin: readAdminConfig(),
};
