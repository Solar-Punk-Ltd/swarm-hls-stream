import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { bodyOf, codeOf, exemptScripts, SCRIPTS, scriptsThatSpend } from './helpers/spendingScripts.js';

const run = promisify(execFile);
const SHARED = join(SCRIPTS, 'spend-ceiling.sh');

/**
 * That everything which can spend asks whether the owner authorised the spending, and that the check
 * exists once.
 *
 * ⛔⛔⛔ TWO SCRIPTS PUBLISHED WITHOUT IT AND NO TEST COULD SEE EITHER, UNTIL 2026-09-16.
 *
 * `capacityGate.test.js` is the model for this file and it has one blind spot that both escapes went
 * through: it discovers drivers by asking which scripts source `burn-rates.sh`. `publish-clock.sh`
 * sourced nothing at all, so a documented command line that publishes an hour of 720p into Swarm was
 * invisible to it by construction. And there was no such test for the money gate at all, so
 * `sweep-interleaved.sh`, which does source the rates, published against the owner's authorisation
 * without consulting it.
 *
 * ⭐ The rule these enforce is that **a script which can start a broadcast asks all three questions**:
 * can the nodes pay, can the batch carry it, and did the owner authorise it. `can_afford` is not a
 * substitute for the third. It stays true right down to an empty chequebook, so a driver carrying
 * only that authorises the entire balance, and it cannot see what an earlier sitting the same night
 * already spent.
 */

describe('the spend ceiling is wired into everything that can spend', () => {
  it('finds the publishers, including the one that sources no rates at all', () => {
    const spending = scriptsThatSpend();

    assert.ok(spending.length >= 8, `the discovery found fewer spenders than this repo has: ${spending}`);
    assert.ok(
      spending.includes('publish-clock.sh'),
      'the script that starts every broadcast is not discovered, which is the blind spot this file exists for',
    );
    assert.ok(
      spending.includes('sweep-interleaved.sh'),
      'the screening sweep is not discovered, and it is the driver documented for a whole-grid run',
    );
  });

  /**
   * ⛔ The exemption is read here rather than assumed, so a name that stops matching a real file, or a
   * script that quietly grows a path to the deployment, is a failing test rather than a silent hole.
   */
  it('exempts only scripts that exist and cannot reach the paid stack', () => {
    for (const [name, reason] of Object.entries(exemptScripts())) {
      assert.ok(existsSync(join(SCRIPTS, name)), `${name} is exempt from the money gates and does not exist`);
      assert.ok(reason.length > 40, `${name} is exempt with no reason written down`);
      assert.ok(!scriptsThatSpend().includes(name), `${name} is both exempt and discovered`);
    }
  });

  it('is resolved as a path by every script that can spend', () => {
    for (const name of scriptsThatSpend()) {
      const lines = bodyOf(name).split('\n');
      assert.ok(
        lines.some((line) => /^CEILING=.*spend-ceiling\.sh"$/.test(line.trim())),
        `${name} can start a broadcast and never resolves a path to spend-ceiling.sh`,
      );
    }
  });

  /**
   * ⛔ These drivers run `set -u` without `set -e`. A gate file that could not be read and was not
   * handled would leave `within_ceiling` undefined, and the sitting would publish past it.
   */
  it('is sourced with a guard that stops the run when the file cannot be read', () => {
    for (const name of scriptsThatSpend()) {
      const lines = bodyOf(name).split('\n');
      const at = lines.findIndex((line) => /^\. "\$\{CEILING\}" \|\|/.test(line));
      assert.ok(at >= 0, `${name} does not source the ceiling it resolved a path to`);
      assert.match(
        lines.slice(at, at + 8).join('\n'),
        /exit 1/,
        `${name} carries on after failing to read the gate it publishes behind`,
      );
    }
  });

  it('is asked, and not merely sourced, by every script that can spend', () => {
    for (const name of scriptsThatSpend()) {
      assert.match(codeOf(name), /within_ceiling /, `${name} sources the spend ceiling and never asks it anything`);
    }
  });

  /**
   * ⛔ One definition, for the reason `capacity-gate.sh` carries: a driver with its own copy is a gate
   * that drifts, and the copy that drifts is the one nobody is looking at. `phase06` had exactly that
   * shape on the postage side and its private reader matched no batch at all.
   */
  it('is defined in exactly one file, and no driver carries its own', () => {
    const offenders = [];
    for (const name of scriptsThatSpend()) {
      for (const line of bodyOf(name).split('\n')) {
        if (/^\s*(within_ceiling|spent_so_far_plur|spend_nodes|ledger_field)\s*\(\)/.test(line)) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `these define their own spend ceiling instead of sourcing spend-ceiling.sh:\n  ${offenders.join('\n  ')}`,
    );
  });

  /**
   * ⛔ The authorisation is parsed in one place. A driver reading `ceiling_plur` for itself would be
   * deciding what the owner authorised, which is the one number no script gets to interpret twice.
   */
  it('is the only thing that reads the authorisation out of the ledger', () => {
    const offenders = scriptsThatSpend().filter((name) => codeOf(name).includes('ceiling_plur'));

    assert.deepEqual(offenders, [], `these parse the spend ledger themselves: ${offenders.join(', ')}`);
  });
});

/**
 * The contract the shared file has with its callers, enforced at the moment of sourcing.
 *
 * ⛔ It reads a chequebook through the caller's own `available_plur` and the publisher set through
 * `capacity-gate.sh`'s `uploader_env`, so sourcing it too early would leave a gate that quietly did
 * nothing. That is not hypothetical wiring: `sweep-interleaved.sh` spelled its chequebook reader
 * `chequebook_available_plur` and had to be renamed before it could carry this gate at all.
 */
describe('the spend ceiling refuses a caller that cannot use it', () => {
  const COMPLETE = [
    'say() { :; }',
    'available_plur() { :; }',
    'uploader_env() { :; }',
    'LOG=/dev/null',
    'UPLOADER_BEE_PORT=10075',
    'GATEWAY_BEE_PORT=10077',
    'UPLOADER_BURN_PLUR_PER_MIN=130000000000000',
    'GATEWAY_BURN_PLUR_PER_MIN=107000000000000',
  ];

  async function sourceWithout(missing) {
    const preamble = COMPLETE.filter((line) => !line.startsWith(missing)).join('\n');
    try {
      await run('bash', ['-c', `set -u\n${preamble}\n. "${SHARED}"\necho SOURCED`], { encoding: 'utf8' });
    } catch (failure) {
      return { code: failure.code, stderr: failure.stderr };
    }
    return { code: 0, stderr: '' };
  }

  it('sources cleanly when the caller has everything it needs', async () => {
    const { code, stderr } = await sourceWithout('nothing-is-missing');

    assert.equal(code, 0, stderr);
  });

  for (const [missing, named] of [
    ['say()', /say\(\)/],
    ['available_plur()', /available_plur\(\)/],
    ['uploader_env()', /capacity-gate\.sh/],
    ['LOG=', /LOG/],
    ['UPLOADER_BEE_PORT=', /UPLOADER_BEE_PORT/],
    ['GATEWAY_BEE_PORT=', /GATEWAY_BEE_PORT/],
    ['UPLOADER_BURN_PLUR_PER_MIN=', /burn-rates\.sh/],
  ]) {
    it(`refuses a caller with no ${missing}, and names what is missing`, async () => {
      const { code, stderr } = await sourceWithout(missing);

      assert.notEqual(code, 0, `a caller without ${missing} was allowed to carry the gate`);
      assert.match(stderr, named);
    });
  }
});
