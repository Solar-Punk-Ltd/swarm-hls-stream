import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes, sourceLib } from './helpers/sandbox.js';

after(removeSandboxes);

/**
 * Values chosen for what they do to a quoting scheme rather than for looking plausible in a `.env`.
 * The trailing backslash is the dangerous one: it can consume the wrapper's own closing quote and
 * leave whatever follows it outside every quote.
 */
const AWKWARD_VALUES = [
  "it's",
  "'",
  "''",
  '\\',
  "a'\\",
  "'$(echo SUBSTITUTED)'",
  'a b',
  '$HOME',
  '`echo SUBSTITUTED`',
  '"',
  ';',
  '!',
  '*',
  '--',
];

/**
 * The bash this suite actually ran under, which decides whether these tests could have failed at all.
 *
 * `shell_quote`'s defect was a difference between bash 3.2 and 5.x: the old expression relied on a
 * second round of backslash removal inside the replacement, which 5.x performs and 3.2 does not. On
 * bash 5 the old code was correct, so none of this would have gone red there. CI runs on Ubuntu, and
 * the operators who run `deploy.sh` are on macOS, where `#!/bin/bash` is 3.2. Reported in every
 * failure message so that a green run on 5.x is not mistaken for coverage of the case that broke.
 */
const BASH_VERSION = execFileSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }).trim();

/**
 * The value reaches the shell through a file rather than through this file's own quoting, so that
 * what is under test is `shell_quote` and not the test's ability to escape its own fixture.
 */
function roundTripSnippet(valuePath) {
  return [
    `value=$(cat ${JSON.stringify(valuePath)})`,
    'quoted=$(shell_quote "$value")',
    'printf \'BACK[%s]\' "$(eval "printf %s $quoted")"',
  ].join('\n');
}

describe('shell_quote round trip (SEC-21)', () => {
  for (const value of AWKWARD_VALUES) {
    it(`survives a trip through another shell: ${JSON.stringify(value)}`, async () => {
      const sandbox = makeSandbox();
      const valuePath = join(sandbox.root, 'value.txt');
      writeFileSync(valuePath, value);

      // `eval` is the point. The contract is that a receiving shell parses the word back to these
      // exact bytes, and only a shell can answer that.
      const run = await sourceLib(sandbox, roundTripSnippet(valuePath));

      assert.equal(run.exitCode, 0, `the quoted word did not parse under bash ${BASH_VERSION}: ${run.stderr}`);
      assert.equal(run.stdout, `BACK[${value}]`, `bash ${BASH_VERSION} parsed the word back to something else`);
    });
  }

  // Parsing back to the wrong bytes is the mild failure. This is the other one: a trailing backslash
  // consumes the wrapper's own closing quote, which rebalances the word and leaves the substitution
  // before it outside every quote, so the receiving shell runs it.
  //
  // The fixture was found by brute force against bash 3.2, not guessed. A guessed one fired against
  // neither wrong spelling and so asserted nothing, which is the failure this arm exists to avoid.
  //
  // It fires against the expression this branch shipped. It does not fire against the shorter
  // spelling that looks like the fix, and no input was found that does: that one is silently wrong
  // rather than dangerous, and the round trip above is what catches it, on 5 of its 14 values.
  it('does not let a value run a command in the receiving shell', async () => {
    const sandbox = makeSandbox();
    const valuePath = join(sandbox.root, 'value.txt');
    const marker = join(sandbox.root, 'EXECUTED');
    writeFileSync(valuePath, `'$(touch ${marker})\\`);

    await sourceLib(sandbox, roundTripSnippet(valuePath));

    assert.equal(existsSync(marker), false, `the quoted value ran a command under bash ${BASH_VERSION}`);
  });
});
