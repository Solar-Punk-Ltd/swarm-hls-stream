/**
 * May this bench publish, and may it spend what publishing costs?
 *
 * ## ⛔⛔ A THRESHOLD WRITTEN DOWN IS NOT A CONTROL, ONLY A GATE THAT REFUSES IS
 *
 * `pnpm bench:latency` and `pnpm bench:longrun` publish a real broadcast through the deployment's own
 * Bee nodes and pay for every segment in postage and bandwidth, exactly as a scenario suite does. The
 * suites are gated: `suites/preflight/` reads the owner's authorisation and every node's chequebook
 * before a broadcast starts, and every suite's `before()` reads every publisher's postage TTL. The
 * benches read none of it until 2026-09-16. What stood in for the gate was
 * `deploy/scripts/bench-on-host.sh`, which prepends `pnpm e2e:preflight` to any script whose own
 * definition does not carry the suites, and that covers a bench launched through the wrapper and
 * nothing else. `e2e/README.md` documented a bare `pnpm bench:latency`, so the documented way to run
 * it was the ungated way.
 *
 * A wrapper is an instruction. This is the control, and it sits inside the process that spends.
 *
 * ## The three questions, in the words the suites already refuse in
 *
 * Nothing here is a new rule. Each check calls the helper the suites call, so a bench refusal and a
 * suite refusal are the same sentence about the same stage, and a fix to one fixes both:
 *
 * - the owner's authorisation, from `.spend-ledger.env`, through `harness/spendCeiling.ts`. An absent
 *   ledger refuses. That is the whole point of it: nothing is authorised to spend until the owner has
 *   written what it may spend, so a missing file is a refusal rather than an unlimited allowance.
 * - bandwidth, one SWAP chequebook per publisher node, through `harness/chequebookFunding.ts`.
 * - postage, the batch `BEE_PUBLISHERS` routes each rung to, through `harness/stageStamps.ts`.
 *
 * ## The order is what it costs to ask, cheapest first
 *
 * The ledger is a local file, so a run with no authorisation stops without a single request reaching
 * the deployment, and its refusal ends "nothing on the deployment was touched" truthfully. The
 * chequebook and ceiling reads are one request per node. The postage read is last because it polls a
 * node that cannot answer for a minute before it gives up, and a minute is worth spending only once
 * the two questions ahead of it have said this run is allowed to happen at all.
 */

import { type E2EConfig } from '../config.js';
import { requireChequebookFunding } from '../harness/chequebookFunding.js';
import { type Host, uploaderHealth } from '../harness/host.js';
import { nodesBehind } from '../harness/publishers.js';
import {
  availablePlur,
  ledgerRefusal,
  type NodeReading,
  parseSpendLedger,
  readSpendLedger,
  SPEND_LEDGER_PATH,
  spendAgainstCeiling,
  spendRefusal,
  spendSummary,
} from '../harness/spendCeiling.js';
import { requireStageStamps } from '../harness/stageStamps.js';

/**
 * How much postage TTL a publisher needs before a bench may start, unless the caller knows better.
 *
 * The 600 every suite and `browser/make-recording.ts` pass, so a bench and a scenario draw the line in
 * the same place on the same stage. A run that lasts longer than ten minutes says so instead: the
 * question `stageStamps.ts` answers is whether each node can stamp for the length of THIS run, and a
 * half-hour run gated on ten minutes buys twenty minutes of a rung going dark.
 */
export const MIN_STAMP_TTL_S = 600;

/**
 * Not exported: both callers pass an object literal, so nothing needs the name, and exporting it
 * would add one to the surface that nothing imports. `deploy/scripts/unused-exports.mjs` ratchets on
 * exactly that, and `spendCeiling.ts` records the same rule about its own verdict shapes.
 */
interface BenchAuthorisation {
  /** TTL a publisher's configured batch must beat. Defaults to {@link MIN_STAMP_TTL_S}. */
  readonly minStampTtlS?: number;
  /**
   * Where the owner's authorisation lives.
   *
   * Injected for the same reason `pollConfiguredStamp` takes a clock: `test/benchAuthorisation.test.ts`
   * drives a ledger it wrote itself, so what the cases assert is the rule rather than whatever the
   * machine running them happens to have at the repository root.
   */
  readonly ledgerPath?: string;
}

/**
 * Refuse unless this stage is authorised to spend, funded for bandwidth and stamped for the run.
 *
 * Throws the refusal rather than returning it, because every caller is a bench script whose
 * `main().catch` turns a throw into a non-zero exit, and a gate that hands back a string can be
 * called and ignored.
 *
 * Returns the one sentence a run should print about itself before it starts spending: what was
 * authorised, what has gone, and what is left. The caller prints it, so each bench keeps its own log
 * prefix.
 */
export async function requireBenchAuthorised(
  host: Host,
  cfg: E2EConfig,
  { minStampTtlS = MIN_STAMP_TTL_S, ledgerPath = SPEND_LEDGER_PATH }: BenchAuthorisation = {},
): Promise<string> {
  const ledgerText = readSpendLedger(ledgerPath);
  const ledger = parseSpendLedger(ledgerText);
  if (ledger === null) {
    throw new Error(ledgerRefusal(ledgerPath, ledgerText));
  }

  // Every node the uploader publishes through, named by the rungs it carries, taken from the routing
  // the service reports rather than from this file's own idea of the deployment, so a node added to
  // the stage cannot be one these gates are blind to.
  const publishers = nodesBehind((await uploaderHealth(host, cfg)).publishers, cfg.ports.beeUploaderApi);

  // ⛔ The gateway is in the spend list and out of the other two: it spends on retrievals, so it can
  // take the authorisation past its ceiling, and it holds no upload batch and pushes nothing, so
  // postage and bandwidth have no answer there. `suites/preflight/spend-ceiling.test.ts` draws the
  // same two lines.
  const spenders = [
    ...publishers.map((node) => ({ port: node.port, who: `${node.rungs.join('/')} publisher` })),
    { port: cfg.ports.beeGatewayApi, who: 'gateway' },
  ];

  // Read one node at a time so a chequebook that does not answer is attributable to its node, and so
  // a refusal on the first leaves no later request in flight to reject unhandled.
  const readings: NodeReading[] = [];
  for (const node of spenders) {
    readings.push({
      port: String(node.port),
      who: node.who,
      plur: availablePlur(await host.localJson<unknown>(node.port, '/chequebook/balance'), node.who),
    });
  }

  const verdict = spendAgainstCeiling(ledger, readings);
  const refusal = spendRefusal(verdict, ledgerPath);
  if (refusal !== null) {
    throw new Error(refusal);
  }

  await requireChequebookFunding(host, publishers);
  await requireStageStamps(host, cfg, minStampTtlS);

  return (
    `authorised ${ledger.authorisedAt}: ${spendSummary(verdict)} ` +
    `${publishers.length} publisher node(s) funded, and stamped for longer than ${minStampTtlS}s.`
  );
}
