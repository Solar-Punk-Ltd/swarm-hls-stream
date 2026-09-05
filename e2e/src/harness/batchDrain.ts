/**
 * One rung's postage batch runs dry, and everything a suite has to establish before it may say so.
 *
 * ## What a batch drain is, in one sentence
 *
 * Every rung of the ABR ladder uploads through its own Bee node with its own prepaid postage batch,
 * so an operator can put a deliberately tiny batch behind ONE rung, let a broadcast fill it in about
 * twenty seconds, and watch that rung go quiet while the other three carry on publishing.
 *
 * ## ⛔⛔ The stage is armed from outside, and a suite can only read it
 *
 * Which batch a rung spends is read once at process start out of `BEE_PUBLISHERS`, so changing it
 * means rewriting the profile's env file and redeploying the uploader.
 * `deploy/scripts/drain-stage.sh arm` does that and `restore` puts the original back. Nothing here
 * calls either, and nothing here buys a batch.
 *
 * What that leaves is a reading, and it has to be a refusing one. An unarmed stage does not fail the
 * drain suites: it makes them wait out their whole ceiling for a refusal that was never going to
 * come and then report the uploader for a batch nobody drained. Every minute of that is a paid
 * broadcast.
 *
 * ⛔ The second case is why utilization is judged here and displayed everywhere else. A depth 17
 * batch is spent after one run and stays on the node as a dead entry, still listed and still usable
 * while it has TTL. Armed onto it a second time, the rung refuses its FIRST upload, so the refusal
 * line arrives before all four rungs have published and the suite reads a ladder that never had four
 * rungs as one that lost a rung. `stageStamps.ts` deliberately does not judge fill, because
 * `deploy/scripts/stamp-guard.sh` and the uploader's own `PostageGate` own that stop line for an
 * ordinary batch. This is a different question about a different batch: not "is there headroom" but
 * "has this drain batch been used already".
 *
 * ## ⛔ Why the target is never the coordinator
 *
 * 360p is the lowest rung and the pool's coordinator, so the catalog, every ladder master and the
 * end-of-broadcast recording announce all go out through ITS batch. That batch running dry takes the
 * master rewrite down for all four rungs at once, which is the one case the dead-rung rule does not
 * handle and which nothing in this repo implements a failover for. Decision 2 of
 * `docs/e2e-batch-drain-plan.md` files it as a known product gap, to be priced separately.
 *
 * ## ⛔⛔⛔ A batch that runs out RAMPS, it does not stop
 *
 * Measured on the first live drain, 2026-09-04: bee refused the 1080p rung's fresh depth 17 batch
 * four times in about fifty seconds, with segments landing in between. A chunk is refused only when
 * the bucket its own address falls in is full, and a depth 17 batch has 65536 buckets of two slots,
 * so at the first overflow around a thousandth of them are full and a segment of about 300 chunks
 * gets through most of the time. By 6000 chunks roughly seven segments in ten are refused, and by
 * 10000 almost all of them. So the rung degrades over a minute or two before it is silent, every
 * refused segment costs a dropped segment and a discontinuity exactly as it always did, and the
 * master cannot drop the rung until the ramp has actually finished, because each segment that gets
 * through resets that rung's lag to zero. Anything here that expected a cliff was wrong about the
 * shape rather than about the product.
 *
 * Every verdict below is pure, so `test/batchDrain.test.ts` covers it under `pnpm verify`, which
 * nothing under `suites/` is. {@link readArmedStage} and {@link waitForSurvivingMaster} are the only
 * wiring, and both are wiring.
 */

import { rungBatchRefusedPattern, segmentUploadedPattern, segmentUploadFailedPattern } from '@swarm-hls-stream/shared';

import type { E2EConfig } from '../config.js';
import type { ViewerExpectation } from '../viewerCoverage.js';

import {
  batchIdPrefix,
  type ConfiguredBatchState,
  type Host,
  pollConfiguredStamp,
  STAMP_READY_TIMEOUT_MS,
  type UploaderHealth,
  uploaderHealth,
} from './host.js';
import type { TimestampedMessage, UploaderEvents } from './logwatch.js';
import { describeMaster, masterRungRefusal, masterRungsOf, NOTHING_EXPECTED, readLadderMaster } from './masterShape.js';
import { BEE_SERVICE_BY_RUNG, COORDINATOR_RUNG, nodesBehind } from './publishers.js';
import { waitFor } from './wait.js';

/**
 * Where a run says which rung to drain.
 *
 * Not exported: every caller goes through {@link drainRung}, and a name nothing imports is a promise
 * to nobody. The same reason `BatchRefusal` is unexported in `logwatch.ts`.
 */
const DRAIN_RUNG_VAR = 'E2E_DRAIN_RUNG';

/**
 * The rung a drain aims at when a run names none.
 *
 * The tallest, which is the isolated case and the one the dead-rung rule was designed around. It is
 * also the fastest to fill: at about 5000 kbps it puts roughly 12 MB through its batch in twenty
 * seconds, where 480p would take minutes of broadcast to reach the same place.
 */
export const DEFAULT_DRAIN_RUNG = '1080p';

/**
 * The depth of the batch a drain fills, which is the smallest bee will create.
 *
 * Two stamp slots per bucket across 65536 buckets, so bee stops accepting chunks once any bucket
 * gets a third, which happens after roughly 3000 chunks. That is the only size a broadcast can fill,
 * and it is why the whole test is possible: expiry cannot be a lever, because bee refuses to create
 * a batch that would live under 24 hours. See `docs/e2e-batch-drain-plan.md`.
 */
export const DRAIN_BATCH_DEPTH = 17;

