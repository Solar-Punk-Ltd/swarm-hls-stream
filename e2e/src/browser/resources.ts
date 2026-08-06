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
 */

import { type E2EConfig } from '../config.js';
import { chequebookBalance, discoverStamp, type Host } from '../harness/host.js';

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

export interface ResourceReading {
  atMs: number;
  batchId: string;
  /** The fullest bucket, which is the number the batch enforces. */
  postageUtilization: number;
  /** What that bucket has to reach for the batch to be full: `2 ^ (depth - bucketDepth)`. */
  postageCapacity: number;
  postageTtlDays: number;
  postageImmutable: boolean;
  uploaderBzz: number;
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
  /** Broadcast minutes left before the batch refuses uploads, at this run's own rate. */
  minutesOfPostageLeft: number | null;
  /** Broadcast minutes left before the uploader's chequebook is empty, at this run's own rate. */
  minutesOfBzzLeft: number | null;
  /** Anything that should stop the next run being planned as though nothing had changed. */
  warnings: string[];
}

export async function readResources(host: Host, cfg: E2EConfig): Promise<ResourceReading> {
  const [stamp, cheque] = await Promise.all([discoverStamp(host, cfg), chequebookBalance(host, cfg)]);

  return {
    atMs: Date.now(),
    batchId: stamp.batchID,
    postageUtilization: stamp.utilization,
    postageCapacity: 2 ** (stamp.depth - stamp.bucketDepth),
    postageTtlDays: stamp.batchTTL / 86_400,
    postageImmutable: stamp.immutableFlag,
    uploaderBzz: Number(cheque.availableBalance) / PLUR_PER_BZZ,
  };
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

export function judgeCost(before: ResourceReading, after: ResourceReading): ResourceCost {
  const minutes = (after.atMs - before.atMs) / 60_000;
  const bucketsUsed = after.postageUtilization - before.postageUtilization;
  const bzzSpent = before.uploaderBzz - after.uploaderBzz;
  const bucketsPerMinute = minutes > 0 ? bucketsUsed / minutes : 0;
  const bzzPerMinute = minutes > 0 ? bzzSpent / minutes : 0;

  const bucketsLeft = after.postageCapacity - after.postageUtilization;
  const warnings: string[] = [];

  if (after.postageUtilization >= after.postageCapacity * POSTAGE_WARN_SHARE) {
    warnings.push(
      `postage batch ${after.batchId.slice(0, 8)} is at ${after.postageUtilization}/${after.postageCapacity} ` +
        `buckets. ${
          after.postageImmutable
            ? 'It is immutable, so filling it refuses uploads rather than evicting.'
            : 'It is mutable, so filling it evicts silently.'
        }`,
    );
  }
  if (after.postageTtlDays < POSTAGE_WARN_TTL_DAYS) {
    warnings.push(`postage batch expires in ${after.postageTtlDays.toFixed(1)} days`);
  }
  if (after.uploaderBzz < CHEQUEBOOK_WARN_BZZ) {
    warnings.push(
      `the uploader chequebook is down to ${after.uploaderBzz.toFixed(3)} BZZ. It is restored only by a ` +
        'deposit, never by peers cashing.',
    );
  }

  return {
    before,
    after,
    minutes,
    bucketsUsed,
    bzzSpent,
    bucketsPerMinute,
    bzzPerMinute,
    minutesOfPostageLeft: runwayAt(bucketsLeft, bucketsPerMinute),
    minutesOfBzzLeft: runwayAt(after.uploaderBzz, bzzPerMinute),
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
    '| | before | after | per broadcast-minute |',
    '| --- | ---: | ---: | ---: |',
    `| postage, fullest bucket | ${cost.before.postageUtilization}/${cost.before.postageCapacity} | ` +
      `${cost.after.postageUtilization}/${cost.after.postageCapacity} | ${cost.bucketsPerMinute.toFixed(2)} |`,
    `| uploader chequebook, BZZ | ${cost.before.uploaderBzz.toFixed(3)} | ${cost.after.uploaderBzz.toFixed(3)} | ` +
      `${cost.bzzPerMinute.toFixed(4)} |`,
    '',
    `At this run's own rate: **${runway(cost.minutesOfPostageLeft)} of postage**, ` +
      `**${runway(cost.minutesOfBzzLeft)} of BZZ**, and the batch expires in ` +
      `${cost.after.postageTtlDays.toFixed(1)} days.`,
    '',
    ...(cost.warnings.length > 0
      ? ['⚠️ **Before planning the next run:**', '', ...cost.warnings.map((w) => `- ${w}`), '']
      : []),
  ];
}
