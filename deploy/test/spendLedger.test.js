import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'scripts', 'spend-ledger.sh');

function run(args) {
  try {
    return { code: 0, out: execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/**
 * The script that writes the owner's spend authorisation: a ceiling they set, and one chequebook
 * baseline per node that can spend, read off the nodes themselves.
 *
 * Only what can be checked without a deployment. Everything past the amount check dials the uploader
 * for its routing and then every node for a balance, which belongs to the host.
 */
describe('the spend ledger writer', () => {
  /**
   * ⛔⛔⛔ The rule this script exists inside: the ceiling is the owner's number. A default would be
   * an authorisation nobody gave, so there is none, and the refusal says why rather than just how.
   */
  it('refuses to write anything without an explicit authorisation', () => {
    const { code, out } = run(['--profile=latbench', '--portSlot=7']);

    assert.equal(code, 2);
    assert.match(out, /no --authorise/);
    assert.match(out, /owner's to set/);
  });

  /**
   * ⛔⛔ The regression that made bee-publishers.sh's ordinary invocation the only broken one. macOS
   * ships bash 3.2, where an EMPTY array expanded as `"${arr[@]}"` under `set -u` is an unbound
   * variable rather than an empty list, and `parse_profile_args` leaves that array empty whenever the
   * profile flags are the only arguments.
   */
  it('gets past argument parsing when the profile flags are the only arguments', () => {
    const { out } = run(['--profile=latbench', '--portSlot=7']);

    assert.doesNotMatch(out, /unbound variable/, 'the script died on its own argument handling');
  });

  /** Answered before anything is dialed, so a mistyped number does not cost five HTTP round trips. */
  it('refuses an amount that is not a positive number of BZZ, without reaching a node', () => {
    for (const bad of ['lots', '0', '-1', '1.2.3', '2 BZZ', '']) {
      const { code, out } = run([`--authorise=${bad}`]);

      assert.equal(code, 2, `accepted --authorise=${bad}`);
      assert.match(out, /REFUSING/);
      assert.doesNotMatch(out, /did not answer/, `--authorise=${bad} reached a node before being refused`);
    }
  });

  it('prints its usage without needing a deployment', () => {
    const { code, out } = run(['--help']);

    assert.equal(code, 0);
    assert.match(out, /--authorise/);
  });

  /**
   * The amount is parsed by an inline `python3 -c '...'` inside a single-quoted shell string, so one
   * apostrophe in a comment closes the string and the file stops parsing. That has happened here
   * before, to a backtick in a docstring in bee-publishers.sh.
   */
  it('parses as bash, embedded python and all', () => {
    execFileSync('bash', ['-n', SCRIPT], { stdio: 'pipe' });
  });

  /**
   * ⛔⛔⛔ The owner rule this cannot be allowed to drift across: the agent never moves money. This
   * script reads balances and writes a file. A buy, a top-up or a dilute is a `POST` or a `PATCH`, so
   * the absence of either against a node is what makes "it cannot spend" checkable rather than stated.
   */
  it('has no request in it that could move money', () => {
    const script = execFileSync('cat', [SCRIPT], { encoding: 'utf8' });
    const requests = script.match(/curl[^\n]*/g) ?? [];

    assert.notEqual(requests.length, 0, 'it should still be reading balances over HTTP');
    for (const request of requests) {
      assert.doesNotMatch(request, /-X\s*(POST|PATCH|PUT|DELETE)|--request/, `this curl can write: ${request}`);
    }
    assert.doesNotMatch(script, /\/stamps\/[^ )"']*\/[0-9]/, 'a buy or dilute path appears in the script');
  });
});
