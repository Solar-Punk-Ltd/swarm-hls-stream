import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { shellQuoted } from '../src/harness/shellQuote.js';

/**
 * The one way this harness puts a value inside a shell command.
 *
 * ⛔ There were two, privately, in two files that both hand their command to the same `Host.run`.
 * `uploaderState.ts` escaped an embedded quote and `harness/browser.ts` refused one, so a third
 * caller had two incompatible precedents to copy from and no way to tell which was the house rule.
 * One helper, and the weaker of the two strategies is gone.
 *
 * ⭐ Checked by round-tripping through a REAL shell rather than by comparing against the escaping this
 * file would have written. A test that asserts the output string is a test of the implementation
 * against itself, and the question here is what `bash` does with it.
 */

/** What one `bash -c` parse yields back, which is the only thing this helper has to get right. */
function throughBash(quoted: string): string {
  return execFileSync('bash', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' });
}

describe('putting a value inside a shell command', () => {
  it('gives back an ordinary value unchanged', () => {
    assert.equal(throughBash(shellQuoted('swarm-hls-browser:latest')), 'swarm-hls-browser:latest');
  });

  it('survives a value carrying a single quote, which is the only character that can end the quoting', () => {
    assert.equal(throughBash(shellQuoted("it's fine")), "it's fine");
  });

  it('survives a value that is nothing but quotes', () => {
    assert.equal(throughBash(shellQuoted("'''")), "'''");
  });

  /**
   * ⛔ The one that matters. A value closing its own quoting could run anything, on a host this suite
   * reaches over ssh and injects faults on.
   */
  it('does not let a value close its quoting and run a command of its own', () => {
    const hostile = "x'; echo PWNED; :'";

    assert.equal(throughBash(shellQuoted(hostile)), hostile);
  });

  it('survives the characters a shell would otherwise act on', () => {
    for (const value of ['a b', '$HOME', '`id`', 'a;b', 'a|b', 'a&b', 'a>b', 'a\nb', '*', '~/x', '\\', '!']) {
      assert.equal(throughBash(shellQuoted(value)), value, `bash did not give back ${JSON.stringify(value)}`);
    }
  });

  it('gives back an empty value as an empty value rather than as no argument at all', () => {
    assert.equal(throughBash(shellQuoted('')), '');
  });
});
