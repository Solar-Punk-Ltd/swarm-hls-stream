/**
 * Can every Bee node this stage publishes through still stamp an upload for the length of a run?
 *
 * ## ⛔⛔⛔ Why this exists: the gate spoke for four nodes and read one
 *
 * Every suite opened its `before()` by discovering a stamp and asserting its TTL. The discovery read
 * `/stamps` on the coordinator alone, which is `cfg.ports.beeUploaderApi`, while the assertion it fed
 * was written as a statement about the stage. Since the per-rung split there are four publisher
 * nodes, each with its own postage batch, so an expired or unusable batch on the 1080p node passed
 * that gate every time and surfaced tens of minutes later as a rung that stopped being produced.
 *
 * That reaches a viewer as an ABR fault and gets scored as one. This repo has already spent days on
 * exactly that shape of mistake: a single-node instrument reporting on a four-node stage is not a
 * partial reading, it is a false one.
 *
 * So the rule below reads every publisher node, and refuses if any of them cannot stamp.
 *
 * ## What it does not ask
 *
 * The gateway is deliberately not read. It serves retrievals and holds no upload batch, so a stamp
 * question has no answer there.
 *
 * Batch **utilization** is not read either. How full a batch is stays the job of
 * `deploy/scripts/stamp-guard.sh` and of the uploader's own `PostageGate`, both of which refuse a
 * batch that is too full to accept the next chunk. This gate asks the one thing neither of those
 * asks per run, which is whether each publisher can stamp at all for as long as a scenario lasts.
 *
 * The verdict is pure so `test/stageStamps.test.ts` covers it under `pnpm verify`, which nothing
 * under `suites/` is. That leaves {@link readStageStamps} as the only untested part, and it is wiring.
 */

import type { E2EConfig } from '../config.js';

import { type Host, pollUsableStamp, STAMP_READY_TIMEOUT_MS, uploaderHealth } from './host.js';
import { nodesBehind } from './publishers.js';

/**
 * Where an operator goes to put a usable batch behind a rung. Named in every refusal below, because a
 * refusal that stops at "the batch is bad" leaves the reader to find that out for themselves.
 */
const WHERE_BATCHES_COME_FROM =
  'deploy/scripts/bee-publishers.sh is what selects and validates one batch per rung for a profile, ' +
  'and it refuses the same TTL floor the service does.';

/** Every refusal here stops the run before a broadcast starts, and says so, because that is the point. */
const NOTHING_SPENT = 'Nothing has been run and nothing on the deployment was touched.';

/** What one publisher node answered when it was asked for the batch it can stamp with. */
export interface NodeStampReading {
  /** Every rung routed to this node, in the order `/health` listed them. */
  readonly rungs: readonly string[];
  /** The port on the deployment host that reaches this node's bee API. */
  readonly port: number;
  /**
   * The batch behind this node's best usable stamp, or null when it has none.
   *
   * ⚠️ Truncated to eight characters, the way `/health` and `deploy/scripts/bee-publishers.sh` both
   * truncate it and for their reason: a refusal outlives the run in a scrollback, and a full 64 hex
   * character id is indistinguishable from a wallet private key to anything reading either.
   */
  readonly batch: string | null;
  /** `batchTTL` on that stamp, in seconds, or null when there was no stamp to read one off. */
  readonly ttlS: number | null;
  /** What the node said instead of offering a stamp. Null when it offered one. */
  readonly problem: string | null;
}

/** How much of a batch id ever reaches a printed line. See {@link NodeStampReading.batch}. */
const BATCH_ID_SHOWN = 8;

/**
 * Null when this stage may run, or the refusal to print and stop on.
 *
 * ⛔ An empty reading list refuses. Nothing to check is not the same as nothing wrong, and a stage
 * whose publishers were never enumerated is the one case where every rung's postage is unknown at
 * once.
 *
 * ⛔ At the minimum refuses, not only under it. A batch with exactly the floor left has no headroom
 * for the run about to start, and the assertion this replaced drew the line the same way.
 */