/**
 * The two halves of the per-rung drop counter's name, kept apart because the uploader keeps them apart.
 *
 * `renderPrometheusMetrics` joins a module-level prefix to each family's own name at render time, so
 * the exposed string exists in no source file on either side. Mirroring the halves is what lets
 * `test/batchDrainMirrors.test.ts` hold the joined name against what the uploader actually renders.
 *
 * ⚠️ The prefix is exported because the metrics tests compose sibling family names with it. The
 * family half is not: {@link DROPPED_SEGMENTS_METRIC} is the whole of what anything outside this file
 * has ever wanted, and the mirror test asserts on rendered exposition rather than on either half.
 */
export const METRICS_PREFIX = 'swarm_hls';
const DROPPED_SEGMENTS_FAMILY = 'rung_segments_dropped_total';

/**
 * The label dimension the per-rung families carry, which is the third half of the same name.
 *
 * ⛔ Read by name rather than taken as whichever label a sample ends with. A second label on this
 * family would key the counter map by that one instead, and the suite would then refuse with "the
 * rung whose batch was drained is not the rung that lost segments" after a paid drain, which names
 * the product for a label somebody added. `rungCountersOf` anchors on this and
 * `test/batchDrainMirrors.test.ts` holds it against what the uploader actually renders.
 */
export const RUNG_LABEL = 'rung';

/** The per-rung counter a drained rung's losses show up under. See `utils/metricsFormat.ts`. */
export const DROPPED_SEGMENTS_METRIC = `${METRICS_PREFIX}_${DROPPED_SEGMENTS_FAMILY}`;

/**
 * The `/health` reason a dropped segment puts on the uploader.
 *
 * ⚠️ Mirrors `HEALTH_REASON_SEGMENT_UPLOAD_FAILURE` in `packages/stream-uploader/src/types.ts`, and
 * `test/batchDrainMirrors.test.ts` refuses the two drifting apart. e2e must not reach past a package
 * boundary into another package's internals, so this is the same mirror-and-prove arrangement
 * `rungDeathAgreement.test.ts` uses for the two rung-death limits.
 */
export const HEALTH_REASON_SEGMENT_UPLOAD_FAILURE = 'segment_upload_failure';

/** The status an uploader reports once something is wrong with it. Mirrors `HEALTH_DEGRADED`, proven by the same test. */
export const HEALTH_STATUS_DEGRADED = 'degraded';

/** Where an operator arms and restores the stage. Named in every refusal, because a refusal that stops at "the batch is wrong" leaves the reader to find that out for themselves. */
const ARM_COMMAND = 'deploy/scripts/drain-stage.sh arm --rung=<rung> --batch=<64hex>';

/** Every refusal here stops the run before a broadcast starts, and says so, because that is the point. */
const NOTHING_SPENT = 'Nothing has been published and nothing on the deployment was touched.';

/**
 * Why this rung must not be the one a drain aims at, or null.
 *
 * Two refusals and they are different in kind. The coordinator is about the PRODUCT: its batch also
 * writes the catalog and every master, so draining it measures a gap the plan has already recorded
 * rather than the feature these suites are about. An unknown rung is about the RUN: a rung with no
 * Bee node behind it has no `/stamps` to read, so there would be nothing to arm and nothing to check.
 */
export function drainRungRefusal(rung: string): string | null {
  if (rung === COORDINATOR_RUNG) {
    return (
      `${rung} is the ladder's coordinator, so its postage batch is also what writes the stream ` +
      'catalog, every master playlist and the recording announce at the end of a broadcast. Draining ' +
      'it stops the master being rewritten for all four rungs at once rather than costing one ' +
      'quality, and no failover for that exists in this repo. It is filed as a known product gap in ' +
      `docs/e2e-batch-drain-plan.md. Point ${DRAIN_RUNG_VAR} at a rung that is not the coordinator, ` +
      `${DEFAULT_DRAIN_RUNG} by default.`
    );
  }

  const known = Object.keys(BEE_SERVICE_BY_RUNG);
  if (!known.includes(rung)) {
    return (
      `'${rung}' has no Bee node in this harness's topology, so there is no node whose postage could ` +
      `be read and nothing an arming could be checked against. ${DRAIN_RUNG_VAR} takes one of ` +
      `${known.join(', ')}, which is BEE_SERVICE_BY_RUNG in harness/publishers.ts and mirrors ` +
      'RUNG_PORT_VARS in deploy/scripts/bee-publishers.sh.'
    );
  }

  return null;
}

/**
 * The rung this run drains, out of the environment, refusing one nobody may drain.
 *
 * Throws rather than returning the refusal, because a suite reads this at module scope and the
 * answer decides which node every later reading is about. A blank value reads as nothing named, the
 * way every other env knob in this harness treats one.
 */
export function drainRung(env: NodeJS.ProcessEnv = process.env): string {
  const named = (env[DRAIN_RUNG_VAR] ?? '').trim();
  const rung = named === '' ? DEFAULT_DRAIN_RUNG : named;

  const refusal = drainRungRefusal(rung);
  if (refusal !== null) {
    throw new Error(refusal);
  }
  return rung;
}

/** The environment variable a drain sitting sets to say a batch was armed for it. */
const DRAIN_DECLARATION_VAR = 'E2E_DRAIN_ARMED';

/**
 * Why this run is not a drain sitting, or `false` when it is one.
 *
 * ## ⛔⛔⛔ Without this, both drain suites join every full suite by glob
 *
 * `test:e2e` runs `suites/scenarios/*.test.ts` and `suites/viewer/*.test.ts`, and the two drain
 * suites live in exactly those directories, so being absent from that script's own list keeps them
 * out of nothing. On any ordinary stage their `before()` then refuses, because the rung is spending
 * the depth 24 batch it publishes a broadcast on rather than a fresh depth 17 one nobody minted, and
 * a full sitting that was correct in every other respect reports two failures after an hour of paid
 * broadcast. That is the owner's decision 6 of `docs/e2e-batch-drain-plan.md` read the way it was
 * meant: the ordinary full suite must never depend on a stage somebody broke on purpose.
 *
 * ⭐ A declaration rather than a reading of the stage, for two reasons. A suite decides to skip at
 * module scope where nothing may reach a host, and an arming is an operator's act, so the honest
 * question is whether this run was launched as a drain sitting at all. `e2e:batch-drain` and
 * `e2e:batch-drain-viewer` set it and nothing else does.
 */
