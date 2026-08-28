import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import { makeHost } from '../../src/harness/host.js';
import {
  availablePlur,
  ceilingRefusal,
  ledgerRefusal,
  parseSpendLedger,
  readSpendLedger,
  SPEND_LEDGER_PATH,
  spendAgainstCeiling,
  spendSummary,
} from '../../src/harness/spendCeiling.js';

/**
 * Preflight, in one sentence: a run against the deployed stack spends real money, and this refuses
 * one that has already spent what the owner said it could.
 *
 * The owner authorises an amount by writing `.spend-ledger.env` at the repository root. Until this
 * existed nothing read it at launch time, so every launch was gated by an operator remembering the
 * number, which is a threshold written down rather than a control. `deploy/scripts/spend-ceiling.sh`
 * refuses a bench sitting on the same four keys, and the two read one file so two paths cannot each
 * spend the whole allowance.
 *
 * Read-only, and only reads: two chequebook balances and one local file. It costs nothing, so it can
 * refuse while the stack is still cold.
 *
 * ⚠️ What this does NOT do, and a maintainer has to know it. `node --test` runs every file it was
 * given even after one fails, so a refusal here does not by itself abort the scenarios that follow.
 * What it buys is a run that stops with the number in front of the operator at the top of the output
 * instead of after the money is gone. Making the refusal abort the rest needs a change to how a run
 * is driven, which is not this file's to make.
 *
 * The rules live in `src/harness/spendCeiling.ts` because nothing under `suites/` runs in CI. They
 * are covered by `test/spendCeiling.test.ts` and therefore by `pnpm verify`, leaving this file as
 * wiring and a failure message.
 */
/**
 * Read at module scope, not inside the `describe`, for the reason `abr-coverage.test.ts` records: a
 * throw inside a `describe` callback prints `not ok` and is still reported as `# fail 0` with exit 0,
 * so a config this suite cannot load would be waved through by the very gate that reads it.
 */
const cfg = loadConfig();

describe('preflight — the run stays inside what the owner authorised', () => {
  const host = makeHost(cfg);

  it('has spent less than the ceiling', async () => {
    const ledgerText = readSpendLedger();
    const ledger = parseSpendLedger(ledgerText);

    if (ledger === null) {
      assert.fail(ledgerRefusal(SPEND_LEDGER_PATH, ledgerText));
    }

    // Read one node at a time so a chequebook that does not answer is attributable to its node, and
    // so a refusal on the first leaves no second request in flight to reject unhandled.
    const uploaderPlur = availablePlur(
      await host.localJson<unknown>(cfg.ports.beeUploaderApi, '/chequebook/balance'),
      'uploader',
    );
    const gatewayPlur = availablePlur(
      await host.localJson<unknown>(cfg.ports.beeGatewayApi, '/chequebook/balance'),
      'gateway',
    );

    const verdict = spendAgainstCeiling(ledger, { uploaderPlur, gatewayPlur });
    console.log(`  authorised ${ledger.authorisedAt}: ${spendSummary(verdict)}`);

    if (verdict.withinCeiling) {
      return;
    }

    assert.fail(ceilingRefusal(verdict, SPEND_LEDGER_PATH));
  });
});
