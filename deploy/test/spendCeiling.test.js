import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = join(ROOT, 'deploy/scripts/spend-ceiling.sh');

/**
 * That a sitting cannot spend past what the owner authorised for this night.
 *
 * ⛔⛔⛔ THE GATE BESIDE THIS ONE ANSWERS A DIFFERENT QUESTION AND READS LIKE THIS ONE.
 * `can_afford()` asks whether the node holds enough to pay, which is true right up until the
 * chequebook is empty. An owner who authorises 2.4 BZZ of a 3.5 BZZ balance is authorising less than
 * the node can pay, and nothing in the driver knew the difference. Two sittings that each pass
 * `can_afford` can still land past the authorisation together, because neither can see the other.
 *
 * ⛔⛔ A THRESHOLD WRITTEN DOWN IS NOT A CONTROL. On 2026-08-12 a postage stop line existed in two
 * files, in bold, with an automatic checker already reading it, and three paid sittings ran past it
 * anyway, because the checker warned at the END of a run. The gate has to sit in the path, before the
 * publisher starts, and exit non-zero.
 *
 * ⛔ Everything here is a stub. It proves the arithmetic and the refusals, and says nothing about
 * whether a real sitting reads a real chequebook.
 */

const cleanups = [];

after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

const BZZ = 10_000_000_000_000_000n;

/**
 * Drive the gate the way a driver does: source it, then ask it about a number of minutes.
 *
 * The balance reader is injected rather than stubbed over `curl`, because what is under test is the
 * ledger arithmetic and the refusals, and routing that through a fake HTTP server would test the
 * stub.
 */