export function drainNotDeclared(env: NodeJS.ProcessEnv = process.env): string | false {
  const declared = (env[DRAIN_DECLARATION_VAR] ?? '').trim();
  if (declared === '' || declared === '0' || declared === 'false') {
    return (
      `this run did not declare ${DRAIN_DECLARATION_VAR}, so no rung was armed to run dry and there ` +
      'is nothing here to read. A drain sitting is deploy/scripts/drain-stage.sh arm, then pnpm ' +
      'e2e:batch-drain or pnpm e2e:batch-drain-viewer, then drain-stage.sh restore.'
    );
  }
  return false;
}

/**
 * Why a declared drain sitting must not also declare itself browser-less, or null.
 *
 * ## ⛔⛔ What the pair does when nothing refuses it
 *
 * `viewerGate` turns `E2E_EXPECT_BROWSER=false` into a skip for every viewer suite, and on an
 * ordinary run that is exactly right: a browser-less sitting is a legitimate thing to run and says
 * so once. On an armed stage it is not. `pnpm e2e:batch-drain-viewer` would then skip the only file
 * it runs and exit 0, having opened no player against a rung an operator armed to run dry and paid
 * to arm, and a skipped suite reports as zero tests rather than as skipped ones. The run summary of
 * a sitting that watched nothing is character-for-character the summary of one that watched.
 *
 * ⭐ The arming is what makes the pair a contradiction, so this answers null on every run that
 * declared no drain. {@link drainNotDeclared} is what keeps those out, and a refusal here would put
 * the two drain suites back into every full suite as failures, which is the defect it exists for.
 */
export function drainWithoutBrowserRefusal(
  expectation: ViewerExpectation,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (drainNotDeclared(env) !== false || expectation !== 'none') {
    return null;
  }

  return (
    `${DRAIN_DECLARATION_VAR} says this run is a drain sitting, so a rung has been armed to run its ` +
    'postage dry on the stage, and E2E_EXPECT_BROWSER=false says no player will watch it. Both ' +
    'cannot hold. V11 is the viewer half of the drain and has nothing left to read without a ' +
    'browser, so it would skip, report zero tests and exit 0 on a stage somebody broke on purpose. ' +
    'Set E2E_EXPECT_BROWSER=true and BROWSER_FETCH_BACKEND for this run, or run pnpm e2e:batch-drain ' +
    'instead, which is the uploader-side half and needs no browser.'
  );
}

/** What one rung's Bee node answered about the batch it is configured to spend. */
export interface ArmedStageReading {
  readonly rung: string;
  /** The port on the deployment host that reaches that rung's Bee API. */
  readonly port: number;
  /**
   * The batch `BEE_PUBLISHERS` routes this rung to, as the uploader's own `/health` reports it.
   *
   * ⚠️ Truncated to eight characters, because `/health` truncates it: a batch id is the whole of what
   * authorises spending on a rung and a refusal outlives the run in a scrollback.
   */
  readonly batch: string;
  readonly state: ConfiguredBatchState;
  /** That batch's depth, or null where the node did not list it. */
  readonly depth: number | null;
  /**
   * Chunks stamped on that batch's fullest bucket, as bee counts them, or null where unlisted.
   *
   * ⛔ The raw count and not a percentage. Zero is the only value that means "nothing has been
   * stamped on this batch yet", and on a two-chunk bucket a percentage rounds one chunk to 50 and
   * hides the difference between a fresh batch and a spent one behind arithmetic.
   */
  readonly utilization: number | null;
  readonly ttlS: number | null;
  /** What the node said instead of offering that batch, usable. Null once it offered one. */
  readonly problem: string | null;
}

/**
 * Why this stage is not one a drain suite may run against, or null.
 *
 * ⛔ The order is the order in which the answers become readable. A node that does not hold the
 * configured batch has no depth and no fill to judge, so the later refusals would be about a batch
 * nobody has.
 *
 * ⛔⛔ A reading that failed and a batch that is wrong get different sentences, both for depth and
 * for fill. A null fill used to reach the spent-batch refusal and say "bee already counts null
 * chunk(s) on its fullest bucket, so a previous run spent it", which is the right refusal with the
 * wrong reason: it sends an operator off to buy another batch when the batch may be perfectly fresh
 * and the fill is what nobody could read.
 */
