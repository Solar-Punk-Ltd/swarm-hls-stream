import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import {
  type ArmedStageReading,
  DEAD_RUNG_MASTER_WAIT_MS,
  describeDrainRamp,
  drainRampOf,
  drainRung,
  DROPPED_SEGMENTS_METRIC,
  droppedSegmentsRefusal,
  firstRefusalAtMs,
  readUploaderProcess,
  requireArmedStage,
  segmentUploadFailureRefusal,
  singleRefusalRefusal,
  type UploaderProcess,
  uploaderRestartRefusal,
  waitForSurvivingMaster,
} from '../../src/harness/batchDrain.js';
import { makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import {
  announcedRungs,
  isContiguous,
  ladderRungs,
  parseUploaderLog,
  segmentIndicesByStream,
  type TimestampedMessage,
  timestampedMessages,
} from '../../src/harness/logwatch.js';
import { describeMaster, masterRungRefusal, masterRungsOf } from '../../src/harness/masterShape.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { rungCountersOf, uploaderMetricsCommand } from '../../src/harness/uploaderMetrics.js';
import { discoverCatalogFeed } from '../../src/harness/viewer.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Scenario L, one rung's postage batch runs dry and the broadcast survives it.
 *
 * ## What this asks that nothing else does
 *
 * Each rung of the ladder uploads through its own Bee node with its own prepaid postage batch, and
 * the split was asked for at the start so that one batch running dry would cost one quality rather
 * than the broadcast. Every other fault suite kills a rung by stopping its node or its transcode.
 * This one leaves the node up, the encoder up, and every upload coming back refused, which is a
 * different death: nothing has crashed and there is nothing to restart.
 *
 * ## ⛔⛔ The stage is armed from outside, and this suite restores nothing
 *
 * `deploy/scripts/drain-stage.sh arm --rung=<r> --batch=<64hex>` writes a fresh depth 17 batch into
 * that rung's entry of `BEE_PUBLISHERS` and redeploys the uploader, and `restore` puts the original
 * back. Both are the operator's, and `restore` is the operator's **after** this suite has run: the
 * batch is spent by then and the rung publishes nothing until it is replaced. Nothing here calls
 * either script, and nothing here buys a batch. `requireArmedStage` in `before()` refuses a stage
 * that was not armed, and refuses a drain batch a previous run already spent.
 *
 * ## ⛔ Why the target is never the coordinator
 *
 * 360p is the lowest rung and the pool's coordinator, so its batch also writes the stream catalog,
 * every master playlist and the recording announce at the end of a broadcast. Draining it stops the
 * master being rewritten for all four rungs at once, which is the one case the dead-rung rule does
 * not handle and which nothing in this repo implements a failover for. `drainRung` refuses it by
 * name. Decision 2 of `docs/e2e-batch-drain-plan.md` files that as a known product gap.
 *
 * ## ⛔⛔⛔ A batch that runs out RAMPS, and this suite waits the ramp out
 *
 * Measured on the first live drain, 2026-09-04: bee refused this rung's fresh depth 17 batch four
 * times in about fifty seconds, with segments landing in between. A chunk is refused only when the
 * bucket its own address falls in is full, so a batch at its first overflow still takes most
 * segments and one a few thousand chunks later takes almost none. The rung therefore declines over a
 * minute or two rather than falling silent, and every segment that still gets through resets its lag
 * and so postpones the master dropping it.
 *
 * So the first refusal is the START of the fault and never the end of it. Nothing here asserts on the
 * moment the first refusal lands: the suite waits from there until the rung is dead by the product's
 * own definition, which is the master offering exactly the three survivors, and asserts then. What
 * the ramp did in between is printed as an observation.
 *
 * ## What this asserts
 *
 * That bee refused the drained rung's batch exactly once, which is once per stream per uploader
 * process, and no other rung's at all. That the three survivors published a gapless run from the
 * master rewrite onward. That the master offers exactly the three rungs that kept their postage, and
 * that the catalog said so. That the uploader process stayed up, and that it reported itself degraded
 * for the segments it lost. And that the per-rung drop counter climbed on the drained label alone.
 *
 * ## What this does not assert
 *
 * ⛔ No timing, per the owner ruling of 2026-08-29. How long the batch took to fill, what the ramp
 * landed and lost in each ten seconds after the first refusal, and how long the master took to be
 * rewritten are measured, printed under a heading saying so, and filed.
 *
 * ⛔ Nothing about a viewer. `suites/viewer/batch-drain-viewer.test.ts` opens a real player against
 * the same fault. Nothing about what happens after the restore either: this suite's own broadcast
 * ends with the batch spent, and the four rungs coming back is what `pnpm e2e:abr-ladder` reads on
 * the run after `restore`.
 *
 * ⛔ Requires a deployed profile, funded stamps and an ARMED stage, unlike every other suite here.
 * Nothing in CI runs these, and this one is deliberately absent from `test:e2e`, because the
 * ordinary full suite must never depend on a stage somebody broke on purpose. Decision 6 of the plan.
 */

/** Segments each rung must publish before the drain is expected, so a four-rung ladder is established. */
const WARMUP_SEGMENTS = 4;
/**
 * Segments each SURVIVOR must publish after the master rewrite, which is the window their run is
 * judged on.
 *
 * ⭐ Counted from the rewrite and not from the first refusal. The refusal is the start of a ramp of
 * unknown length, so a window opened there is mostly a window in which the drained rung was still
 * publishing, and the state this suite claims survives is the one after the rung is gone. Six
 * segments of it, so the contiguity below is judged on a run rather than on one segment each.
 */
const POST_DRAIN_SEGMENTS = 6;

const SEGMENT_WAIT_MS = 180_000;
/**
 * How long the drained rung is given to be refused.
 *
 * ⭐ Generous rather than tight. A depth 17 batch stops accepting chunks after roughly 3000 of them,
 * which is about twenty seconds of 1080p, and this is four minutes. The number is a ceiling on the
 * harness's patience and never a measurement: what the fill actually took is printed as an
 * observation.
 */
const DRAIN_WAIT_MS = 240_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
// Module scope, so a run aimed at the coordinator fails the file during import rather than after a
// broadcast has started. See `drainRung`.
const drainedRung = drainRung(process.env);

describe("L, one rung's postage runs dry and the other three carry the broadcast", { skip: abrOff(cfg) }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let startedAt: string;
  let armed: ArmedStageReading;
  let processBefore: UploaderProcess;

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    // ⛔ After the stamp gate and before anything is published. The stamp gate asks whether every
    // rung CAN stamp for the length of a run, which an armed rung can: its drain batch is fresh and
    // has two days of life. This asks the opposite question of one rung, and only of one.
    armed = await requireArmedStage(host, cfg, drainedRung);
    console.log(
      `  armed: ${armed.rung} on :${armed.port} spends depth ${armed.depth} batch ${armed.batch}, ` +
        `unspent, ${armed.ttlS}s of TTL`,
    );

    processBefore = await readUploaderProcess(host, uploader);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
    // ⛔ Nothing is restored here, deliberately. The drain batch is spent by now and putting the
    // original back means rewriting BEE_PUBLISHERS and redeploying the uploader, which is
    // `deploy/scripts/drain-stage.sh restore` and is the operator's step after this sitting.
  });

  it('refuses one rung, keeps three publishing, and stops offering the dead one', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

    // ⭐ A four-rung ladder first, or there is no isolation to observe. Waited on per rung rather
    // than on a merged count, because one fast rung satisfies a merged one alone.
    await waitFor(
      async () => {
        const counts = segmentIndicesByStream(await log());
        return (
          ladderRungs(await log()).length >= cfg.abrRungs.length &&
          counts.size >= cfg.abrRungs.length &&
          [...counts.values()].every((indices) => indices.length >= WARMUP_SEGMENTS)
        );
      },
      {
        timeoutMs: SEGMENT_WAIT_MS,
        intervalMs: 3_000,
        label: `warmup: all ${cfg.abrRungs.length} rungs publish ${WARMUP_SEGMENTS} segments each before the drain`,
      },
    );

    const streams = newestStreamIdByRung(await log());
    const drainedStreamId = streams.get(drainedRung);
    assert.ok(drainedStreamId, `no rung announce in this window names ${drainedRung}, so nothing was drained`);
    const survivingRungs = cfg.abrRungs.filter((rung) => rung !== drainedRung);
    const survivingStreamIds = survivingRungs.map((rung) => streams.get(rung) ?? '');
    console.log(`  drained ${drainedRung} (${drainedStreamId}), surviving ${survivingRungs.join(', ')}`);

    await waitFor(async () => refusalsFor(await log(), drainedStreamId).length > 0, {
      timeoutMs: DRAIN_WAIT_MS,
      intervalMs: 3_000,
      label:
        `bee refuses ${drainedRung}'s batch ${armed.batch} on ${drainedStreamId}. A depth ` +
        '17 batch stops accepting chunks after about 3000 of them, roughly twenty seconds of 1080p, ' +
        'so a whole ceiling spent here means the rung is not spending the batch that was armed: read ' +
        "the uploader's /health publishers, and check the arm redeployed the container",
    }).catch(async (error) => {
      throw new Error(`${(error as Error).message}\n  ${whatWasSeen(await log(), drainedStreamId)}`);
    });

    const refusal = refusalsFor(await log(), drainedStreamId)[0];
    console.log(`  bee answered ${refusal.status} ${refusal.message} for batch ${refusal.batch}`);

    // ⛔⛔ The refusal is the start of a ramp and not the end of anything, so nothing is asserted
    // here. The wait below is for the rung to be dead by the product's own definition: the master
    // offering exactly the three survivors. Its ceiling is four minutes of patience from this
    // moment, which is within one poll of the refusal itself.
    //
    // ⭐ The master read is what the assertion rests on and the catalog line below is the narration,
    // so the wait is on the master. The other order would time out on a reworded log line rather
    // than failing on one, and the line is an inline string in `StreamCatalog` rather than part of
    // the log contract in `packages/shared/src/uploaderLog.ts`.
    const ladder = ladderGroupOf(await log());
    const { owner } = await discoverCatalogFeed(host, cfg);
    const master = await waitForSurvivingMaster(host, cfg, {
      owner,
      ladder,
      survivingRungs,
      readTopics: async () => topicsOf(await log()),
    });
    const rewrittenAtIso = await host.nowIso();
    console.log(
      `  the master is down to ${survivingRungs.join(', ')}, inside the ` +
        `${DEAD_RUNG_MASTER_WAIT_MS / 1_000}s of patience this suite gives the ramp`,
    );

    // ⭐ Every survivor keeps going AFTER the rung is gone, which is the half that makes the
    // isolation worth anything. Per rung, because a merged count is satisfied by one rung running
    // ahead, and counted from the rewrite so the window judged below holds a run rather than a
    // segment each.
    const publishedAtRewrite = countsOf(await log());
    await waitFor(
      async () => {
        const counts = countsOf(await log());
        return survivingStreamIds.every(
          (streamId) => (counts.get(streamId) ?? 0) >= (publishedAtRewrite.get(streamId) ?? 0) + POST_DRAIN_SEGMENTS,
        );
      },
      {
        timeoutMs: SEGMENT_WAIT_MS,
        intervalMs: 3_000,
        label: `every surviving rung publishes ${POST_DRAIN_SEGMENTS} more segments after the master rewrite`,
      },
    );

    // One log read for every verdict below, so they all describe the same moment rather than several
    // fetches apart.
    const settled = await log();
    const sinceRewrite = await host.logsSince(uploader, rewrittenAtIso);

    // ⛔ First. It settles whether this run is one batch running out at all, and every reading below
    // it is about a fault of some other shape if it is not.
    const notOneDrain = singleRefusalRefusal(parseUploaderLog(settled).batchRefusals, {
      drainedStreamId,
      survivingStreamIds,
    });
    assert.equal(notOneDrain, null, `this run is not one rung's batch running out: ${notOneDrain}`);

    // ⭐ The assertion the per-rung split exists for. Judged per stream and never on the merge, for
    // the reason abr-ladder records: four rungs are four independent counters, and a merged
    // deduplicated view can mask a one-rung gap behind a sibling's healthy index.
    const indices = segmentIndicesByStream(sinceRewrite);
    for (const streamId of survivingStreamIds) {
      const run = indices.get(streamId) ?? [];
      assert.ok(
        run.length > 0,
        `${streamId} published nothing at all after the master lost the drained rung, so it did not survive it`,
      );
      assert.ok(
        isContiguous(run),
        `${streamId} lost a segment after the ladder was down to the rungs that kept their postage; ` +
          `got: ${run.join(',')}`,
      );
    }

    const masterRead = masterRungsOf(master, topicsOf(settled));
    console.log(`  ${describeMaster(masterRead, master)}`);
    const wrongLadder = masterRungRefusal(masterRead, survivingRungs);
    assert.equal(wrongLadder, null, `the master is not offering the rungs that survived: ${wrongLadder}`);

    // ⛔ Asserted rather than waited on, so a reworded line fails as an absent line rather than as a
    // timeout blaming the product. The master above is the witness that carries the verdict.
    const rewrite = ladderRewrittenPattern(ladder, survivingRungs.length);
    assert.match(
      settled,
      rewrite,
      `the catalog never said ladder ${ladder} now produces ${survivingRungs.length} rungs, even ` +
        'though the master it points at does. Either the entry was not repointed, which leaves a ' +
        'viewer reading the previous master, or the line moved and this pattern is stale: it is an ' +
        'inline string in StreamCatalog rather than part of the shared log contract',
    );

    // ⛔ A drained batch has to cost one rung and never the service.
    const restarted = uploaderRestartRefusal(processBefore, await readUploaderProcess(host, uploader));
    assert.equal(restarted, null, `the uploader did not survive one rung losing its postage: ${restarted}`);

    const notDegraded = segmentUploadFailureRefusal(await uploaderHealth(host, cfg));
    assert.equal(notDegraded, null, `the uploader did not report the segments it lost: ${notDegraded}`);

    const { stdout } = await host.run(uploaderMetricsCommand(uploader));
    const dropped = rungCountersOf(stdout, DROPPED_SEGMENTS_METRIC);
    const wrongRungLostThem = droppedSegmentsRefusal(dropped, { drainedRung, survivingRungs });
    assert.equal(wrongRungLostThem, null, `the drop counter does not describe one drained rung: ${wrongRungLostThem}`);

    const stamped = timestampedMessages(settled);
    const refusedAtMs = firstRefusalAtMs(stamped, drainedStreamId);
    const rewrittenAtMs = firstMatchAtMs(stamped, rewrite);
    console.log(
      '  observations, none of them asserted. the batch took ' +
        `${describeGap(Date.parse(startedAt), refusedAtMs)} of broadcast to fill, and the master was ` +
        `rewritten ${describeGap(refusedAtMs, rewrittenAtMs)} after the first refusal. ` +
        `${dropped.get(drainedRung) ?? 0} segments dropped on ${drainedRung} over the whole broadcast`,
    );
    console.log(
      `  observations, none of them asserted. the ramp of ${drainedStreamId} in ten second buckets: ` +
        `${
          refusedAtMs === null
            ? 'the first refusal carried no readable timestamp, so the ramp could not be bucketed'
            : describeDrainRamp(drainRampOf(stamped, drainedStreamId, refusedAtMs))
        }`,
    );
  });
});

