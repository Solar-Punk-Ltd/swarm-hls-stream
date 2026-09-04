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
 * Every verdict below is pure, so `test/batchDrain.test.ts` covers it under `pnpm verify`, which
 * nothing under `suites/` is. {@link readArmedStage} is the only wiring, and it is wiring.
 */

import type { E2EConfig } from '../config.js';

import {
  batchIdPrefix,
  type ConfiguredBatchState,
  type Host,
  pollConfiguredStamp,
  STAMP_READY_TIMEOUT_MS,
  type UploaderHealth,
  uploaderHealth,
} from './host.js';
import type { UploaderEvents } from './logwatch.js';
import { BEE_SERVICE_BY_RUNG, COORDINATOR_RUNG, nodesBehind } from './publishers.js';

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
 * `test/batchDrainMirrors.test.ts` hold each one against the uploader's own declaration.
 */
export const METRICS_PREFIX = 'swarm_hls';
export const DROPPED_SEGMENTS_FAMILY = 'rung_segments_dropped_total';

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

/** The one status a healthy uploader reports. Mirrors `HEALTH_OK`, proven by the same test. */
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
 * configured batch has no depth and no fill to judge, so the later two refusals would be about a
 * batch nobody has.
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

/** Which stream is expected to be refused, and which are expected to publish through it untouched. */
interface RefusalExpectation {
  /** The uploader's stream id for the drained rung, out of its own rung announce. */
  drainedStreamId: string;
  survivingStreamIds: readonly string[];
}

/**
 * Why the refusal lines in this log are not one rung's batch running dry, or null.
 *
 * ⛔ Four different wrongnesses, kept apart because they have four different causes. Nothing refused
 * at all is an unarmed stage or a broadcast too short to fill the batch. Refused twice is a rung that
 * published again in between, which on an armed stage means something replaced the batch mid-run.
 * A refusal on a surviving rung is the split failing to isolate anything, which is the whole feature.
 * A refusal on a stream this run never accounted for is a co-tenant's broadcast in the window, and
 * reporting it as one of the three above would name the wrong cause.
 */
export function singleRefusalRefusal(
  refusals: UploaderEvents['batchRefusals'],
  { drainedStreamId, survivingStreamIds }: RefusalExpectation,
): string | null {
  const drained = refusals.filter((refusal) => refusal.streamId === drainedStreamId);

  if (drained.length === 0) {
    return (
      `nothing in this window says bee refused a batch on ${drainedStreamId}, which is the drained ` +
      `rung's stream. ${refusals.length} refusal line(s) were read in total. Either the stage was ` +
      'never armed, or the broadcast did not run long enough to fill the batch, or the deployed ' +
      'uploader cannot write the line at all, which the preflight log-shape gate answers.'
    );
  }
  if (drained.length > 1) {
    return (
      `bee refused ${drainedStreamId}'s batch ${drained.length} times in one broadcast, and the line ` +
      'is written once per drain and re-armed only by a segment that lands. So the rung published ' +
      'again in between, which on an armed stage means the batch it was spending changed mid-run. ' +
      `The answers were: ${drained.map((refusal) => `${refusal.status} ${refusal.message}`).join(' then ')}.`
    );
  }

  const survivors = refusals.filter((refusal) => survivingStreamIds.includes(refusal.streamId));
  if (survivors.length > 0) {
    return (
      `bee also refused ${survivors.map((refusal) => refusal.streamId).join(', ')}, which are rungs ` +
      'nothing drained. One batch running dry is supposed to cost one quality, so a refusal on a ' +
      'surviving rung means the per-rung split is not isolating the failure it exists to isolate. ' +
      `Batches refused: ${survivors.map((refusal) => `${refusal.batch} (${refusal.status})`).join(', ')}.`
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
      'a co-tenant is not a product fault.'
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

/**
 * Why the per-rung drop counter does not describe one drained rung, or null.
 *
 * ⛔ An empty reading refuses. `swarm_hls_rung_segments_dropped_total` is labelled the moment a rung
 * loses anything, so no labels at all on a stage whose batch was just drained means the scrape
 * failed rather than that nothing was lost, and the two must not read the same way.
 *
 * ⚠️ A surviving rung with no label is a genuine zero and clears. The counter carries a label only
 * once that rung has lost something, so an absent label is the shape a rung that lost nothing has.
 */
export function droppedSegmentsRefusal(
  counted: ReadonlyMap<string, number>,
  { drainedRung, survivingRungs }: DroppedExpectation,
): string | null {
  if (counted.size === 0) {
    return (
      `${DROPPED_SEGMENTS_METRIC} carries no rung label at all. The counter is labelled as soon as a ` +
      'rung loses a segment, so on a stage whose batch was just drained an empty family means the ' +
      'scrape did not answer rather than that nothing was lost. Check that /metrics was read at all: ' +
      "it is behind the uploader's API token, unlike /health."
    );
  }

  const dropped = counted.get(drainedRung) ?? 0;
  if (dropped <= 0) {
    return (
      `${DROPPED_SEGMENTS_METRIC}{rung="${drainedRung}"} is ${dropped}, so the rung whose batch was ` +
      'drained is not the rung that lost segments. The counter read ' +
      `${[...counted].map(([rung, count]) => `${rung}=${count}`).join(', ')}.`
    );
  }

  const bystanders = survivingRungs.filter((rung) => (counted.get(rung) ?? 0) > 0);
  if (bystanders.length > 0) {
    return (
      `${bystanders.map((rung) => `${rung} lost ${counted.get(rung) ?? 0}`).join(', ')}, and nothing ` +
      `drained those rungs. One batch running dry is supposed to cost one quality. ${drainedRung} lost ` +
      `${dropped}.`
    );
  }

  return null;
}