export function armedStageRefusal(reading: ArmedStageReading): string | null {
  const who = `The ${reading.rung} rung on :${reading.port}`;
  const said = reading.problem ?? 'nothing it recorded';

  if (reading.state !== 'held') {
    return (
      `${who} is not holding a batch this run could drain. It is configured with ${reading.batch} and ` +
      `the node's answer was: ${said}. A drain needs that rung pointed at a fresh depth ${DRAIN_BATCH_DEPTH} batch ` +
      `of its own, which is what \`${ARM_COMMAND}\` writes into BEE_PUBLISHERS before it redeploys ` +
      `the uploader. ${NOTHING_SPENT}`
    );
  }

  if (reading.depth === null) {
    return (
      `${who} holds configured batch ${reading.batch} and bee reported no depth for it, so whether a ` +
      'broadcast could fill it is unknown, and an unknown depth is not a small one. Arm the rung with ' +
      `\`${ARM_COMMAND}\` and run again. ${NOTHING_SPENT}`
    );
  }

  if (reading.depth !== DRAIN_BATCH_DEPTH) {
    return (
      `${who} is configured with batch ${reading.batch}, which is depth ${reading.depth}, so this ` +
      'stage was never armed. A drain fills the batch a rung is actually spending, and only the ' +
      `smallest batch bee will create, depth ${DRAIN_BATCH_DEPTH}, fills inside a broadcast. Depth ` +
      `${reading.depth} would take days of publishing. Arm the rung with \`${ARM_COMMAND}\`, which ` +
      `writes a fresh depth ${DRAIN_BATCH_DEPTH} batch into BEE_PUBLISHERS and redeploys the ` +
      `uploader. ${NOTHING_SPENT}`
    );
  }

  if (reading.utilization === null) {
    return (
      `${who} is configured with depth ${DRAIN_BATCH_DEPTH} batch ${reading.batch} and bee reported ` +
      'no fill for it, so whether a previous run already spent it cannot be told. That is the one ' +
      'thing a drain has to know before it starts: a batch with chunks already on it refuses the ' +
      "rung's first upload, and the suite then reads a ladder that never had four rungs as one that " +
      'lost a rung. An unread fill is not an empty one, and this is a reading that failed rather ' +
      `than a batch to replace: read \`/stamps\` on :${reading.port} and run again once the node ` +
      `answers a utilization for ${reading.batch}. ${NOTHING_SPENT}`
    );
  }

  if (reading.utilization !== 0) {
    return (
      `${who} is configured with depth ${DRAIN_BATCH_DEPTH} batch ${reading.batch} and bee already ` +
      `counts ${reading.utilization} chunk(s) on its fullest bucket, so a previous run spent it. Its ` +
      'very first upload would be refused, before all four rungs have published, and this suite would ' +
      'then read a ladder that never had four rungs as one that lost a rung. Restore and arm again ' +
      'with a fresh batch: deploy/scripts/drain-stage.sh restore, then print-buy for the command that ' +
      `buys another, then arm. ${NOTHING_SPENT}`
    );
  }

  return null;
}

/**
 * Read the batch one rung is configured to spend, so {@link armedStageRefusal} can judge it.
 *
 * ⛔ The CONFIGURED batch and never the node's best one, for the reason `readConfiguredBatch` records
 * at length: a node holding a fresh batch beside the drained one it is actually using reads as
 * healthy and then refuses every upload the rung makes. Here the sign is inverted and the trap is the
 * same shape, because a fresh batch found by looking for the healthiest would report an armed stage
 * that was not armed.
 *
 * Polled rather than read once, the same window `stageStamps.ts` gives every node: a bee that
 * restarted reports its batches unusable for tens of seconds while they re-sync, and an arming ends
 * in a redeploy.
 *
 * Not exported: {@link requireArmedStage} is what a suite calls, and it hands the reading back.
 */
async function readArmedStage(host: Host, cfg: E2EConfig, rung: string): Promise<ArmedStageReading> {
  const nodes = nodesBehind((await uploaderHealth(host, cfg)).publishers, cfg.ports.beeUploaderApi);
  const node = nodes.find((candidate) => candidate.rungs.includes(rung));

  if (node === undefined) {
    throw new Error(
      `no Bee node on this deployment carries the ${rung} rung on its own. The uploader routes ` +
        `${nodes.map((other) => `${other.rungs.join('+')} to ${other.url}`).join(', ')}, so there is no ` +
        'batch that belongs to this rung and this rung alone. A drain needs one node per rung, which ' +
        'is what deploy/docker-compose.host.yml runs: on an unsplit stage every rung spends the ' +
        'coordinator batch, so draining it would stop the whole ladder rather than one quality.',
    );
  }

  const { state, stamp, lastSeen } = await pollConfiguredStamp(host, node.port, node.batch);

  return {
    rung,
    port: node.port,
    batch: batchIdPrefix(node.batch),
    state,
    depth: stamp?.depth ?? null,
    utilization: stamp?.utilization ?? null,
    ttlS: stamp?.batchTTL ?? null,
    problem:
      state === 'held'
        ? null
        : `${lastSeen ?? 'said nothing about why'}, after ${STAMP_READY_TIMEOUT_MS / 1_000}s of polling`,
  };
}

/**
 * Read the stage and stop the run unless one rung is armed with a fresh drain batch.
 *
 * Hands the reading back on success, because a suite prints which batch on which node it is about to
 * fill and that is the one line tying a red to the arming that produced it.
 */
export async function requireArmedStage(host: Host, cfg: E2EConfig, rung: string): Promise<ArmedStageReading> {
  const reading = await readArmedStage(host, cfg, rung);
  const refusal = armedStageRefusal(reading);
  if (refusal !== null) {
    throw new Error(refusal);
  }
  return reading;
}

/**
 * How long a drain suite waits for the master to be down to the surviving rungs.
 *
 * ⛔⛔ Patience, never a measurement, and it is a ceiling on the RAMP rather than on the dead-rung
 * rule. That rule is not a clock: the master drops a rung once the ladder has delivered four segments
 * past that rung's last delivery, at most one rung, and the drop is triggered by the next segment
 * another rung lands. But every segment the filling batch still squeezes through resets the drained
 * rung's lag to zero, so the master cannot be down to the survivors until the ramp has finished. The
 * 2026-09-04 sitting saw a ramp of about fifty seconds, and four minutes is the same ceiling the fill
 * itself is given, so a ramp as long as the fill still fits inside it. What the ramp actually took is
 * printed as an observation.
 */
export const DEAD_RUNG_MASTER_WAIT_MS = 240_000;

