import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { chequebookBalance, depositToChequebook, makeHost } from '../../src/harness/host.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Preflight — the bee-uploader node must hold enough SWAP chequebook balance to pay for the bandwidth
 * it consumes pushing segments to Swarm. This is a funding precondition, not a scenario: it runs
 * first (ahead of scenarios/ and service/) so a drained chequebook fails loudly and early instead of
 * surfacing later as opaque upload stalls. Only the uploader node is touched — the gateway and any
 * other nodes are left alone.
 *
 * If the balance is below the floor, it deposits the shortfall from the node's own wallet (a real
 * on-chain SWAP tx) and waits for it to mine. If it still can't reach the floor — e.g. the wallet is
 * empty — the test FAILS, exactly as an unfunded node would fail a real broadcast.
 */

/** 1 BZZ = 1e16 PLUR (BZZ has 16 decimals). PLUR is bee's integer base unit for every balance field. */
const PLUR_PER_BZZ = 10n ** 16n;
/** Bandwidth floor the uploader must clear before we trust it to sustain a stream. */
const MIN_CHEQUEBOOK_BZZ = 0.5;
const DEPOSIT_MINE_TIMEOUT_MS = 180_000;
const DEPOSIT_POLL_INTERVAL_MS = 5_000;

function bzzToPlur(bzz: number): bigint {
  return BigInt(Math.round(bzz * Number(PLUR_PER_BZZ)));
}

/** Human-readable BZZ for logs/labels only — precision loss here is harmless. */
function plurToBzz(plur: bigint): string {
  return (Number(plur) / Number(PLUR_PER_BZZ)).toFixed(4);
}

const MIN_CHEQUEBOOK_PLUR = bzzToPlur(MIN_CHEQUEBOOK_BZZ);

describe('preflight — bee-uploader chequebook is funded for bandwidth', () => {
  const cfg = loadConfig();
  const host = makeHost(cfg);
  const beeUploader = containerName(cfg, 'bee-uploader');

  it(`holds at least ${MIN_CHEQUEBOOK_BZZ} BZZ (tops up from the node wallet if short)`, async () => {
    const initialPlur = BigInt((await chequebookBalance(host, cfg)).totalBalance);
    console.log(`  ${beeUploader} chequebook: ${plurToBzz(initialPlur)} BZZ total (need ≥ ${MIN_CHEQUEBOOK_BZZ})`);

    if (initialPlur >= MIN_CHEQUEBOOK_PLUR) {
      return; // already funded — read-only, nothing to spend
    }

    const shortfall = MIN_CHEQUEBOOK_PLUR - initialPlur;
    console.log(`  under-funded by ${plurToBzz(shortfall)} BZZ — depositing from the node wallet…`);
    const txHash = await depositToChequebook(host, cfg, shortfall);
    console.log(`  deposit tx ${txHash} — waiting for it to mine…`);

    await waitFor(async () => BigInt((await chequebookBalance(host, cfg)).totalBalance) >= MIN_CHEQUEBOOK_PLUR, {
      timeoutMs: DEPOSIT_MINE_TIMEOUT_MS,
      intervalMs: DEPOSIT_POLL_INTERVAL_MS,
      label: `chequebook reaches ${MIN_CHEQUEBOOK_BZZ} BZZ after deposit ${txHash} — is the node wallet funded?`,
    });

    const fundedPlur = BigInt((await chequebookBalance(host, cfg)).totalBalance);
    assert.ok(
      fundedPlur >= MIN_CHEQUEBOOK_PLUR,
      `chequebook still under ${MIN_CHEQUEBOOK_BZZ} BZZ after deposit: ${plurToBzz(fundedPlur)} BZZ`,
    );
    console.log(`  funded: ${plurToBzz(fundedPlur)} BZZ total`);
  });
});
