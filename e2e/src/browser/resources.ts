/**
 * What a run consumed, read off the deployment before and after it.
 *
 * ## Why a run should account for itself
 *
 * The two things that stop this project measuring anything are a postage batch with no room and a
 * chequebook with no BZZ, and both have bound mid-campaign before. On 2026-08-05 the uploader's
 * chequebook hit exactly zero at run 7 of 12 and the runs on either side of it were not comparable,
 * with nothing in either report saying so.
 *
 * Every cost figure this project holds has been an estimate off two readings taken by hand at
 * different times. A run that records its own consumption turns "roughly 0.23 buckets a minute" into
 * a measurement, which is the difference between buying postage on arithmetic and buying it on
 * evidence.
 *
 * ## The postage number is a maximum, not a mean
 *
 * `utilization` is the fullest bucket, not the average one, and a batch is full when **that** bucket
 * reaches `2 ^ (depth - bucketDepth)`. So capacity cannot be read off total bytes uploaded, and the
 * only honest way to project it is to watch the number the batch actually enforces.
 *
 * ⚠️ **A maximum over sixty-five thousand buckets grows fastest when the batch is nearly empty**, and
 * then flattens as the distribution concentrates. So the rate an early run measures **overstates**
 * the long-run rate, and the runway it projects is a floor rather than an estimate. The first run on
 * a fresh depth-24 batch measured 0.59 buckets a minute where the previous batch had settled at about
 * 0.22 over hours. Read a single run's projection as "at least this much", and let later runs on the
 * same batch refine it.
 */

import { type E2EConfig } from '../config.js';
import { chequebookBalance, type Host, type Stamp, uploaderHealth } from '../harness/host.js';
import { nodesBehind, type PublisherNode } from '../harness/publishers.js';

/** 1 BZZ in PLUR, which is the unit every bee balance is quoted in. */
export const PLUR_PER_BZZ = 1e16;

/**
 * Utilization at which a batch is called nearly full.
 *
 * `b4b44086` is immutable, so reaching the limit does not evict quietly, it refuses uploads. A run
 * that dies at minute forty of an hour is a wasted broadcast, so the warning has to arrive with
 * enough room left to finish whatever is already planned.
 */
export const POSTAGE_WARN_SHARE = 0.8;

/** TTL below which the batch expires sooner than a campaign is likely to finish. */
export const POSTAGE_WARN_TTL_DAYS = 3;

/** Chequebook balance below which there is not obviously another long run's worth of BZZ. */
export const CHEQUEBOOK_WARN_BZZ = 1.5;

/** One Bee node's postage and funding, at one moment. */
export interface NodeReading {
  /** The rung this node carries, or `all` when one node carries everything. */
  rung: string;
  /** Host port, which is how a node is matched between the before and after readings. */
  port: number;
  batchId: string;
  /** The fullest bucket, which is the number the batch enforces. */
  postageUtilization: number;
  /** What that bucket has to reach for the batch to be full: `2 ^ (depth - bucketDepth)`. */
  postageCapacity: number;
  postageTtlDays: number;
  postageImmutable: boolean;
  bzz: number;
}

/**
 * What the whole stage held at one moment.
 *
 * ⛔⛔⛔ **This was one node until 2026-08-31, and after the per-rung split that made every cost
 * figure wrong rather than merely partial.** A split stage spends four batches and four chequebooks,
 * and `bzzPerMegabyte` divides one node's spend by every rung's delivered bytes. Across the shipped
 * ladder 1080p burns roughly seven times the bytes of 360p, so a per-minute rate read off the 360p
 * node alone understates the stage by about 4x, and a runway derived from it overstates by the same.
 * A wrong number is worse than a missing one, because it gets planned against.
 */
export interface ResourceReading {
  atMs: number;
  /** Every node the stage publishes through, in ladder order. One entry on an unsplit deployment. */
  nodes: NodeReading[];
}