/** Which ladder to read, whose rungs are expected to be left, and how to learn their feed topics. */
interface SurvivingMasterWait {
  /** The signer's address, as `discoverCatalogFeed` reads it off the catalog line. */
  owner: string;
  /** The ladder group, which is also the master feed's topic. */
  ladder: string;
  survivingRungs: readonly string[];
  /**
   * Every rung of this ladder by its raw feed topic, re-read on each poll.
   *
   * A function rather than a map, because the master is joined to rung names through the announces in
   * the uploader's log and a rung that announces late would otherwise read for ever as a stranger
   * topic on a master that is perfectly correct.
   */
  readTopics: () => Promise<ReadonlyMap<string, string>>;
}

/**
 * Wait until one ladder's master offers exactly the rungs that kept their postage, and hand it back.
 *
 * ⛔ Exactly, not "no longer the drained one". A master down to two rungs has taken a healthy quality
 * away from viewers who were watching it, which is the failure the owner's ruling of 2026-09-01
 * capped the drop at one to prevent, and a wait that only asked about the drained rung would sail
 * past it and then assert on a master read seconds later. So the wait and the assertion ask the same
 * question, {@link masterRungRefusal}, of the same body.
 *
 * Hands the body back so the caller asserts on the one it waited on rather than on a fresh read that
 * could have moved.
 *
 * ⛔⛔ A timeout says what the master last held. Four minutes of paid broadcast used to end in "the
 * master offers exactly these rungs", which names what was wanted and nothing about what was there:
 * whether the gateway answered a playlist at all, which rungs it did offer, or whether the body was
 * an error envelope. {@link describeMaster} says all three and the last complete read is kept for it.
 * The scenario suite already takes this care over its own earlier wait and this one had none.
 */
export async function waitForSurvivingMaster(
  host: Host,
  cfg: E2EConfig,
  { owner, ladder, survivingRungs, readTopics }: SurvivingMasterWait,
): Promise<string> {
  // ⛔ Before the polling and not inside it. The predicate below can never be satisfied by an empty
  // expectation, so the run would spend the whole ceiling on a paid broadcast and then time out
  // naming no rungs at all, which is a red with no cause in it.
  if (survivingRungs.length === 0) {
    throw new Error(`${NOTHING_EXPECTED} Nothing was waited for on ladder ${ladder}.`);
  }

  let master = '';
  let seen: string | null = null;

  await waitFor(
    async () => {
      const body = await readLadderMaster(host, cfg, owner, ladder);
      const read = masterRungsOf(body, await readTopics());
      // Both together, so the description is never of a body the announces were not read beside.
      master = body;
      seen = describeMaster(read, body);
      return masterRungRefusal(read, survivingRungs) === null;
    },
    {
      timeoutMs: DEAD_RUNG_MASTER_WAIT_MS,
      intervalMs: 3_000,
      label:
        `the master of ladder ${ladder} offers exactly ${survivingRungs.join(', ')}, the rungs that ` +
        'kept their postage. A filling batch still lands a segment now and then, and every one of ' +
        "those resets the drained rung's lag, so this waits out the ramp as well as the four " +
        'segments of ladder progress the dead-rung rule needs and the feed write becoming readable',
    },
  ).catch((error: Error) => {
    throw new Error(`${error.message}\n  what the master last held: ${seen ?? NOTHING_READ}`, { cause: error });
  });

  return master;
}

/** What a timeout can say when no poll ever got a body and this ladder's announces together. */
const NOTHING_READ =
  "nothing was read. No poll got both a body off the feed and this broadcast's own rung announces, " +
  'so the master itself may be perfectly correct and the reading of it is what failed';

/** How long one bucket of the ramp covers. Ten seconds, so a fifty second ramp reads as five rows. */
const RAMP_BUCKET_MS = 10_000;

/**
 * When bee first refused THIS stream's batch, on the uploader host's own clock, or null.
 *
 * ⛔ Scoped to the stream rather than taken off the first refusal line in the window. Every duration
 * a drain suite prints is measured from this instant, and on this shared host a co-tenant's own
 * drained rung refused a minute earlier would put a stranger's clock under all of them.
 */
export function firstRefusalAtMs(stamped: readonly TimestampedMessage[], streamId: string): number | null {
  const pattern = rungBatchRefusedPattern();
  for (const line of stamped) {
    if (pattern.exec(line.message)?.[2] === streamId) {
      return line.atMs;
    }
  }
  return null;
}

/**
 * One bucket of the ramp: what the drained rung landed and what it lost in those ten seconds.
 *
 * Not exported, the same as `BatchRefusal` in `logwatch.ts`: a caller takes it from
 * {@link drainRampOf}'s own return type, and a name nothing imports is a promise to nobody.
 */
interface RampBucket {
  /** Seconds after the first refusal this bucket starts at. */
  readonly fromS: number;
  readonly landed: number;
  readonly dropped: number;
}

/** What a filling batch did to one rung after it first refused it. Observation only, nothing asserts on it. */
interface DrainRamp {
  /** Contiguous buckets from the first refusal to the last bucket that saw anything at all. */
  readonly buckets: readonly RampBucket[];
  /** Seconds from the first refusal to the last segment of that stream that landed, or null if none did. */
  readonly lastLandedAfterS: number | null;
}

/**
 * The ramp of one filling batch, out of the uploader's own log.
 *
 * ⛔⛔⛔ The reading the model was wrong about, so it is measured on every run. Until the 2026-09-04
 * sitting the story was "a batch runs dry and the rung falls silent", and what bee actually does is
 * refuse a growing share of segments while accepting the rest, because a chunk is refused only when
 * its own bucket is full. So the shape worth filing is not when the rung died but how it declined:
 * how many segments landed and how many were lost in each ten seconds after the first refusal.
 *
 * ⛔ Never asserted, per the owner ruling of 2026-08-29. It is printed under a heading that says so
 * and filed with the artifact.
 *
 * @param firstRefusalAtMs when bee first refused this stream, on the uploader host's own clock
 */
