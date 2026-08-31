import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'scripts', 'bee-publishers.sh');

function run(args) {
  try {
    return { code: 0, out: execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/**
 * The generator that writes BEE_PUBLISHERS by asking each rung's Bee node which batch it holds.
 *
 * Only what can be checked without a deployment. Its selection and refusal rules are exercised
 * against captured `/stamps` responses through `--stamps-from`, which needs a profile env file and so
 * belongs to the host rather than to CI.
 */
describe('the BEE_PUBLISHERS generator', () => {
  /**
   * ⛔⛔ The regression that made the script's ORDINARY invocation the only broken one. macOS ships
   * bash 3.2, where an **empty** array expanded as `"${arr[@]}"` under `set -u` is an unbound
   * variable rather than an empty list. `parse_profile_args` consumes `--profile` and `--portSlot`
   * and leaves `REST_ARGS` empty, so the script died on its own argument handling the moment nobody
   * passed a third flag. Every path exercised while writing it passed `--stamps-from`, which is
   * exactly why it survived to be committed.
   *
   * Asserted as "not this failure" plus "still refuses", because what should happen next is a refusal
   * about the missing env file. A test that only checked the exit code would pass against the bug.
   */
  it('gets past argument parsing when the profile flags are the only arguments', () => {
    const { code, out } = run(['--profile=no-such-profile-for-tests', '--portSlot=1']);

    assert.doesNotMatch(out, /unbound variable/, 'the script died on its own argument handling');
    assert.notEqual(code, 0, 'a profile with no env file has to refuse');
    assert.match(out, /no-such-profile-for-tests/, 'the refusal should name the profile it could not load');
  });

  it('prints its usage without needing a deployment', () => {
    const { code, out } = run(['--help']);

    assert.equal(code, 0);
    assert.match(out, /BEE_PUBLISHERS/);
    assert.match(out, /--write/);
  });

  /**
   * The batch selection is an inline `python3 -c '...'` program inside a single-quoted shell string, so
   * one apostrophe or backtick in a comment closes the string and the whole file stops parsing. That
   * has happened once already, to a backtick in a docstring.
   */
  it('parses as bash, embedded python and all', () => {
    execFileSync('bash', ['-n', SCRIPT], { stdio: 'pipe' });
  });

  /** The floor and the ceiling have to be the ones PostageGate applies, or config it writes is config the service refuses. */
  it('shares its refusal thresholds with the uploader’s own postage gate', () => {
    const script = execFileSync('cat', [SCRIPT], { encoding: 'utf8' });
    const gate = execFileSync('cat', [join(HERE, '..', '..', 'packages/stream-uploader/src/utils/config.ts')], {
      encoding: 'utf8',
    });

    assert.match(script, /MIN_TTL_HOURS="\$\{STAMP_MIN_TTL_HOURS:-24\}"/);
    assert.match(script, /MAX_UTILIZATION="\$\{STAMP_MAX_UTILIZATION:-0\.9\}"/);
    assert.match(gate, /DEFAULT_STAMP_MIN_TTL_HOURS = 24/);
    assert.match(gate, /DEFAULT_STAMP_MAX_UTILIZATION = 0\.9/);
  });
});
