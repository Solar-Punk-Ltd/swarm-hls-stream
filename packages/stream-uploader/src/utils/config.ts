import { AbrLadder, DEFAULT_LADDER_SPEC } from '../libs/AbrLadder.js';
import { parsePublisherSpecs, PublisherSpec } from '../libs/BeePublisherPool.js';

import { optional, optionalBool, optionalInt, optionalNumber, required } from './env.js';

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
 * A day, because a batch that expires mid-broadcast stops paying for the data it was keeping, and a
 * floor shorter than the longest run anyone books here would clear a batch that cannot finish it.
 * This is a chosen bound and not a measured one: it is "comfortably longer than a sitting", and a
 * deployment that knows its run is shorter can lower it.
 */
const DEFAULT_STAMP_MIN_TTL_HOURS = 24;
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
 * segment and this is only a floor, so a broadcaster sending a longer GOP produces longer segments
 * than the wall clock derived from this steps by. See `deploy/README.md`.
 *
 * The bounds are the range SRS itself will work in: below a frame the entrypoint refuses the GOP
 * arithmetic outright, and an hour is `isUsableDuration`'s own ceiling on a segment.
 */
const DEFAULT_HLS_FRAGMENT_SECONDS = 0.5;
const MIN_HLS_FRAGMENT_SECONDS = 0.01;
const MAX_HLS_FRAGMENT_SECONDS = 3600;

/**
 * The ABR ladder, or null when the engine is producing a single rendition.
 *
 * Parsed eagerly and allowed to throw: a malformed ABR_LADDER means the uploader would group
 * rungs it cannot describe, and failing at startup is a great deal easier to diagnose than a
 * master playlist that silently omits half the ladder.
 */
function readAbrConfig(): { vhost: string; ladder: AbrLadder } | null {
  if (!optionalBool('ABR_ENABLED', false)) {
    return null;
  }

  return {
    // The vhost the engine republishes rungs onto. Anything arriving on another vhost is the
    // untranscoded source, and the uploader has no business segmenting it.
    vhost: optional('ABR_VHOST', 'abr'),
    ladder: AbrLadder.parse(optional('ABR_LADDER', DEFAULT_LADDER_SPEC)),
  };
}

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

export const config = {
  beeUrl: required('BEE_URL'),
  stamp: required('STAMP'),
  publishers: readPublisherSpecs(),
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
