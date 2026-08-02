import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  LIVE_SYNC_DURATION_EXPORT,
  LIVE_SYNC_DURATION_S,
  PLAYER_CONFIG_PATH,
} from '../src/bench/clientTuning.js';
import { ROOT_DIR } from '../src/config.js';

/**
 * The player buffer is the one term in the reported viewer latency that is configured rather than
 * measured, and the bench mirrors it instead of importing it across a package boundary. So this is
 * the guard that keeps the mirror true: without it, lowering `liveSyncDuration` in the client — which
 * is exactly what LAT-1 exists to make possible — would leave every later bench report quoting the
 * old buffer, and the improvement would be understated by the size of the change that produced it.
 *
 * Read out of the client's source rather than compared against a second copy of the number, for the
 * reason `logLevel.ts` records about `DEFAULT_LOG_LEVEL`: asserting a constant against the same
 * constant the implementation returns cannot fail.
 */
describe('the mirrored player buffer still matches the client', () => {
  const source = readFileSync(join(ROOT_DIR, PLAYER_CONFIG_PATH), 'utf8');

  it('finds the export it mirrors, at the path it names', () => {
    assert.match(
      source,
      new RegExp(`export const ${LIVE_SYNC_DURATION_EXPORT}\\s*=`),
      `${PLAYER_CONFIG_PATH} no longer exports ${LIVE_SYNC_DURATION_EXPORT}`,
    );
  });

  it('holds the value the client holds', () => {
    const declared = new RegExp(`export const ${LIVE_SYNC_DURATION_EXPORT}\\s*=\\s*([0-9.]+)\\s*;`).exec(source);

    assert.ok(declared, `could not read a numeric ${LIVE_SYNC_DURATION_EXPORT} out of ${PLAYER_CONFIG_PATH}`);
    assert.equal(
      Number(declared[1]),
      LIVE_SYNC_DURATION_S,
      `the client holds playback ${declared[1]}s behind the live edge and the bench reports ` +
        `${LIVE_SYNC_DURATION_S}s. Update clientTuning.ts, or every viewer latency the bench ` +
        'reports is wrong by the difference.',
    );
  });
});