async function askGate({ ledger, balances, minutes = 60, ceilingEnv = undefined }) {
  const dir = mkdtempSync(join(tmpdir(), 'spend-ceiling-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const log = join(dir, 'run.log');
  const ledgerPath = join(dir, 'ledger.env');
  if (ledger !== null) {
    writeFileSync(ledgerPath, ledger);
  }

  // `balances` maps a port to what the node reports, or to the empty string for a node that did not
  // answer at all, which is the case the gate must not read as zero spend.
  const readerCases = Object.entries(balances)
    .map(([port, value]) => `    ${port}) printf '%s' '${value}' ;;`)
    .join('\n');

  const script = `
set -u
say() { printf '%s\\n' "$*" >> "${log}"; }
LOG="${log}"
UPLOADER_BEE_PORT=10075
GATEWAY_BEE_PORT=10077
UPLOADER_BURN_PLUR_PER_MIN=130000000000000
GATEWAY_BURN_PLUR_PER_MIN=107000000000000
SPEND_LEDGER="${ledgerPath}"
${ceilingEnv === undefined ? '' : `SPEND_CEILING_PLUR=${ceilingEnv}`}
available_plur() {
  case "$1" in
${readerCases}
    *) printf '' ;;
  esac
}
. "${GATE}"
within_ceiling ${minutes}
echo "VERDICT=$?"
`;

  const { stdout } = await run('bash', ['-c', script], { cwd: ROOT }).catch((error) => ({
    stdout: `${error.stdout ?? ''}VERDICT=${error.code}\n`,
  }));

  let logText = '';
  try {
    logText = (await run('cat', [log])).stdout;
  } catch {
    logText = '';
  }
  const verdict = /VERDICT=(\d+)/.exec(stdout);
  return { allowed: verdict !== null && verdict[1] === '0', log: logText, stdout };
}

/** A ledger written when the owner gave the authorisation, with both nodes at their start balance. */
function ledgerAt({ ceiling, uploaderStart, gatewayStart }) {
  return [
    '# written when the owner authorised this night, not edited by hand',
    'authorised_at=2026-08-14T00:00:00Z',
    `ceiling_plur=${ceiling}`,
    `uploader_start_plur=${uploaderStart}`,
    `gateway_start_plur=${gatewayStart}`,
    '',
  ].join('\n');
}

describe('the spend ceiling', () => {
  it('allows a sitting whose projection fits under what is left of the authorisation', async () => {
    // Nothing spent yet, 2.4 BZZ authorised, 60 minutes projects 1.422 BZZ.
    const { allowed } = await askGate({
      ledger: ledgerAt({
        ceiling: (24n * BZZ) / 10n,
        uploaderStart: 35n * BZZ,
        gatewayStart: 20n * BZZ,
      }),
      balances: { 10075: 35n * BZZ, 10077: 20n * BZZ },
      minutes: 60,
    });

    assert.equal(allowed, true);
  });

  it('refuses a sitting whose projection would cross the ceiling, before anything publishes', async () => {
    // 120 minutes projects 2.844 BZZ against a 2.4 BZZ authorisation.
    const { allowed, log } = await askGate({
      ledger: ledgerAt({
        ceiling: (24n * BZZ) / 10n,
        uploaderStart: 35n * BZZ,
        gatewayStart: 20n * BZZ,
      }),
      balances: { 10075: 35n * BZZ, 10077: 20n * BZZ },
      minutes: 120,
    });

    assert.equal(allowed, false);
    assert.match(log, /REFUSING/);
  });

  it('counts what earlier sittings already spent, which is the whole reason it exists', async () => {
    // 2.0 BZZ of the 2.4 is gone. 60 minutes projects 1.422, so 3.42 total and it must refuse,
    // even though each node on its own could still pay for it.
    const { allowed, log } = await askGate({
      ledger: ledgerAt({
        ceiling: (24n * BZZ) / 10n,
        uploaderStart: 35n * BZZ,
        gatewayStart: 20n * BZZ,
      }),
      balances: { 10075: 33n * BZZ, 10077: 20n * BZZ },
      minutes: 60,
    });

    assert.equal(allowed, false);
    assert.match(log, /REFUSING/);
    assert.match(log, /2\.000 BZZ already spent/);
  });

  it('adds up spend across both nodes rather than watching only the publisher', async () => {
    // 1.2 from the uploader and 1.0 from the gateway is 2.2 of 2.4, so even a 10 minute sitting
    // (0.237) crosses it. Watching the uploader alone would have allowed this.
    const { allowed, log } = await askGate({
      ledger: ledgerAt({
        ceiling: (24n * BZZ) / 10n,
        uploaderStart: 35n * BZZ,
        gatewayStart: 20n * BZZ,
      }),
      balances: { 10075: (338n * BZZ) / 10n, 10077: 19n * BZZ },
      minutes: 10,
    });

    assert.equal(allowed, false);
    assert.match(log, /2\.200 BZZ already spent/);
  });

  it('refuses when a chequebook did not answer, because unknown spend is not zero spend', async () => {
    const { allowed, log } = await askGate({
      ledger: ledgerAt({
        ceiling: (24n * BZZ) / 10n,
        uploaderStart: 35n * BZZ,
        gatewayStart: 20n * BZZ,
      }),
      balances: { 10075: '', 10077: 20n * BZZ },
      minutes: 10,
    });

    assert.equal(allowed, false);
    assert.match(log, /did not answer/);
  });

  it('refuses when there is no ledger at all, so a sitting cannot run unauthorised', async () => {
    const { allowed, log } = await askGate({
      ledger: null,
      balances: { 10075: 35n * BZZ, 10077: 20n * BZZ },
      minutes: 10,
    });

    assert.equal(allowed, false);
    assert.match(log, /no spend ledger/);
  });

  it('refuses a ledger with no ceiling in it rather than treating a missing one as unlimited', async () => {
    const { allowed, log } = await askGate({
      ledger: 'authorised_at=2026-08-14T00:00:00Z\nuploader_start_plur=1\ngateway_start_plur=1\n',
      balances: { 10075: 35n * BZZ, 10077: 20n * BZZ },
      minutes: 10,
    });

    assert.equal(allowed, false);
    assert.match(log, /ceiling/);
  });

  it('treats a node whose balance rose as having spent nothing, never as headroom for the other', async () => {
    // The gateway is 1.0 BZZ up on its start, the uploader 2.3 BZZ down. Summing the signed deltas
    // would report 1.3 spent and allow a sitting the uploader alone has already overrun.
    const { allowed, log } = await askGate({
      ledger: ledgerAt({
        ceiling: (24n * BZZ) / 10n,
        uploaderStart: 35n * BZZ,
        gatewayStart: 20n * BZZ,
      }),
      balances: { 10075: (327n * BZZ) / 10n, 10077: 21n * BZZ },
      minutes: 10,
    });

    assert.equal(allowed, false);
    assert.match(log, /2\.300 BZZ already spent/);
  });

  it('refuses a balance above its start, because only a deposit raises one and the ledger predates it', async () => {
    // ⛔⛔⛔ THE CLAMP ABOVE KEEPS THE ARITHMETIC SOUND AND STILL LOSES THE HISTORY. On 2026-08-14 the
    // owner deposited 12 BZZ into the gateway. Its 0.5406 BZZ of real spend went from a counted term
    // to a clamped zero, and the ledger went on reporting a total that was short by exactly that
    // much, with nothing anywhere saying so. A second deposit into the uploader would have taken the
    // reported total to 0.000 against a ceiling 1.98 of which was already gone.
    //
    // `availableBalance` has no other way up: writing a cheque lowers it, a peer cashing one leaves
    // it alone. So a rise is a deposit, a deposit means these baselines were written before it, and a
    // spend measured from stale baselines is not a smaller number, it is an unknown one.
    const { allowed, log } = await askGate({
      ledger: ledgerAt({
        ceiling: (24n * BZZ) / 10n,
        uploaderStart: 35n * BZZ,
        gatewayStart: 20n * BZZ,
      }),
      balances: { 10075: 35n * BZZ, 10077: 21n * BZZ },
      minutes: 10,
    });

    assert.equal(allowed, false, 'a 0.237 BZZ projection fits the ceiling, so only staleness can refuse this');
    assert.match(log, /REFUSING/);
    assert.match(log, /gateway/);
    assert.match(log, /deposit/);
  });

  it('reports what it allowed, so a run log says which authorisation it ran under', async () => {
    const { log } = await askGate({
      ledger: ledgerAt({
        ceiling: (24n * BZZ) / 10n,
        uploaderStart: 35n * BZZ,
        gatewayStart: 20n * BZZ,
      }),
      balances: { 10075: 35n * BZZ, 10077: 20n * BZZ },
      minutes: 60,
    });

    assert.match(log, /2\.400 BZZ authorised/);
    assert.match(log, /1\.422 BZZ projected/);
  });
});
