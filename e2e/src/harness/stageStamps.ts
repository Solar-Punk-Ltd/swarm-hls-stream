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
 * ## ⛔⛔⛔ And the second version of it: the gate read the wrong batch on the right node
 *
 * Closed 2026-09-04, decision 4 of `docs/e2e-batch-drain-plan.md`. Reading every node was only half
 * the job. The batch each reading was about was the node's **best** stamp, the longest-lived usable
 * one it happened to hold, and never the batch `BEE_PUBLISHERS` routes that rung to. A node holding
 * one drained batch, the configured one, beside one fresh unused batch therefore passed this gate
 * cleanly and then refused every upload the rung made, which is the same rung going dark tens of
 * minutes in, from a stage the gate had called healthy.
 *
 * Which batch a node spends is decided in `BEE_PUBLISHERS` and reported on the uploader's `/health`,
 * so that id is the only thing about a node's postage that cannot drift. Every reading below is of
 * that batch and of no other, and the three ways it can fail are named apart in the refusal: the node
 * does not hold it, it holds it and bee will not stamp with it, or it holds it and the TTL is gone.
 * A read that says "this node has postage" answers a question nobody asked.
 *
 * ## What it does not ask
 *
 * The gateway is deliberately not read. It serves retrievals and holds no upload batch, so a stamp
 * question has no answer there.
 *
 * Batch **utilization** is carried on each reading and nothing here judges it. How full a batch is
 * stays the job of `deploy/scripts/stamp-guard.sh` and of the uploader's own `PostageGate`, both of
 * which refuse a batch that is too full to accept the next chunk and both of which own the stop line.
 * A third opinion about the same number, in a third place, would mean an operator had to find out
 * which of the three had fired. This gate asks the one thing neither of those asks per run, which is
 * whether each publisher can stamp with its configured batch for as long as a scenario lasts, and it
 * reports that batch's fill so the read-only smoke run can show a node the other two are about to
 * refuse.
 *
 * The verdict is pure so `test/stageStamps.test.ts` covers it under `pnpm verify`, which nothing
 * under `suites/` is, and picking the configured batch out of what a node lists is
 * `readConfiguredBatch` in `host.ts`, covered in `test/host.test.ts`. That leaves
 * {@link readStageStamps} as the only untested part, and it is wiring.
 */

import type { E2EConfig } from '../config.js';

import {
  batchIdPrefix,
  type ConfiguredBatchState,
  type Host,
  pollConfiguredStamp,
  type Stamp,
  STAMP_READY_TIMEOUT_MS,
  uploaderHealth,
} from './host.js';
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

/** What one publisher node answered about the batch it is configured to stamp with. */
export interface NodeStampReading {
  /** Every rung routed to this node, in the order `/health` listed them. */
  readonly rungs: readonly string[];
  /** The port on the deployment host that reaches this node's bee API. */
  readonly port: number;
  /**
   * The batch `BEE_PUBLISHERS` routes these rungs to, as the uploader's `/health` reports it.
   *
   * ⛔ The CONFIGURED batch, never the one the node happens to be healthiest on. Always known, even
   * when the node holds no such batch, because it comes off the routing rather than off `/stamps`.
   *
   * ⚠️ Truncated to eight characters, the way `/health` and `deploy/scripts/bee-publishers.sh` both
   * truncate it and for their reason: a refusal outlives the run in a scrollback, and a full 64 hex
   * character id is indistinguishable from a wallet private key to anything reading either.
   */
  readonly batch: string;
  /** What the node answered about that batch. Only `held` can clear this gate. */
  readonly state: ConfiguredBatchState;
  /** `batchTTL` on that batch, in seconds, or null when the node did not list it. */
  readonly ttlS: number | null;
  /**
   * How full that batch is, as a percentage of its fullest bucket's capacity, or null when unlisted.
   *
   * ⛔⛔ **Display only, and {@link stageStampsRefusal} deliberately ignores it.** How full a batch is
   * stays the job of `deploy/scripts/stamp-guard.sh` and the uploader's own `PostageGate`, both of
   * which refuse a batch too full to accept the next chunk and both of which own the stop line.
   * Refusing on it here would put a third opinion about the same number in a third place, and the one
   * that fired first would be the one an operator had to go and find.
   *
   * ⭐ Carried anyway because the read-only smoke run prints these, and a node at 90% with a year of
   * TTL clears this gate and is about to be refused by the other two. An operator seeing that on the
   * run they make first is the whole difference between fixing it now and discovering it mid-sitting.
   *
   * ⚠️ The fullest bucket, never the mean: bee's `utilization` counts the fullest of
   * `2 ^ (depth - bucketDepth)` buckets, and the batch is full when THAT one fills.
   *
   * ⚠️ So on a small batch the percentage jumps in coarse steps and reads alarmingly early. The
   * depth 17 batch `docs/e2e-batch-drain-plan.md` fills on purpose has a bucket capacity of two
   * chunks, so one chunk in its fullest bucket prints as 50% full. That is the arithmetic being
   * honest about a two-chunk bucket, not a batch half spent, and it is still not a refusal here.
   */
  readonly utilizationPct: number | null;
  /** What the node said instead of offering that batch, usable. Null when it offered one. */
  readonly problem: string | null;
}

