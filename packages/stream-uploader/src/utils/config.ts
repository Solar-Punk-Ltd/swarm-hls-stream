import { AbrLadder, DEFAULT_LADDER_SPEC } from '../libs/AbrLadder.js';
import { parsePublisherSpecs, PublisherSpec } from '../libs/BeePublisherPool.js';

import { optional, optionalBool, optionalInt, required } from './env.js';

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

/**
 * Read before `config` so `stamp` below can ask whether there are any.
 */
const publishers = readPublisherSpecs();

export const config = {
  beeUrl: required('BEE_URL'),
  /**
   * The postage batch the single-node deployment pays with.
   *
   * Required only when there are no publishers. With BEE_PUBLISHERS set every rung carries its
   * own batch and this is never read — `BeePublisherPool.single()` is its only reader, and pool
   * mode does not call it. Requiring it unconditionally meant a pool-backed uploader refused to
   * start unless the root `.env` happened to hold a batch id left over from something else, and
   * `.env.sample` ships `STAMP=` empty, so on a fresh checkout it could not start at all. The
   * error named STAMP, which is the one thing such a deployment legitimately does not have.
   */
  stamp: publishers.length > 0 ? optional('STAMP', '') : required('STAMP'),
  publishers,
  streamKey: required('STREAM_KEY'),
  streamListTopic: required('STREAM_LIST_TOPIC'),
  manifestAccessUrl: optional('MANIFEST_ACCESS_URL', ''),
  apiPort: optionalInt('API_PORT', 3000),
  stateDir: optional('STATE_DIR', './state'),
  maxQueueSize: optionalInt('MAX_QUEUE_SIZE', 100),
  recoveryTimeout: optionalInt('RECOVERY_TIMEOUT', 60000),
  // Erasure-coding parity on segment uploads. Defaults to what this has always used; 0 turns it
  // off, which cuts both upload bytes and — the part that shows on a live stream — the number of
  // chunks a viewer has to retrieve before a segment can play.
  segmentRedundancy: optionalInt('SEGMENT_REDUNDANCY', 1),
  engine: optional('ENGINE', ''),
  abr: readAbrConfig(),
};
