import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = join(ROOT, 'deploy/scripts');
const SHARED = join(SCRIPTS, 'burn-rates.sh');

/** Highest per-hour figure any bracketed sitting has produced, so a rate below it under-charges. */
const MEASURED_PEAK_BZZ_PER_HOUR = { uploader: 0.78, gateway: 0.64 };

function sourced(name) {
  const out = execFileSync(
    'bash',
    ['-c', `set -u; . "${SHARED}"; printf '%s %s' "$UPLOADER_BURN_PLUR_PER_MIN" "$GATEWAY_BURN_PLUR_PER_MIN"`],
    { encoding: 'utf8' },
  );
  const [uploader, gateway] = out.trim().split(/\s+/).map(Number);
  return { uploader, gateway }[name];
}

describe('the burn rate every sitting is priced against', () => {
  /**
   * ⛔⛔⛔ On 2026-08-13 three scripts carried FOUR different values between them: viewer-arms at
   * 0.0130/0.0107 BZZ per minute, sweep-interleaved at 0.0437/0.0355, and phase06 at 0.0179/0.0102,
   * with a fourth quoted in a phase06 comment as sweep-interleaved's. Only the first was measured.
   *
   * That is how a wrong constant survives: it is corrected where someone is looking and left
   * everywhere else. sweep-interleaved's 0.0437 was refit #3, the one that cut a planned 7.9-hour
   * night to 2 hours, and it sat there for a day after being identified as wrong.
   *
   * ⭐ So the rate lives in exactly one file and this test refuses a fifth. A script that prices a
   * sitting sources `burn-rates.sh`; it does not get to hold an opinion.
   */
  it('is defined in exactly one file, and no script carries its own', () => {
    const offenders = [];
    for (const name of readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh') && f !== 'burn-rates.sh')) {
      const body = readFileSync(join(SCRIPTS, name), 'utf8');
      for (const line of body.split('\n')) {
        if (/^\s*(UPLOADER|GATEWAY)_BURN_PLUR_PER_MIN=/.test(line)) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `these define their own burn rate instead of sourcing burn-rates.sh:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('is sourced by every script that prices a sitting', () => {
    for (const name of ['sweep-interleaved.sh', 'viewer-arms.sh', 'phase06-light-vs-ultralight.sh']) {
      const body = readFileSync(join(SCRIPTS, name), 'utf8');
      assert.match(body, /burn-rates\.sh/, `${name} prices a sitting without sourcing the measured rate`);
    }
  });

  /**
   * ⛔ A rate BELOW what was measured is the dangerous direction: it approves a sitting the balance
   * cannot finish, which is what refit #2 (0.0214) would have done to a four-hour soak. The margin
   * exists to absorb variation on top, not to rescue a constant that is already too low.
   */
  for (const [who, peakBzzPerHour] of Object.entries(MEASURED_PEAK_BZZ_PER_HOUR)) {
    it(`charges the ${who} at least the ${peakBzzPerHour} BZZ/hr a real sitting has reached`, () => {
      const plurPerHour = sourced(who) * 60;
      assert.ok(
        plurPerHour >= peakBzzPerHour * 1e16,
        `${who} priced at ${(plurPerHour / 1e16).toFixed(3)} BZZ/hr, under the measured ${peakBzzPerHour}`,
      );
    });
  }

  /**
   * ⛔ These scripts run `set -u` without `set -e`, so a failed `.` does not stop them. Without a
   * guard the run continues past the missing file and dies on "unbound variable" inside a funding
   * function, which names neither the file nor the fix.
   *
   * It is reachable: the scripts are copied to the host, and `sweep-interleaved.sh` used to document
   * copying itself alone. A sitting that dies on an unbound variable after being told to publish is
   * the exact class of fault the gates exist to prevent.
   */
  it('names the missing rate file rather than dying on an unbound variable later', () => {
    for (const name of ['sweep-interleaved.sh', 'viewer-arms.sh', 'phase06-light-vs-ultralight.sh']) {
      const lines = readFileSync(join(SCRIPTS, name), 'utf8').split('\n');
      const at = lines.findIndex((l) => /^RATES=.*burn-rates\.sh"$/.test(l.trim()));
      assert.ok(at >= 0, `${name} does not resolve a path to burn-rates.sh`);

      const guard = lines.slice(at, at + 8).join('\n');
      assert.match(guard, /^\. "\$\{RATES\}" \|\|/m, `${name} sources the rate without handling it being absent`);
      assert.match(guard, /exit 1/, `${name} continues after failing to read the rate it prices with`);
    }
  });

  it('tells the operator to sync the whole directory, not to copy one script', () => {
    const body = readFileSync(join(SCRIPTS, 'sweep-interleaved.sh'), 'utf8');
    assert.doesNotMatch(
      body,
      /scp \S*sweep-interleaved\.sh/,
      'the usage still says to copy this script alone, which leaves burn-rates.sh behind',
    );
  });

  /**
   * ⚠️ And not wildly above it either. Over-conservatism has its own cost: on 2026-08-05 a constant
   * 1.5x high made the guard refuse 60 affordable minutes and led to asking the owner for an
   * on-chain deposit that was not needed. The margin is where safety belongs.
   */
  it('does not price a sitting at more than twice what one has ever cost', () => {
    for (const [who, peakBzzPerHour] of Object.entries(MEASURED_PEAK_BZZ_PER_HOUR)) {
      const bzzPerHour = (sourced(who) * 60) / 1e16;
      assert.ok(
        bzzPerHour <= peakBzzPerHour * 2,
        `${who} priced at ${bzzPerHour.toFixed(3)} BZZ/hr against a measured peak of ${peakBzzPerHour}`,
      );
    }
  });
});
