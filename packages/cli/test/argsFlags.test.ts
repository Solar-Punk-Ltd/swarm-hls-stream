import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertRungFlagSupported, parseArgs } from '../src/lib/args.js';

/**
 * `--rung` is parsed for every command but acted on by one. The parser cannot reject it, because it
 * does not know which command will read it, so the check lives here and runs before dispatch.
 *
 * The harm is a spend on the wrong node: `stamp:setup --rung 1080p` was accepted, the flag dropped,
 * and the batch bought on the single-node uploader the operator did not name. See finding 20.
 */
describe('assertRungFlagSupported', () => {
  for (const command of ['stamp-setup', 'stamp-check', 'node-status', 'node-addresses', 'node-wallets']) {
    it(`rejects --rung on ${command}, which does not act on a rung`, () => {
      assert.throws(
        () => assertRungFlagSupported(parseArgs(['node', 'cli', command, '--rung', '1080p'])),
        new RegExp(`${command} does not take --rung`),
      );
    });
  }

  it('names stamp-buy as the command that does take it', () => {
    assert.throws(() => assertRungFlagSupported(parseArgs(['node', 'cli', 'stamp-setup', '--rung', '1080p'])), /run stamp-buy/);
  });

  it('allows --rung on stamp-buy, the one command that spends per rung', () => {
    assert.doesNotThrow(() => assertRungFlagSupported(parseArgs(['node', 'cli', 'stamp-buy', '--rung', '360p', '500', '21'])));
  });

  for (const command of ['stamp-setup', 'stamp-check', 'node-status', 'stamp-buy']) {
    it(`leaves ${command} alone when no --rung is passed`, () => {
      assert.doesNotThrow(() => assertRungFlagSupported(parseArgs(['node', 'cli', command, '500', '21'])));
    });
  }
});