export function drainRampOf(
  stamped: readonly TimestampedMessage[],
  streamId: string,
  firstRefusalAtMs: number,
): DrainRamp {
  const landed = segmentUploadedPattern();
  const dropped = segmentUploadFailedPattern();
  const buckets = new Map<number, { landed: number; dropped: number }>();
  let lastLandedAtMs: number | null = null;

  for (const line of stamped) {
    if (line.atMs < firstRefusalAtMs) {
      continue;
    }
    const isLanded = landed.exec(line.message)?.[2] === streamId;
    const isDropped = !isLanded && dropped.exec(line.message)?.[2] === streamId;
    if (!isLanded && !isDropped) {
      continue;
    }

    const bucket = Math.floor((line.atMs - firstRefusalAtMs) / RAMP_BUCKET_MS);
    const counted = buckets.get(bucket) ?? { landed: 0, dropped: 0 };
    buckets.set(bucket, {
      landed: counted.landed + (isLanded ? 1 : 0),
      dropped: counted.dropped + (isDropped ? 1 : 0),
    });
    if (isLanded) {
      lastLandedAtMs = line.atMs;
    }
  }

  const last = Math.max(...buckets.keys(), -1);
  const rows: RampBucket[] = [];
  // Every bucket up to the last that saw anything, so a stretch where the rung did nothing at all
  // reads as a row of zeros rather than as a missing row.
  for (let bucket = 0; bucket <= last; bucket++) {
    const counted = buckets.get(bucket) ?? { landed: 0, dropped: 0 };
    rows.push({ fromS: (bucket * RAMP_BUCKET_MS) / 1_000, landed: counted.landed, dropped: counted.dropped });
  }

  return {
    buckets: rows,
    lastLandedAfterS: lastLandedAtMs === null ? null : (lastLandedAtMs - firstRefusalAtMs) / 1_000,
  };
}

/** The ramp as one line for a person, which is what a suite prints under its observations heading. */
export function describeDrainRamp({ buckets, lastLandedAfterS }: DrainRamp): string {
  if (buckets.length === 0) {
    return 'the drained rung neither landed nor lost a segment after the first refusal';
  }

  const rows = buckets
    .map(
      (bucket) =>
        `${bucket.fromS.toFixed(0)}-${(bucket.fromS + RAMP_BUCKET_MS / 1_000).toFixed(0)}s ` +
        `${bucket.landed} landed, ${bucket.dropped} dropped`,
    )
    .join(' | ');
  const tail =
    lastLandedAfterS === null
      ? 'nothing of that stream landed after the first refusal'
      : `its last segment landed ${lastLandedAfterS.toFixed(1)}s after the first refusal`;

  return `${rows}. ${tail}`;
}

/**
 * Every status bee answered one stream with more than once, which is the count that means a second
 * process rather than a second condition.
 */
function statusesRefusedTwice(refusals: UploaderEvents['batchRefusals']): number[] {
  const seen = new Map<number, number>();
  for (const refusal of refusals) {
    seen.set(refusal.status, (seen.get(refusal.status) ?? 0) + 1);
  }
  return [...seen].filter(([, times]) => times > 1).map(([status]) => status);
}

/** Which stream is expected to be refused, and which are expected to publish through it untouched. */
interface RefusalExpectation {
  /** The uploader's stream id for the drained rung, out of its own rung announce. */
  drainedStreamId: string;
  survivingStreamIds: readonly string[];
}

/**
 * Every refusal read, quoted as bee answered it, for a reader who no longer has the log.
 *
 * ⛔⛔ Written out in full in every refusal below rather than counted. The 2026-09-04 sitting lost
 * the uploader's container log to the restore that followed it, and the counts it had reported said
 * nothing about which batch on which stream bee had refused or what bee said, which is the one thing
 * this whole feature was built to record. A refusal that only counts spends another sitting.
 *
 * ⚠️ Joined in words, because each entry already ends in bee's own message and one answer would
 * otherwise run into the next as a single clause. This is prose an operator reads, and prose here
 * carries no semicolons.
 */
function quoteRefusals(refusals: UploaderEvents['batchRefusals']): string {
  if (refusals.length === 0) {
    return 'no refusal line at all';
  }
  return refusals
    .map(
      (refusal) => `${refusal.streamId} on batch ${refusal.batch}, bee answered ${refusal.status} ${refusal.message}`,
    )
    .join(', then ');
}

/**
 * Why the refusal lines in this log are not one rung's batch running out, or null.
 *
 * ⛔ Four different wrongnesses, kept apart because they have four different causes. Nothing refused
 * at all is an unarmed stage or a broadcast too short to fill the batch. The SAME answer from bee
 * twice is a second uploader process in the window, since the line is written once per non-retryable
 * status per stream per process and a segment that lands does not re-arm it. A refusal on a surviving
 * rung is the split failing to isolate anything, which is the whole feature. A refusal on a stream
 * this run never accounted for is a co-tenant's broadcast in the window, and reporting it as one of
 * the three above would name the wrong cause.
 *
 * ⛔⛔ Grouped by status, never counted. One drained rung writes one line per DISTINCT answer bee
 * gives it: `StreamUploader.batchRefusalStatuses` is a set of statuses rather than a flag, for the
 * reason it records, that one flag let an early unrelated rejection claim the report and silence the
 * real postage refusal. So a ramp where bee answers most refused segments one way and one oversized
 * segment another is one process writing two lines, and a reader counting lines would send its
 * operator after a redeploy that never happened, after a paid broadcast.
 *
 * ⛔ Each of the four quotes the entries themselves, stream, batch, status and bee's own words. See
 * {@link quoteRefusals}.
 */
