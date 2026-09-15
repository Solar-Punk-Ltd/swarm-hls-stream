/**
 * Can every Bee node this stage publishes through pay for the bandwidth a run costs?
 *
 * SWAP chequebook balance per publisher node, against a floor. A dry node is silent about it: it
 * answers `/health` normally and stalls every paid push behind an allowance that never arrives, so
 * one rung simply stops being produced. That reaches a viewer as an ABR fault and gets scored as one.
 *
 * **Read-only, deliberately, and it used to not be.** This used to deposit the shortfall itself by
 * calling `/chequebook/deposit`, a real SWAP transaction on Gnosis mainnet, and then wait up to three
 * minutes for it to mine. That made `pnpm e2e` a command that spends the operator's money with no
 * prompt, on a node whose wallet the suite does not own. Owner decision 2026-08-03: report the
 * shortfall and fail. Funding is a decision, not a fixup, and the person whose wallet it is makes it.
 *
 * The refusal carries the exact amount and the exact call, so acting on it is a copy and a paste
 * rather than a calculation.
 *
 * ## ⛔ Two things this got wrong until 2026-08-31, both of which pass a starved stage
 *
 * **It read one node.** The uploader can publish each rung through its own bee, and did from the
 * per-rung split onwards. It read `bee-uploader` and nothing else, so three of four chequebooks could
 * sit at zero while the gate reported the stage funded.
 *
 * **It read `totalBalance`.** Total counts value the node has already promised away in cheques its
 * peers have not cashed, so a node with nothing left to spend still reports a healthy total.
 * `availableBalance` is what remains uncommitted, and it is the only one of the two that answers
 * whether the next segment can be paid for. The service-side `ChequebookGate` has always read
 * available. This did not, which made the preflight the weaker of the two gates over the same fact.
 * Both are printed by {@link describeChequebookFunding}, because the gap between them is how much the
 * peers are holding.
 *
 * ## Why the rule is here rather than in the suite that prints it
 *
 * `suites/preflight/chequebook-funding.test.ts` held the floor and every sentence until 2026-09-16, so
 * a second gate asking the same question had to restate both, and two copies of a refusal drift.
 * `bench/latency.ts` and `bench/longrun.ts` publish and spend without going anywhere near `suites/`,
 * and they now ask this through {@link requireChequebookFunding} and get the same answer in the same
 * words. `spendCeiling.ts` and `stageStamps.ts` are laid out this way for the same reason: nothing
 * under `suites/` runs in CI, so the rule lives where a unit test can reach it and the suite is wiring.
 *
 * An empty node list cannot arrive here. `nodesBehind` refuses a routing that names no node, so every
 * caller reaches this holding at least one.
 */

import { chequebookBalance, type Host } from './host.js';
import type { PublisherNode } from './publishers.js';

/** 1 BZZ = 1e16 PLUR (BZZ has 16 decimals). PLUR is bee's integer base unit for every balance field. */
const PLUR_PER_BZZ = 10n ** 16n;

/** Bandwidth floor each node must clear before we trust it to sustain a stream. */
export const MIN_CHEQUEBOOK_BZZ = 0.5;

function bzzToPlur(bzz: number): bigint {
  return BigInt(Math.round(bzz * Number(PLUR_PER_BZZ)));
}

/** Human-readable BZZ for logs and failure messages only, where precision loss is harmless. */
function plurToBzz(plur: bigint): string {
  return (Number(plur) / Number(PLUR_PER_BZZ)).toFixed(4);
}

const MIN_CHEQUEBOOK_PLUR = bzzToPlur(MIN_CHEQUEBOOK_BZZ);

/**
 * What one publisher node's chequebook answered, with the node it belongs to carried alongside.
 *
 * Not exported: callers take it from {@link readChequebookFunding}'s inferred return, and exporting it
 * would add a name to the surface that nothing imports. `spendCeiling.ts` keeps its own two verdict
 * shapes unexported for the same reason, and `deploy/scripts/unused-exports.mjs` ratchets on it.
 */
interface NodeFunding {
  readonly node: PublisherNode;
  readonly availablePlur: bigint;
  readonly totalPlur: bigint;
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

function depositCommand(reading: NodeFunding): string {
  const shortfall = MIN_CHEQUEBOOK_PLUR - reading.availablePlur;
  return `  curl -sS -XPOST 'http://localhost:${reading.node.port}/chequebook/deposit?amount=${shortfall}'`;
}

/**
 * Read every publisher node's chequebook, one attributable read at a time.
 *
 * Sequential rather than concurrent, the way `readStageStamps` reads postage: these go over one
 * multiplexed ssh connection, and a failure that cannot be attributed to a node is worth less than
 * the seconds it saves.
 */
export async function readChequebookFunding(host: Host, nodes: readonly PublisherNode[]): Promise<NodeFunding[]> {
  const readings: NodeFunding[] = [];
  for (const node of nodes) {
    const body = (await chequebookBalance(host, node.port)) as unknown as Record<string, unknown>;
    readings.push({
      node,
      availablePlur: plurField(body, 'availableBalance', node),
      totalPlur: plurField(body, 'totalBalance', node),
    });
  }
  return readings;
}

/** What the stage is holding, one line per node, for a caller whose output an operator reads. */
export function describeChequebookFunding(readings: readonly NodeFunding[]): string[] {
  const rungs = readings.reduce((count, reading) => count + reading.node.rungs.length, 0);

  return [
    `  ${readings.length} bee node(s) publishing ${rungs} rung(s):`,
    ...readings.map((reading) => {
      const held = reading.totalPlur - reading.availablePlur;
      return (
        `  | ${reading.node.rungs.join(', ')} :${reading.node.port} batch ${reading.node.batch}, ` +
        `${plurToBzz(reading.availablePlur)} BZZ available of ${plurToBzz(reading.totalPlur)} total ` +
        `(${plurToBzz(held)} in uncashed cheques), need >= ${MIN_CHEQUEBOOK_BZZ}`
      );
    }),
  ];
}

/** Why this stage cannot pay for the bandwidth a run costs, or null when every node can. */
export function chequebookFundingRefusal(readings: readonly NodeFunding[]): string | null {
  const starved = readings.filter((reading) => reading.availablePlur < MIN_CHEQUEBOOK_PLUR);
  if (starved.length === 0) {
    return null;
  }

  return (
    `${starved.length} of ${readings.length} bee node(s) cannot pay for bandwidth:\n` +
    starved
      .map(
        (reading) =>
          `  ${reading.node.rungs.join(', ')} on ${reading.node.url} holds ` +
          `${plurToBzz(reading.availablePlur)} BZZ available and needs at least ${MIN_CHEQUEBOOK_BZZ}.`,
      )
      .join('\n') +
    '\nDeposit the shortfall from each node’s own wallet, then re-run. Nothing here spends on your ' +
    'behalf, so nothing has been sent. On the deployment host:\n' +
    starved.map(depositCommand).join('\n') +
    "\nThe amount is in PLUR, bee's integer base unit, and each transaction takes up to three " +
    'minutes to mine.'
  );
}

/**
 * Read the stage's chequebooks and stop the run if any publisher cannot pay for its bandwidth.
 *
 * Silent on success, the way `requireStageStamps` is: a caller that wants the per-node figures prints
 * {@link describeChequebookFunding} itself, and one that is about to publish wants a gate rather than
 * a table.
 */
export async function requireChequebookFunding(host: Host, nodes: readonly PublisherNode[]): Promise<void> {
  const refusal = chequebookFundingRefusal(await readChequebookFunding(host, nodes));
  if (refusal !== null) {
    throw new Error(refusal);
  }
}