export function stageStampsRefusal(readings: readonly NodeStampReading[], minTtlS: number): string | null {
  if (readings.length === 0) {
    return (
      'No Bee node was read for postage, because the publisher routing named none. An empty stage is ' +
      'not a passing one: every rung still has to be stamped by something, unknown postage is not ' +
      'headroom, and a run started here would spend a whole broadcast finding out which rung stops.\n' +
      `${NOTHING_SPENT} The routing comes off the uploader's own /health, so start there and check ` +
      `that it names a node per rung. ${WHERE_BATCHES_COME_FROM}`
    );
  }

  const failing = readings.filter((reading) => cannotStamp(reading, minTtlS));
  if (failing.length === 0) {
    return null;
  }

  return (
    `${failing.length} of ${readings.length} Bee node(s) on this stage cannot stamp an upload for the ` +
    'length of a scenario. Each rung publishes through its own node with its own postage batch, so ' +
    'this is not the whole stage refusing, it is the rung(s) named here going dark partway through a ' +
    'broadcast, which reaches a viewer as an ABR fault and gets scored as one:\n' +
    failing.map((reading) => `  | ${describeFailure(reading, minTtlS)}`).join('\n') +
    `\n${NOTHING_SPENT} ${WHERE_BATCHES_COME_FROM} Run it for this profile to see what every node is ` +
    'holding and to put a usable batch behind the ones named above.'
  );
}

function cannotStamp(reading: NodeStampReading, minTtlS: number): boolean {
  return reading.problem !== null || reading.ttlS === null || reading.ttlS <= minTtlS;
}

/** One line per failing node, naming it by what an operator can act on rather than by an index. */
function describeFailure(reading: NodeStampReading, minTtlS: number): string {
  const who = `${reading.rungs.join(', ')} on :${reading.port}`;
  if (reading.ttlS === null || reading.batch === null) {
    return `${who} has no usable batch at all: ${reading.problem ?? 'it offered no stamp and said nothing about why'}`;
  }
  if (reading.problem !== null) {
    return `${who} batch ${reading.batch} was read but cannot be trusted: ${reading.problem}`;
  }
  return (
    `${who} batch ${reading.batch} has ${reading.ttlS}s of TTL left, and a run needs more than ${minTtlS}s ` +
    'so this rung would expire mid-broadcast'
  );
}

/**
 * Read every publisher node's postage, one attributable read at a time.
 *
 * Sequential rather than concurrent, the way `suites/preflight/chequebook-funding.test.ts` reads
 * balances: these go over one multiplexed ssh connection, and a failure that cannot be attributed to
 * a node is worth less than the seconds it saves.
 *
 * Each node is polled rather than read once, because a scenario that restarts a bee leaves its stamp
 * reporting `usable: false` for tens of seconds while the batch re-syncs even though uploads already
 * work. A single read taken inside that window would refuse a stage that is fine.
 */
export async function readStageStamps(host: Host, cfg: E2EConfig): Promise<NodeStampReading[]> {
  const nodes = nodesBehind((await uploaderHealth(host, cfg)).publishers, cfg.ports.beeUploaderApi);

  const readings: NodeStampReading[] = [];
  for (const node of nodes) {
    const { stamp, lastSeen } = await pollUsableStamp(host, node.port);
    readings.push({
      rungs: node.rungs,
      port: node.port,
      batch: stamp === null ? null : stamp.batchID.slice(0, BATCH_ID_SHOWN),
      ttlS: stamp?.batchTTL ?? null,
      problem:
        stamp === null
          ? `nothing usable after ${STAMP_READY_TIMEOUT_MS / 1_000}s of polling, and it last said: ${lastSeen}`
          : null,
    });
  }
  return readings;
}

/**
 * Read the stage's postage and stop the run if any publisher cannot stamp for `minTtlS` seconds.
 *
 * Silent on success on purpose. A suite's console is already carrying discovered ports, segment
 * counts and viewer state, and a gate that says nothing when it passes is a gate whose one line of
 * output means something.
 *
 * ⚠️ The gateway node is deliberately not read: it serves retrievals and holds no upload batch, so
 * this question does not apply to it. Batch utilization is not read either, that stays with
 * `deploy/scripts/stamp-guard.sh` and the uploader's own `PostageGate`. This asks only whether each
 * publisher can stamp at all, for as long as a scenario runs.
 */
export async function requireStageStamps(host: Host, cfg: E2EConfig, minTtlS: number): Promise<void> {
  const refusal = stageStampsRefusal(await readStageStamps(host, cfg), minTtlS);
  if (refusal !== null) {
    throw new Error(refusal);
  }
}