export function singleRefusalRefusal(
  refusals: UploaderEvents['batchRefusals'],
  { drainedStreamId, survivingStreamIds }: RefusalExpectation,
): string | null {
  const drained = refusals.filter((refusal) => refusal.streamId === drainedStreamId);

  if (drained.length === 0) {
    return (
      `nothing in this window says bee refused a batch on ${drainedStreamId}, which is the drained ` +
      `rung's stream. What was read instead: ${quoteRefusals(refusals)}. Either the stage was never ` +
      'armed, or the broadcast did not run long enough to fill the batch, or the deployed uploader ' +
      'cannot write the line at all, which the preflight log-shape gate answers.'
    );
  }

  const repeated = statusesRefusedTwice(drained);
  if (repeated.length > 0) {
    return (
      `bee answered ${drainedStreamId} with ${repeated.join(', ')} more than once in this window, and ` +
      'the line is written once per answer for the life of an uploader process: a segment landing in ' +
      'between is the ramp of a filling batch and does not re-arm it. So this window holds two ' +
      'uploader processes or two sessions of that stream, which is a redeploy mid-run or an engine ' +
      `reconnect that built a fresh uploader for the same id. Refused: ${quoteRefusals(drained)}.`
    );
  }

  const survivors = refusals.filter((refusal) => survivingStreamIds.includes(refusal.streamId));
  if (survivors.length > 0) {
    return (
      `bee also refused ${survivors.map((refusal) => refusal.streamId).join(', ')}, which are rungs ` +
      'nothing drained. One batch running out is supposed to cost one quality, so a refusal on a ' +
      'surviving rung means the per-rung split is not isolating the failure it exists to isolate. ' +
      `Refused: ${quoteRefusals(survivors)}. The drained rung's own: ${quoteRefusals(drained)}.`
    );
  }

  const strangers = refusals.filter(
    (refusal) => refusal.streamId !== drainedStreamId && !survivingStreamIds.includes(refusal.streamId),
  );
  if (strangers.length > 0) {
    return (
      `this window also holds a refusal on ${strangers
        .map((refusal) => refusal.streamId)
        .join(', ')}, which this run never accounted for as a rung of its own ladder. Another ` +
      'broadcast was running on this deployment, so the counts here are not all about the drain, and ' +
      `a co-tenant is not a product fault. Refused: ${quoteRefusals(strangers)}. The drained rung's ` +
      `own: ${quoteRefusals(drained)}.`
    );
  }

  return null;
}

/** What docker says about the uploader's process, which is how a suite tells a survivor from a restart. */
export interface UploaderProcess {
  /** `.State.StartedAt`, which changes when the process is replaced rather than restarted. */
  startedAt: string;
  /** `.RestartCount`, which docker increments when it restarts a container itself. */
  restartCount: number;
}

/** Both fields in one inspect, so the pair describes one instant rather than two calls apart. */
export function uploaderProcessCommand(container: string): string {
  return `docker inspect -f '{{.State.StartedAt}} {{.RestartCount}}' ${container}`;
}

/**
 * What {@link uploaderProcessCommand} answered.
 *
 * ⛔ Refuses an unreadable answer rather than defaulting either field. A zero restart count invented
 * where docker said nothing reads as a process that stayed up, which is the exact conclusion this
 * pair exists to justify.
 */
export function parseUploaderProcess(stdout: string, container: string): UploaderProcess {
  const [startedAt, restarts, ...rest] = stdout.trim().split(/\s+/);
  const restartCount = Number(restarts);

  if (startedAt === undefined || startedAt === '' || !Number.isInteger(restartCount) || rest.length > 0) {
    throw new Error(
      `docker inspect of ${container} answered "${stdout.trim()}", which is not a start instant and a ` +
        'restart count. Both are needed and neither may be assumed: a restart count invented where ' +
        'docker said nothing would read as a process that stayed up, which is what this pair is for.',
    );
  }
  return { startedAt, restartCount };
}

/** Read the uploader's process facts, so a drain can be shown to have cost a rung and not the service. */
export async function readUploaderProcess(host: Host, container: string): Promise<UploaderProcess> {
  const { stdout } = await host.run(uploaderProcessCommand(container));
  return parseUploaderProcess(stdout, container);
}

/**
 * Why the uploader did not stay up across the drain, or null.
 *
 * ⛔⛔ Two witnesses, and the run needs both. `RestartCount` catches docker restarting the container
 * and stays at zero when the container is replaced, and `StartedAt` catches the replacement. Either
 * one alone reads as a survivor for the case the other sees.
 *
 * ⛔ A restart is not merely untidy here, it hides the fault. The uploader re-reads BEE_PUBLISHERS at
 * start, so a restarted process begins the same drain again from an empty counter, and every reading
 * after it is of a second drain the suite did not observe the beginning of.
 */
export function uploaderRestartRefusal(before: UploaderProcess, after: UploaderProcess): string | null {
  if (after.restartCount !== before.restartCount) {
    return (
      `docker counted ${after.restartCount} restart(s) of the uploader against ${before.restartCount} ` +
      'before the drain. A rung losing its postage has to cost that rung and never the service: every ' +
      'other broadcast on this deployment went down with it, and the restarted process re-read ' +
      'BEE_PUBLISHERS and began the same drain over from an empty counter.'
    );
  }

  if (after.startedAt !== before.startedAt) {
    return (
      `the uploader process started at ${after.startedAt} and had started at ${before.startedAt} ` +
      'before the drain, so the container was replaced rather than restarted, which docker does not ' +
      'count. A rung losing its postage has to cost that rung and never the service.'
    );
  }

  return null;
}

