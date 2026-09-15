import { parsePublisherSpecs, PublisherSpec } from '../libs/BeePublisherPool.js';

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
 * disable the check: a chequebook that cannot be read at all is still a refusal, because a node
 * running with SWAP off has none to fill.
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
 */
const DEFAULT_BEE_REQUEST_TIMEOUT_MS = 4000;

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
  segmentStallMs: optionalInt('SEGMENT_STALL_MS', 30000, { min: 1 }),
  fragmentSeconds: optionalNumber('HLS_FRAGMENT', DEFAULT_HLS_FRAGMENT_SECONDS, {
    min: MIN_HLS_FRAGMENT_SECONDS,
    max: MAX_HLS_FRAGMENT_SECONDS,
  }),
  /**
   * How long a live stream may receive nothing before it is finalized as a VOD, on the assumption
   * that its engine died without sending `on_unpublish`. See #86.
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
};