export interface ResourceCost {
  before: ResourceReading;
  after: ResourceReading;
  /** Broadcast minutes this run covered, which is what both numbers are consumed per unit of. */
  minutes: number;
  bucketsUsed: number;
  bzzSpent: number;
  bucketsPerMinute: number;
  bzzPerMinute: number;
  /**
   * BZZ per megabyte of segment delivered, or null when the run counted no bytes.
   *
   * ⛔ **The per-minute rate above is not a property of the deployment**, and reading it as one has
   * already produced a wrong runway. Measured 2026-08-07 across seventeen recorded runs at a fixed
   * 0.25s segment: 0.0179 BZZ/min at 720p and **0.0389 at 1080p**, so a projection made at the first
   * while running the second is out by 2.2x. Normalised by bytes the same seventeen runs sit inside
   * 0.00081 to 0.00096 across that whole 2.5x spread in bitrate.
   *
   * ⚠️ It is not constant either, and the scope matters. Every one of those runs was at a 0.25s
   * segment. A sixty-minute run at 1.0s delivering the same bitrate came in at 0.00062, a 1.39x
   * move, and a controlled ABA put the per-minute gap at 23.5%. **So this figure carries across
   * bitrates and not across segment lengths**, which is still one more dimension than a per-minute
   * rate carries across.
   */
  bzzPerMegabyte: number | null;
  /**
   * Broadcast minutes before the first batch refuses uploads, at this run's own rate.
   *
   * ⚠️ The **minimum** across nodes, never the sum. The stage stops when any one rung's batch fills,
   * and on a split ladder 1080p fills roughly seven times faster than 360p, so summing the headroom
   * would report a runway about four times longer than the one that actually binds.
   */
  minutesOfPostageLeft: number | null;
  /** Broadcast minutes before the first chequebook is empty, at this run's own rate. The minimum. */
  minutesOfBzzLeft: number | null;
  /** Per node, so a report can show which rung is the one running out. Ladder order. */
  perNode: NodeCost[];
  /** Anything that should stop the next run being planned as though nothing had changed. */
  warnings: string[];
}

/** One node's consumption over the run, matched between the two readings by port. */
export interface NodeCost {
  rung: string;
  port: number;
  before: NodeReading;
  after: NodeReading;
  bucketsUsed: number;
  bzzSpent: number;
  bucketsPerMinute: number;
  bzzPerMinute: number;
  minutesOfPostageLeft: number | null;
  minutesOfBzzLeft: number | null;
}

/**
 * Read every node the stage publishes through, off the routing the uploader reports.
 *
 * ⛔ The batch is found by the prefix on that routing rather than by picking the longest-lived usable
 * one off `/stamps`. Selecting a batch by shape is how a gate here came to read a row no sitting
 * wrote to: `/stamps` lists batches of which some are dead, some belong to other work, and "the
 * stamp" has meant a different row on three separate days. The id the uploader is configured with is
 * the only thing that cannot drift, and eight hex characters is enough to find it among the handful a
 * node holds. Two rows sharing that prefix is a refusal rather than a guess.
 */
export async function readResources(host: Host, cfg: E2EConfig): Promise<ResourceReading> {
  const health = await uploaderHealth(host, cfg);
  const nodes = nodesBehind(health.publishers, cfg.ports.beeUploaderApi);

  const readings = await Promise.all(
    nodes.map(async (node): Promise<NodeReading> => {
      const [stamps, cheque] = await Promise.all([
        host.localJson<{ stamps: Stamp[] }>(node.port, '/stamps'),
        chequebookBalance(host, node.port),
      ]);
      const stamp = matchBatch(stamps.stamps ?? [], node.batch, node);

      return {
        rung: node.rungs.join('+'),
        port: node.port,
        batchId: stamp.batchID,
        postageUtilization: stamp.utilization,
        postageCapacity: 2 ** (stamp.depth - stamp.bucketDepth),
        postageTtlDays: stamp.batchTTL / 86_400,
        postageImmutable: stamp.immutableFlag,
        bzz: Number(cheque.availableBalance) / PLUR_PER_BZZ,
      };
    }),
  );

  return { atMs: Date.now(), nodes: readings };
}

/** The row the routing names, or a refusal. `truncated` is the eight-character form `/health` reports. */
function matchBatch(stamps: readonly Stamp[], truncated: string, node: PublisherNode): Stamp {
  const prefix = truncated.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  const matches = stamps.filter((stamp) => stamp.batchID.toLowerCase().startsWith(prefix));

  if (matches.length === 1) {
    return matches[0];
  }
  const listed = stamps.map((stamp) => stamp.batchID.slice(0, 8)).join(', ') || 'nothing';
  throw new Error(
    `the ${node.rungs.join(', ')} node on :${node.port} has ${matches.length} batches starting ${prefix}, ` +
      `and /stamps lists ${listed}. A cost read against the wrong batch is worse than no cost at all, ` +
      'so this refuses rather than picking one.',
  );
}

function totalBzz(reading: ResourceReading): number {
  return reading.nodes.reduce((total, node) => total + node.bzz, 0);
}

function totalBuckets(reading: ResourceReading): number {
  return reading.nodes.reduce((total, node) => total + node.postageUtilization, 0);
}

/** The batch that expires first, because that is the one that stops a rung. */
function soonestExpiryDays(reading: ResourceReading): number {
  return Math.min(...reading.nodes.map((node) => node.postageTtlDays));
}

