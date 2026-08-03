import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { chequebookBalance, makeHost } from '../../src/harness/host.js';

/**
 * Preflight — the bee-uploader node must hold enough SWAP chequebook balance to pay for the bandwidth
 * it consumes pushing segments to Swarm. This is a funding precondition, not a scenario: it runs
 * first (ahead of scenarios/ and service/) so a drained chequebook fails loudly and early instead of
 * surfacing later as opaque upload stalls. Only the uploader node is read, and only read.
 *
 * **Read-only, deliberately, and it used to not be.** This test used to deposit the shortfall itself
 * by calling `/chequebook/deposit`, a real SWAP transaction on Gnosis mainnet, and then wait up to
 * three minutes for it to mine. That made `pnpm e2e` a command that spends the operator's money with
 * no prompt, on a node whose wallet the suite does not own. Owner decision 2026-08-03: report the
 * shortfall and fail. Funding is a decision, not a fixup, and the person whose wallet it is makes it.
 *
 * The failure message carries the exact amount and the exact call, so acting on it is a copy and a
 * paste rather than a calculation.
 */

/** 1 BZZ = 1e16 PLUR (BZZ has 16 decimals). PLUR is bee's integer base unit for every balance field. */
const PLUR_PER_BZZ = 10n ** 16n;
/** Bandwidth floor the uploader must clear before we trust it to sustain a stream. */
const MIN_CHEQUEBOOK_BZZ = 0.5;

function bzzToPlur(bzz: number): bigint {
  return BigInt(Math.round(bzz * Number(PLUR_PER_BZZ)));
}

/** Human-readable BZZ for logs and failure messages only, where precision loss is harmless. */
function plurToBzz(plur: bigint): string {
  return (Number(plur) / Number(PLUR_PER_BZZ)).toFixed(4);
}

const MIN_CHEQUEBOOK_PLUR = bzzToPlur(MIN_CHEQUEBOOK_BZZ);

describe('preflight — bee-uploader chequebook is funded for bandwidth', () => {
  const cfg = loadConfig();
  const host = makeHost(cfg);
  const beeUploader = containerName(cfg, 'bee-uploader');

  it(`holds at least ${MIN_CHEQUEBOOK_BZZ} BZZ`, async () => {
    const totalPlur = BigInt((await chequebookBalance(host, cfg)).totalBalance);
    console.log(`  ${beeUploader} chequebook: ${plurToBzz(totalPlur)} BZZ total (need >= ${MIN_CHEQUEBOOK_BZZ})`);

    if (totalPlur >= MIN_CHEQUEBOOK_PLUR) {
      return;
    }

    const shortfall = MIN_CHEQUEBOOK_PLUR - totalPlur;
    assert.fail(
      `${beeUploader} chequebook holds ${plurToBzz(totalPlur)} BZZ and needs at least ` +
        `${MIN_CHEQUEBOOK_BZZ}. Deposit ${plurToBzz(shortfall)} BZZ or more from the node's own ` +
        'wallet, then re-run. This suite will not spend on your behalf, so nothing has been sent. ' +
        `On the deployment host:\n` +
        `  curl -sS -XPOST 'http://localhost:${cfg.ports.beeUploaderApi}/chequebook/deposit?amount=${shortfall}'\n` +
        "The amount is in PLUR, bee's integer base unit, and the transaction takes up to three " +
        'minutes to mine.',
    );
  });
});
