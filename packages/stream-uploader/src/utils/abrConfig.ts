import { AbrLadder, DEFAULT_LADDER_SPEC } from '../libs/AbrLadder.js';

import { optional, optionalBool } from './env.js';

/** The vhost the ladder's rungs are republished onto, and the rungs to expect there. */
export interface AbrGuard {
  vhost: string;
  ladder: AbrLadder;
}

/**
 * The ABR ladder, or null when the engine is producing a single rendition.
 *
 * Allowed to throw: a malformed ABR_LADDER means the uploader would group rungs it cannot describe,
 * and failing at startup is a great deal easier to diagnose than a master playlist that silently
 * omits half the ladder.
 *
 * ⛔ It lives in its own file rather than in `config.ts` so that reading it costs an import of this
 * module and nothing else. `config.ts` builds its exported object at module scope out of five
 * `required()` reads, so anything that imports it to reach one field pays for all five: that is what
 * made importing the SRS engine throw on any tree whose `.env` did not satisfy a full deployment,
 * and it is what `test/engineImportIsPure.test.ts` now refuses. `config.ts` still calls this for its
 * own `abr` field, so a malformed ladder is still refused at startup exactly as before.
 */
export function readAbrConfig(): AbrGuard | null {
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
