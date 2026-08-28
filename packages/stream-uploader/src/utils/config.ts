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
