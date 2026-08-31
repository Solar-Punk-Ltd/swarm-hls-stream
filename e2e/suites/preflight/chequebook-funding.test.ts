import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import { chequebookBalance, makeHost, uploaderHealth } from '../../src/harness/host.js';
import { nodesBehind, type PublisherNode } from '../../src/harness/publishers.js';

/**
 * Preflight — every Bee node this stage publishes through must hold enough SWAP chequebook balance to
 * pay for the bandwidth it consumes pushing segments to Swarm. This is a funding precondition, not a
 * scenario: it runs first (ahead of scenarios/ and service/) so a drained chequebook fails loudly and
 * early instead of surfacing later as opaque upload stalls.
 *
 * **Read-only, deliberately, and it used to not be.** This test used to deposit the shortfall itself
 * by calling `/chequebook/deposit`, a real SWAP transaction on Gnosis mainnet, and then wait up to
 * three minutes for it to mine. That made `pnpm e2e` a command that spends the operator's money with
 * no prompt, on a node whose wallet the suite does not own. Owner decision 2026-08-03: report the
 * shortfall and fail. Funding is a decision, not a fixup, and the person whose wallet it is makes it.
 *
 * The failure message carries the exact amount and the exact call, so acting on it is a copy and a
 * paste rather than a calculation.
 *
 * ## ⛔ Two things this got wrong until 2026-08-31, both of which pass a starved stage
 *
 * **It read one node.** The uploader can publish each rung through its own bee, and did from the
 * per-rung split onwards. This read `bee-uploader` and nothing else, so three of four chequebooks
 * could sit at zero while the preflight reported the stage funded. A dry node is silent: it answers
 * `/health` normally and stalls every paid push behind an allowance that never arrives, so one rung
 * simply stops being produced. That reaches a viewer as an ABR fault and gets scored as one.
 *
 * **It read `totalBalance`.** Total counts value the node has already promised away in cheques its
 * peers have not cashed, so a node with nothing left to spend still reports a healthy total.
 * `availableBalance` is what remains uncommitted, and it is the only one of the two that answers
 * whether the next segment can be paid for. The service-side `ChequebookGate` has always read
 * available. This did not, which made the preflight the weaker of the two gates over the same fact.
 * Both are printed below, because the gap between them is how much the peers are holding.
 */

/** 1 BZZ = 1e16 PLUR (BZZ has 16 decimals). PLUR is bee's integer base unit for every balance field. */
const PLUR_PER_BZZ = 10n ** 16n;
/** Bandwidth floor each node must clear before we trust it to sustain a stream. */
const MIN_CHEQUEBOOK_BZZ = 0.5;

function bzzToPlur(bzz: number): bigint {
  return BigInt(Math.round(bzz * Number(PLUR_PER_BZZ)));
}

/** Human-readable BZZ for logs and failure messages only, where precision loss is harmless. */
function plurToBzz(plur: bigint): string {
  return (Number(plur) / Number(PLUR_PER_BZZ)).toFixed(4);
}

const MIN_CHEQUEBOOK_PLUR = bzzToPlur(MIN_CHEQUEBOOK_BZZ);

const cfg = loadConfig();

interface Reading {
  node: PublisherNode;
  availablePlur: bigint;
  totalPlur: bigint;
}

/**
 * A balance field that is absent, or not an integer string, is refused rather than defaulted.
 * `BigInt(undefined)` throws a TypeError that names neither the node nor the field, and reading a
 * missing balance as zero would fail a funded node while reading it as plenty would pass a dry one.
 */
function plurField(body: Record<string, unknown>, field: string, node: PublisherNode): bigint {
  const raw = body[field];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new Error(
      `${node.url} (:${node.port}) answered /chequebook/balance without a readable ${field} ` +
        `(got ${JSON.stringify(raw)}). An unreadable balance is not a funded one, so this refuses ` +
        'rather than assuming either way.',
    );
  }
  return BigInt(raw);
}

function depositCommand(reading: Reading): string {
  const shortfall = MIN_CHEQUEBOOK_PLUR - reading.availablePlur;
  return `  curl -sS -XPOST 'http://localhost:${reading.node.port}/chequebook/deposit?amount=${shortfall}'`;
}

describe('preflight — every bee node this stage publishes through is funded for bandwidth', () => {
  const host = makeHost(cfg);

  it(`every node holds at least ${MIN_CHEQUEBOOK_BZZ} BZZ available`, async () => {
    const health = await uploaderHealth(host, cfg);
    const nodes = nodesBehind(health.publishers, cfg.ports.beeUploaderApi);

    const readings: Reading[] = [];
    for (const node of nodes) {
      const body = (await chequebookBalance(host, node.port)) as unknown as Record<string, unknown>;
      readings.push({
        node,
        availablePlur: plurField(body, 'availableBalance', node),
        totalPlur: plurField(body, 'totalBalance', node),
      });
    }

    console.log(`  ${nodes.length} bee node(s) publishing ${nodes.reduce((n, x) => n + x.rungs.length, 0)} rung(s):`);
    for (const reading of readings) {
      const held = reading.totalPlur - reading.availablePlur;
      console.log(
        `  | ${reading.node.rungs.join(', ')} :${reading.node.port} batch ${reading.node.batch} — ` +
          `${plurToBzz(reading.availablePlur)} BZZ available of ${plurToBzz(reading.totalPlur)} total ` +
          `(${plurToBzz(held)} in uncashed cheques), need >= ${MIN_CHEQUEBOOK_BZZ}`,
      );
    }

    const starved = readings.filter((reading) => reading.availablePlur < MIN_CHEQUEBOOK_PLUR);
    if (starved.length === 0) {
      return;
    }

    assert.fail(
      `${starved.length} of ${readings.length} bee node(s) cannot pay for bandwidth:\n` +
        starved
          .map(
            (reading) =>
              `  ${reading.node.rungs.join(', ')} on ${reading.node.url} holds ` +
              `${plurToBzz(reading.availablePlur)} BZZ available and needs at least ${MIN_CHEQUEBOOK_BZZ}.`,
          )
          .join('\n') +
        '\nDeposit the shortfall from each node’s own wallet, then re-run. This suite will not spend ' +
        'on your behalf, so nothing has been sent. On the deployment host:\n' +
        starved.map(depositCommand).join('\n') +
        "\nThe amount is in PLUR, bee's integer base unit, and each transaction takes up to three " +
        'minutes to mine.',
    );
  });
});
