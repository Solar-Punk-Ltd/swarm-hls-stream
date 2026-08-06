import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MIRRORED_PLAYER_CONSTANTS, PLAYER_CONFIG_PATH } from '../src/bench/clientTuning.js';
import { ROOT_DIR } from '../src/config.js';

/**
 * The player settings the bench cannot measure are configured rather than observed, and the bench
 * mirrors them instead of importing across a package boundary. So this is the guard that keeps the
 * mirrors true: without it, lowering `liveSyncDuration` in the client — which is exactly what LAT-1
 * exists to make possible — would leave every later bench report quoting the old buffer, and the
 * improvement would be understated by the size of the change that produced it.
 *
 * Read out of the client's source rather than compared against a second copy of the number, for the
 * reason `logLevel.ts` records about `DEFAULT_LOG_LEVEL`: asserting a constant against the same
 * constant the implementation returns cannot fail.
 */
describe('the mirrored player settings still match the client', () => {
  const source = readFileSync(join(ROOT_DIR, PLAYER_CONFIG_PATH), 'utf8');

  it('mirrors a plausible number of settings, so an empty table cannot pass silently', () => {
    assert.ok(MIRRORED_PLAYER_CONSTANTS.length >= 2, 'the table has shrunk to the point of guarding nothing');
  });

  for (const { clientExport, value, ifStale } of MIRRORED_PLAYER_CONSTANTS) {
    it(`finds ${clientExport}, at the path it names`, () => {
      assert.match(
        source,
        new RegExp(`export const ${clientExport}\\s*=`),
        `${PLAYER_CONFIG_PATH} no longer exports ${clientExport}`,
      );
    });

    it(`holds the ${clientExport} the client holds`, () => {
      const declared = new RegExp(`export const ${clientExport}\\s*=\\s*([0-9.]+)\\s*;`).exec(source);

      assert.ok(declared, `could not read a numeric ${clientExport} out of ${PLAYER_CONFIG_PATH}`);
      assert.equal(
        Number(declared[1]),
        value,
        `the client holds ${clientExport} = ${declared[1]} and the bench mirrors ${value}. ` +
          `Update clientTuning.ts, or ${ifStale}.`,
      );
    });
  }
});
