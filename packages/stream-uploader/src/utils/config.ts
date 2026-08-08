import { AbrLadder, DEFAULT_LADDER_SPEC } from '../libs/AbrLadder.js';

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

export const config = {
  beeUrl: required('BEE_URL'),
  stamp: required('STAMP'),
  streamKey: required('STREAM_KEY'),
  streamListTopic: required('STREAM_LIST_TOPIC'),
  manifestAccessUrl: optional('MANIFEST_ACCESS_URL', ''),
  apiPort: optionalInt('API_PORT', 3000),
  stateDir: optional('STATE_DIR', './state'),
  maxQueueSize: optionalInt('MAX_QUEUE_SIZE', 100),
  recoveryTimeout: optionalInt('RECOVERY_TIMEOUT', 60000),
  engine: optional('ENGINE', ''),
  abr: readAbrConfig(),
};