/**
 * A rate this run measured, projected forward, or null when the run consumed nothing measurable.
 *
 * Null rather than Infinity: a run too short to move a counter has not shown that the resource is
 * plentiful, it has shown that this run cannot answer the question, and those read very differently
 * in a report.
 */
function runwayAt(remaining: number, perMinute: number): number | null {
  return perMinute > 0 ? remaining / perMinute : null;
}

/**
 * The runway that binds, which is the shortest one any node reported.
 *
 * ⛔ Never the sum and never an average. The stage stops when the first rung's batch fills or its
 * chequebook empties, and on a split ladder the rungs drain at rates that differ by about seven
 * times, so anything but the minimum reports a runway the stage does not have.
 *
 * Nulls are dropped rather than treated as zero: a node whose counter did not move over this run has
 * not shown that it is out, it has shown that this run cannot answer for it.
 */
function soonestRunway(runways: readonly (number | null)[]): number | null {
  const measured = runways.filter((runway): runway is number => runway !== null);
  return measured.length > 0 ? Math.min(...measured) : null;
}

/**
 * Pair the two readings up by port, and say so when they do not pair.
 *
 * A node in one reading and not the other means the deployment was re-routed while the run was in
 * flight, which makes every rate that spans it a comparison of two different stages. Warned rather
 * than thrown, because the run has already happened and its other numbers are still worth reading,
 * but warned loudly enough that nobody plans off the rates.
 */
function matchNodes(before: ResourceReading, after: ResourceReading, minutes: number, warnings: string[]): NodeCost[] {
  const beforeByPort = new Map(before.nodes.map((node) => [node.port, node]));
  const afterByPort = new Map(after.nodes.map((node) => [node.port, node]));

  for (const node of before.nodes) {
    if (!afterByPort.has(node.port)) {
      warnings.push(
        `the ${node.rung} node on :${node.port} was publishing when the run started and is not in the ` +
          'routing now. The deployment was re-routed mid-run, so every rate here spans two stages.',
      );
    }
  }
  for (const node of after.nodes) {
    if (!beforeByPort.has(node.port)) {
      warnings.push(
        `the ${node.rung} node on :${node.port} is in the routing now and was not when the run started. ` +
          'The deployment was re-routed mid-run, so every rate here spans two stages.',
      );
    }
  }

  return after.nodes
    .filter((node) => beforeByPort.has(node.port))
    .map((node) => {
      const start = beforeByPort.get(node.port)!;
      const bucketsUsed = node.postageUtilization - start.postageUtilization;
      const bzzSpent = start.bzz - node.bzz;
      const bucketsPerMinute = minutes > 0 ? bucketsUsed / minutes : 0;
      const bzzPerMinute = minutes > 0 ? bzzSpent / minutes : 0;

      return {
        rung: node.rung,
        port: node.port,
        before: start,
        after: node,
        bucketsUsed,
        bzzSpent,
        bucketsPerMinute,
        bzzPerMinute,
        minutesOfPostageLeft: runwayAt(node.postageCapacity - node.postageUtilization, bucketsPerMinute),
        minutesOfBzzLeft: runwayAt(node.bzz, bzzPerMinute),
      };
    });
}

const BYTES_PER_MEGABYTE = 1_000_000;

/**
 * @param segmentBytesDelivered What actually arrived, from `summarizeNetwork`. Omitted by a caller
 *   that watched nothing, in which case the per-byte figure is null rather than zero: a run with no
 *   viewer has not shown that bytes are free, it has shown that it cannot answer.
 */