/** The reason a single-rendition deployment skips, or `false` to run. */
function abrOff({ abrEnabled }: { abrEnabled: boolean }): string | false {
  return abrEnabled ? false : 'ABR_ENABLED is off on this deployment, so there is no second rung for a drain to spare';
}

/**
 * The newest announce per rung, which is the session this broadcast is publishing.
 *
 * ⛔ Newest, for the reason `rungFeedsOf` records: a session an engine restart replaced announces
 * again on a fresh topic while the retired one keeps its own, and the retired stream is mid-finalize
 * as the read happens.
 */
function newestStreamIdByRung(logText: string): ReadonlyMap<string, string> {
  const byRung = new Map<string, string>();
  for (const announce of announcedRungs(logText)) {
    byRung.set(announce.rung, announce.streamId);
  }
  return byRung;
}

/** Every rung's feed topic by rung name, which is how the master's variants are joined to rungs. */
function topicsOf(logText: string): ReadonlyMap<string, string> {
  const byTopic = new Map<string, string>();
  for (const announce of announcedRungs(logText)) {
    byTopic.set(announce.topic, announce.rung);
  }
  return byTopic;
}

/** The one ladder group this window announced, or a refusal naming what it found instead. */
function ladderGroupOf(logText: string): string {
  const groups = [...new Set(announcedRungs(logText).map((announce) => announce.ladder))];
  if (groups.length !== 1) {
    throw new Error(
      `this window announced ${groups.length} ladder group(s) (${groups.join(', ') || 'none'}), so which ` +
        "master to read cannot be decided. A drain is one broadcast's ladder, and reading another " +
        "broadcast's master would compare a stranger's rungs against this run's expectation.",
    );
  }
  return groups[0];
}

