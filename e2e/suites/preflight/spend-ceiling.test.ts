import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import { makeHost } from '../../src/harness/host.js';
import {
  availablePlur,
  ledgerRefusal,
  parseSpendLedger,
  readSpendLedger,
  SPEND_LEDGER_PATH,
  spendAgainstCeiling,
  spendRefusal,
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
 * ⛔⛔ THE REFUSAL ONLY STOPS THE SPEND BECAUSE OF THE `&&` IN `test:e2e`. KEEP THEM TOGETHER.
 *
 * `node --test` runs every file it was given even after one fails, and exits non-zero only at the
 * end. So while `test:e2e` was one invocation, this file could refuse in full and the scenarios
 * would still publish and still spend, which is a checker reporting after the money is gone rather
 * than a gate. `test:e2e` now runs the preflight directory as its own invocation and chains the
 * scenario, service and viewer globs behind an `&&`, so a refusal here exits before any broadcast
 * starts. Fold those two halves back into one command and this file goes back to being a warning.
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
    const refusal = spendRefusal(verdict, SPEND_LEDGER_PATH);

    // The summary is printed only once the run is cleared, and that ordering is the point. A run
    // refused for a deposit has no measurable spend to report, so printing a total first would put
    // a number an operator can act on above the sentence saying the number means nothing.
    if (refusal !== null) {
      assert.fail(refusal);
    }

    console.log(`  authorised ${ledger.authorisedAt}: ${spendSummary(verdict)}`);
  });
});