export function judgeCost(
  before: ResourceReading,
  after: ResourceReading,
  segmentBytesDelivered?: number,
): ResourceCost {
  const minutes = (after.atMs - before.atMs) / 60_000;
  const warnings: string[] = [];
  const perNode = matchNodes(before, after, minutes, warnings);

  const bucketsUsed = totalBuckets(after) - totalBuckets(before);
  const bzzSpent = totalBzz(before) - totalBzz(after);
  const bucketsPerMinute = minutes > 0 ? bucketsUsed / minutes : 0;
  const bzzPerMinute = minutes > 0 ? bzzSpent / minutes : 0;

  for (const node of after.nodes) {
    if (node.postageUtilization >= node.postageCapacity * POSTAGE_WARN_SHARE) {
      warnings.push(
        `${node.rung} postage batch ${node.batchId.slice(0, 8)} is at ` +
          `${node.postageUtilization}/${node.postageCapacity} buckets. ${
            node.postageImmutable
              ? 'It is immutable, so filling it refuses uploads rather than evicting.'
              : 'It is mutable, so filling it evicts silently.'
          }`,
      );
    }
    if (node.postageTtlDays < POSTAGE_WARN_TTL_DAYS) {
      warnings.push(`${node.rung} postage batch expires in ${node.postageTtlDays.toFixed(1)} days`);
    }
    if (node.bzz < CHEQUEBOOK_WARN_BZZ) {
      warnings.push(
        `the ${node.rung} chequebook is down to ${node.bzz.toFixed(3)} BZZ. It is restored only by a ` +
          'deposit, never by peers cashing.',
      );
    }
  }

  return {
    before,
    after,
    minutes,
    bucketsUsed,
    bzzSpent,
    bucketsPerMinute,
    bzzPerMinute,
    bzzPerMegabyte:
      segmentBytesDelivered !== undefined && segmentBytesDelivered > 0
        ? bzzSpent / (segmentBytesDelivered / BYTES_PER_MEGABYTE)
        : null,
    minutesOfPostageLeft: soonestRunway(perNode.map((node) => node.minutesOfPostageLeft)),
    minutesOfBzzLeft: soonestRunway(perNode.map((node) => node.minutesOfBzzLeft)),
    perNode,
    warnings,
  };
}

/** The cost section a run's report ends with, so nothing has to be reconstructed by hand later. */
export function costSection(cost: ResourceCost): string[] {
  const runway = (value: number | null): string =>
    value === null ? 'not measurable from this run' : `${Math.round(value)} broadcast-minutes`;

  return [
    '## What this run consumed',
    '',
    `Read off the deployment either side of the run rather than estimated, over ${cost.minutes.toFixed(1)} minutes.`,
    '',
    '| node | postage, fullest bucket | per min | chequebook BZZ | per min | postage runway |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    // A row per node, because on a split ladder the rungs drain at rates that differ by about seven
    // times and a single row would hide which one is the constraint.
    ...cost.perNode.map(
      (node) =>
        `| ${node.rung} :${node.port} | ${node.before.postageUtilization}/${node.before.postageCapacity} → ` +
        `${node.after.postageUtilization}/${node.after.postageCapacity} | ${node.bucketsPerMinute.toFixed(2)} | ` +
        `${node.before.bzz.toFixed(3)} → ${node.after.bzz.toFixed(3)} | ${node.bzzPerMinute.toFixed(4)} | ` +
        `${runway(node.minutesOfPostageLeft)} |`,
    ),
    ...(cost.perNode.length > 1
      ? [
          `| **whole stage** | ${cost.bucketsUsed} buckets used | ${cost.bucketsPerMinute.toFixed(2)} | ` +
            `${cost.bzzSpent.toFixed(3)} spent | ${cost.bzzPerMinute.toFixed(4)} | ` +
            `${runway(cost.minutesOfPostageLeft)} |`,
        ]
      : []),
    '',
    `At this run's own rate: **${runway(cost.minutesOfPostageLeft)} of postage**, ` +
      `**${runway(cost.minutesOfBzzLeft)} of BZZ**, and the first batch expires in ` +
      `${soonestExpiryDays(cost.after).toFixed(1)} days.`,
    '',
    ...(cost.perNode.length > 1
      ? [
          "⚠️ Both runways are the **shortest** any one node reported, never the stage's total. The " +
            'stage stops when the first rung fills or runs dry, and across the ladder 1080p burns ' +
            'roughly seven times the bytes of 360p.',
          '',
        ]
      : []),
    ...(cost.bzzPerMegabyte === null
      ? []
      : [
          `**${cost.bzzPerMegabyte.toFixed(5)} BZZ per megabyte delivered.** Carry this one to another ` +
            'bitrate, never the per-minute rate: seventeen runs at a fixed 0.25s segment measured ' +
            '0.0179 BZZ/min at 720p against 0.0389 at 1080p, and sat inside 0.00081 to 0.00096 per ' +
            'megabyte across that same 2.5x spread. It does **not** carry across segment lengths, ' +
            'where a controlled comparison put the gap at 23.5%.',
          '',
        ]),
    'The postage runway is a **floor**. `utilization` is the fullest of sixty-five thousand buckets, and ' +
      'a maximum grows fastest while the batch is nearly empty and then flattens, so an early run ' +
      'overstates the long-run rate. **Two runs at different fullness are not comparable at all**, which ' +
      'is what retracted the postage half of the 2026-08-07 segment-length comparison. Later runs on ' +
      'the same batch, at similar fullness, are the ones to believe.',
    '',
    ...(cost.warnings.length > 0
      ? ['⚠️ **Before planning the next run:**', '', ...cost.warnings.map((w) => `- ${w}`), '']
      : []),
  ];
}