/**
 * How full a batch is, as a percentage, by the same arithmetic `deploy/scripts/stamp-guard.sh` uses.
 *
 * `utilization` is the fullest of `2 ^ (depth - bucketDepth)` buckets, so this is what the batch
 * actually enforces rather than a share of bytes uploaded.
 */
function utilizationPct(stamp: Stamp): number {
  return (100 * stamp.utilization) / 2 ** (stamp.depth - stamp.bucketDepth);
}

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
    'length of a scenario. Each rung publishes through its own node with its own postage batch, and ' +
    'the batch judged here is the one BEE_PUBLISHERS routes that rung to rather than the healthiest ' +
    'one the node happens to hold, so this is not the whole stage refusing, it is the rung(s) named ' +
    'here going dark partway through a broadcast, which reaches a viewer as an ABR fault and gets ' +
    'scored as one:\n' +
    failing.map((reading) => `  | ${describeFailure(reading, minTtlS)}`).join('\n') +
    `\n${NOTHING_SPENT} ${WHERE_BATCHES_COME_FROM} Run it for this profile to see what every node is ` +
    'holding and to put a usable batch behind the ones named above.'
  );
}

function cannotStamp(reading: NodeStampReading, minTtlS: number): boolean {
  return reading.state !== 'held' || reading.ttlS === null || reading.ttlS <= minTtlS;
}

/**
 * One line per failing node, naming it by what an operator can act on rather than by an index.
 *
 * ⛔ One plain sentence per cause, and the causes are kept apart on purpose. "This rung cannot stamp"
 * covers a batch that is missing, a batch bee refuses and a batch about to expire, and those have
 * three different fixes. A red that names the wrong one of the three sends the next hour in the wrong
 * direction, which this repo has paid for often enough to be worth six extra words here.
 */
function describeFailure(reading: NodeStampReading, minTtlS: number): string {
  const who = `${reading.rungs.join(', ')} on :${reading.port}`;
  const said = reading.problem ?? 'and it said nothing about why';

  switch (reading.state) {
    case 'unread':
      return `${who} has no usable batch at all: ${said}`;
    case 'absent':
      return (
        `${who} does not hold configured batch ${reading.batch}, which is the one BEE_PUBLISHERS ` +
        `routes this rung to, so every upload it makes would be refused: ${said}`
      );
    case 'unusable':
      return (
        `${who} holds configured batch ${reading.batch} and cannot stamp with it however healthy any ` +
        `other batch on the node looks: bee reports ${said}`
      );
    case 'held':
      return reading.ttlS === null
        ? `${who} offered configured batch ${reading.batch} with no readable TTL, so its headroom for the run is unknown`
        : `${who} configured batch ${reading.batch} has ${reading.ttlS}s of TTL left, and a run needs ` +
            `more than ${minTtlS}s so this rung would expire mid-broadcast`;
  }
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
 *
 * ⛔ The batch each reading is about comes from the ROUTING, not from what the node offered. That is
 * the whole comparison: `/health` says which batch the uploader will spend on this rung, `/stamps`
 * says what the node is holding, and only the row that appears in both can carry a verdict.
 */
export async function readStageStamps(host: Host, cfg: E2EConfig): Promise<NodeStampReading[]> {
  const nodes = nodesBehind((await uploaderHealth(host, cfg)).publishers, cfg.ports.beeUploaderApi);

  const readings: NodeStampReading[] = [];
  for (const node of nodes) {
    const { state, stamp, lastSeen } = await pollConfiguredStamp(host, node.port, node.batch);
    readings.push({
      rungs: node.rungs,
      port: node.port,
      batch: batchIdPrefix(node.batch),
      state,
      ttlS: stamp?.batchTTL ?? null,
      utilizationPct: stamp === null ? null : utilizationPct(stamp),
      problem:
        state === 'held'
          ? null
          : `${lastSeen ?? 'it said nothing about why'}, after ${STAMP_READY_TIMEOUT_MS / 1_000}s of polling`,
    });
  }
  return readings;
}

/**
 * Read the stage's postage and stop the run if any publisher cannot stamp for `minTtlS` seconds.
 *
 * The batch asked about on each node is the one `BEE_PUBLISHERS` routes that rung to, read off the
 * uploader's `/health`, so a node holding a healthy batch it is not configured to use is refused
 * rather than passed. Three refusals come out of that comparison, kept apart in the message: the node
 * does not hold the configured batch, it holds it and bee will not stamp with it, or it holds it and
 * the TTL will not outlast the run.
 *
 * Silent on success on purpose. A suite's console is already carrying discovered ports, segment
 * counts and viewer state, and a gate that says nothing when it passes is a gate whose one line of
 * output means something.
 *
 * ⚠️ The gateway node is deliberately not read: it serves retrievals and holds no upload batch, so
 * this question does not apply to it. Batch utilization is read and never judged, because refusing on
 * it stays with `deploy/scripts/stamp-guard.sh` and the uploader's own `PostageGate`. This asks only
 * whether each publisher can stamp with the batch it will actually spend, for as long as a scenario
 * runs.
 */
export async function requireStageStamps(host: Host, cfg: E2EConfig, minTtlS: number): Promise<void> {
  const refusal = stageStampsRefusal(await readStageStamps(host, cfg), minTtlS);
  if (refusal !== null) {
    throw new Error(refusal);
  }
}