function refusalsFor(logText: string, streamId: string): UploaderEventRefusals {
  return parseUploaderLog(logText).batchRefusals.filter((refusal) => refusal.streamId === streamId);
}

type UploaderEventRefusals = ReturnType<typeof parseUploaderLog>['batchRefusals'];

/** Segment uploads per stream, which is what a post-drain window is measured against. */
function countsOf(logText: string): ReadonlyMap<string, number> {
  return new Map([...segmentIndicesByStream(logText)].map(([streamId, indices]) => [streamId, indices.length]));
}

/**
 * What the log did hold, for the one refusal that has nothing of its own to report.
 *
 * A drain that never happened leaves every other instrument looking healthy, so the timeout has to
 * say what the rungs were doing instead of only that nothing was refused.
 */
function whatWasSeen(logText: string, drainedStreamId: string): string {
  const counts = [...countsOf(logText)].map(([streamId, count]) => `${streamId}=${count}`).join(', ');
  const refusals = parseUploaderLog(logText).batchRefusals;
  const elsewhere =
    refusals.length === 0
      ? 'no batch refusal on any stream'
      : `refusals on ${refusals
          .map((refusal) => `${refusal.streamId} batch ${refusal.batch} (${refusal.status} ${refusal.message})`)
          .join(', ')}`;

  return `what was seen: segments per stream ${
    counts || 'none at all'
  }, ${elsewhere}, and nothing on ${drainedStreamId}`;
}

/**
 * The catalog's own line for a ladder whose rung set changed.
 *
 * ⚠️ A raw pattern rather than a composed one, and the only one in this suite. It is an inline
 * string in `StreamCatalog.republishMaster` rather than part of the log contract in
 * `packages/shared/src/uploaderLog.ts`, so nothing prevents it being reworded. This suite asserts on
 * it instead of waiting on it exactly for that reason, and the master playlist read beside it is the
 * witness that would still be right.
 */
function ladderRewrittenPattern(ladder: string, rungs: number): RegExp {
  const escaped = ladder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`Ladder ${escaped} now produces ${rungs} rung\\(s\\), master rewritten`);
}

/** When the first line matching `pattern` was written, on the uploader host's own clock. */
function firstMatchAtMs(stamped: readonly TimestampedMessage[], pattern: RegExp): number | null {
  return stamped.find((line) => pattern.test(line.message))?.atMs ?? null;
}

/** A duration for a person, or the plain fact that one end of it was never read. */
function describeGap(fromMs: number | null, toMs: number | null): string {
  if (fromMs === null || toMs === null || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return 'an unread interval';
  }
  return `${((toMs - fromMs) / 1000).toFixed(1)}s`;
}