/**
 * Why the uploader's own health does not report the drain, or null.
 *
 * ⛔ A healthy answer here is a wrong answer rather than a better one. The rung dropped every segment
 * it was handed, and a service calling that fine is a service whose operator has no way to find out.
 */
export function segmentUploadFailureRefusal(health: UploaderHealth): string | null {
  if (health.status !== HEALTH_STATUS_DEGRADED) {
    return (
      `/health reports status "${health.status}" while one rung is dropping every segment it is ` +
      `handed. It should be "${HEALTH_STATUS_DEGRADED}" with the reason ` +
      `${HEALTH_REASON_SEGMENT_UPLOAD_FAILURE}. The reasons it did give: ` +
      `${health.reasons.join(', ') || 'none at all'}.`
    );
  }

  if (!health.reasons.includes(HEALTH_REASON_SEGMENT_UPLOAD_FAILURE)) {
    return (
      `/health is degraded for ${health.reasons.join(', ') || 'no reason it named'} rather than for ` +
      `${HEALTH_REASON_SEGMENT_UPLOAD_FAILURE}. A drained batch has to reach an operator as the ` +
      'segments it lost, because every other reason is about something else to go and fix.'
    );
  }

  return null;
}

/** Which rung is expected to have lost segments, and which are expected to have lost none. */
interface DroppedExpectation {
  drainedRung: string;
  survivingRungs: readonly string[];
}

/** One rung's losses across a run: what the counter stood at either side, and what it cost. */
interface RungLosses {
  readonly before: number;
  readonly after: number;
  readonly cost: number;
}

/**
 * What one rung lost between two scrapes.
 *
 * An absent label reads as zero on either side. The counter carries a label only once that rung has
 * lost something, so absence is the shape a rung that has lost nothing has.
 */
function lossesOf(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>, rung: string): RungLosses {
  const wasAt = before.get(rung) ?? 0;
  const isAt = after.get(rung) ?? 0;
  return { before: wasAt, after: isAt, cost: isAt - wasAt };
}

/** One rung's losses as a reader needs them, which is the movement and both ends of it. */
function describeLosses(rung: string, { before, after, cost }: RungLosses): string {
  return `${rung} lost ${cost} (${before} to ${after})`;
}

/**
 * Why the per-rung drop counter does not describe one drained rung, or null.
 *
 * ⛔⛔⛔ **Two scrapes, differenced, because these are LIFETIME totals.** `uploaderMetrics.ts` says so
 * in its own header. Every fault suite in this harness drops segments on rungs scenario L treats as
 * survivors, so an earlier sitting on the same uploader process either satisfies the drained rung's
 * assertion on its own or fails a survivor that lost nothing tonight. Reading one scrape held only
 * because arming redeploys the uploader and resets every counter, which is the operator's flow rather
 * than anything this code can rely on.
 *
 * ⛔ An empty LATER reading refuses. The family is labelled the moment a rung loses anything, so no
 * labels at all on a stage whose batch was just drained means the scrape failed rather than that
 * nothing was lost, and the two must not read the same way. The earlier reading is legitimately empty
 * on an uploader that has lost nothing yet.
 *
 * ⛔ A counter that fell is named as the restart it is. These reset to zero with the process, and
 * reporting a negative movement as a rung that lost nothing would send an operator to the postage
 * side of a service that was replaced. `uploaderRestartRefusal` is the witness that proves it.
 *
 * @param before the same family scraped before the broadcast started
 * @param after the same family scraped once the drain has been read
 */
export function droppedSegmentsRefusal(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  { drainedRung, survivingRungs }: DroppedExpectation,
): string | null {
  if (after.size === 0) {
    return (
      `${DROPPED_SEGMENTS_METRIC} carries no rung label at all. The counter is labelled as soon as a ` +
      'rung loses a segment, so on a stage whose batch was just drained an empty family means the ' +
      'scrape did not answer rather than that nothing was lost. Check that /metrics was read at all: ' +
      "it is behind the uploader's API token, unlike /health."
    );
  }

  const everyRung = [drainedRung, ...survivingRungs];
  const fell = everyRung.filter((rung) => lossesOf(before, after, rung).cost < 0);
  if (fell.length > 0) {
    return (
      `${fell.map((rung) => describeLosses(rung, lossesOf(before, after, rung))).join(', ')}, and a ` +
      'counter cannot fall while one process holds it. These are lifetime totals that reset with the ' +
      'process, so the uploader was restarted or replaced mid-run and every reading after it is of a ' +
      'drain this run did not watch the beginning of.'
    );
  }

  const drained = lossesOf(before, after, drainedRung);
  if (drained.cost <= 0) {
    return (
      `${DROPPED_SEGMENTS_METRIC}{rung="${drainedRung}"} moved by ${drained.cost} across this run, ` +
      `standing at ${drained.after} where it stood at ${drained.before}, so the rung whose batch was ` +
      'drained is not the rung that lost segments. What every rung cost this run: ' +
      `${everyRung.map((rung) => describeLosses(rung, lossesOf(before, after, rung))).join(', ')}.`
    );
  }

  const bystanders = survivingRungs.filter((rung) => lossesOf(before, after, rung).cost > 0);
  if (bystanders.length > 0) {
    return (
      `${bystanders.map((rung) => describeLosses(rung, lossesOf(before, after, rung))).join(', ')}, and ` +
      'nothing drained those rungs. One batch running dry is supposed to cost one quality. ' +
      `${describeLosses(drainedRung, drained)}.`
    );
  }

  return null;
}

/** What this run cost one rung, for the observation line beside the verdict. See {@link droppedSegmentsRefusal}. */
export function droppedSegmentsCost(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  rung: string,
): number {
  return lossesOf(before, after, rung).cost;
}
