import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { FEED_STATE_ENDED } from '../../src/browser/feedState.js';
import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { containerName, loadConfig } from '../../src/config.js';
import {
  type ArmedStageReading,
  describeDrainRamp,
  drainNotDeclared,
  drainRampOf,
  drainRung,
  firstRefusalAtMs,
  requireArmedStage,
  waitForSurvivingMaster,
} from '../../src/harness/batchDrain.js';
import { runBrowserArm } from '../../src/harness/browser.js';
import {
  byteSourceArmRefusal,
  ladderResolutionRefusal,
  viewerPlaybackRefusal,
} from '../../src/harness/browserVerdict.js';
import { MAX_WEEB3_SEGMENT_REQUESTS } from '../../src/harness/crashArm.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { announcedRungs, parseUploaderLog, timestampedMessages } from '../../src/harness/logwatch.js';
import { describeMaster, masterRungRefusal, masterRungsOf } from '../../src/harness/masterShape.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { rungArmMinutes } from '../../src/harness/rungArm.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { discoverCatalogFeed } from '../../src/harness/viewer.js';
import { waitFor } from '../../src/harness/wait.js';
import { requireByteSource, viewerGate } from '../../src/viewerCoverage.js';

/**
 * V11, a real viewer watches through one rung's postage batch running dry.
 *
 * ## What this asks that V3 does not
 *
 * V3, `suites/viewer/rung-outage.test.ts`, stops the transcode producing the rung a viewer is
 * riding: the encoder for that quality goes away. This one leaves everything running and empties the
 * prepaid postage behind ONE rung, so its node is up, its encoder is up, and every upload it makes
 * comes back refused. That is the failure a broadcaster actually meets, because postage is bought in
 * advance and runs out, and until now nothing had ever put a player in front of it.
 *
 * ## ⛔⛔ Why this arm silences nothing, and why it therefore has no rung timeline
 *
 * `browserArmScript` refuses two treatments in one arm, and it is right to: a picture that stopped
 * could then have stopped for either, and the run answers neither question. **A drained batch is
 * already a treatment**, applied to this stage before the suite started, so silencing a transcode on
 * top of it would be the second one. This arm is therefore a plain watch, exactly as V1's is.
 *
 * The honest consequence is that `result.rungs` and `result.recovery` are null, so
 * `rungArmRefusal`, `ladderInPlayRefusal` and `keptWatchingRefusal` cannot be asked here: all three
 * read a timeline that only a driver which injected its own fault writes. What is asked instead is
 * `viewerPlaybackRefusal`, which is the same question about whether the picture kept moving without
 * the phase structure a known fault instant buys. **`movedOffDeadRungRefusal` is deliberately not
 * asked**, and the next section says why.
 *
 * ## ⛔ When the drain lands is the stage's choice, not this suite's
 *
 * A depth 17 batch starts refusing chunks after about 3000 of them, which is roughly twenty seconds
 * of 1080p, and the byte-source settle alone is longer than that. So the rung is usually already
 * declining while the player is still settling, and this suite cannot arrange for the viewer to be
 * riding the drained rung at the moment it dies. Whether they ever decoded it at all is **recorded
 * as an observation** rather than asserted. Proving that a viewer riding a dead rung moves off it is
 * V3's question, and V3 answers it with a fault whose instant it controls.
 *
 * ⛔⛔ And it declines rather than stopping. Measured on the first live drain, 2026-09-04: bee refused
 * that rung's batch four times in about fifty seconds with segments landing in between, because a
 * chunk is refused only when its own bucket is full. Every segment that still gets through resets the
 * rung's lag, so the master keeps offering it until the ramp has finished. The master read below is
 * therefore waited on until it offers EXACTLY the survivors, and what the ramp did is printed as an
 * observation beside the player's own figures.
 *
 * ## What this asserts
 *
 * That the viewer got a picture and it kept moving. That they were never told the broadcast had
 * ended, because it had not: three rungs published throughout. That every resolution they were
 * served is one the deployment declares. That the byte source they are filed under is the one the
 * client actually used. And that the ladder they were offered lost exactly the drained rung and
 * nothing else, read off the published master, which is where that decision is made.
 *
 * ⛔ **At most one rung is dropped, read where it is decided.** `MAX_RUNGS_DROPPED_AT_ONCE` in the
 * uploader and `MAX_RUNGS_DROPPED_PER_LADDER` in the client are both 1, and
 * `test/rungDeathAgreement.test.ts` holds them against each other. What no unit test can show is
 * what a live master ended up offering, and that is the reading here: three rungs, not two and not
 * four. A master down to two has taken a healthy rung out from under viewers who were watching it,
 * which is the failure the owner's ruling of 2026-09-01 capped the drop at one to prevent.
 *
 * ## What this does not assert
 *
 * ⛔ No timing, per the owner ruling of 2026-08-29. Every duration is measured, printed under a
 * heading saying so, and filed in the artifact.
 *
 * ⛔ Nothing about the uploader side. `suites/scenarios/batch-drain.test.ts` asserts the refusal
 * line, the survivors' gapless run, the process staying up, `/health` and the per-rung drop counter.
 *
 * ⛔ Requires a deployed profile, funded stamps, the browser image on the host and an ARMED stage.
 * Nothing in CI runs these, and this one is deliberately absent from `test:e2e`, because the ordinary
 * full suite must never depend on a stage somebody broke on purpose. Decision 6 of
 * `docs/e2e-batch-drain-plan.md`.
 */

/** The broadcast has to be established before a viewer joins it, or the join is what gets broken. */
const WARMUP_SEGMENTS = 4;
const SEGMENT_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

/**
 * How long the viewer watches.
 *
 * `rungArmMinutes()`, which is V3's own budget, because a rung dying is only visible to a player
 * once the fragments it already holds run out and those are the windows V3's driver established for
 * exactly that. Derived rather than picked, so the two rung-death viewer suites buy the same length
 * of broadcast and their playback figures are comparable.
 */
const WATCH_MINUTES = rungArmMinutes();

const cfg = loadConfig();
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
// Module scope, so an undeclared run fails the file during import rather than skipping into silence.
// ⛔ First, and before the gate that throws: a full suite globs this file out of suites/viewer and
// has armed nothing, so it has to skip rather than refuse. See `drainNotDeclared`.
const skip =
  drainNotDeclared() || viewerGate(cfg.viewerExpectation, backend, cfg.browserRepoDir) || abrOff(cfg.abrEnabled);
// Module scope for the same reason: a run aimed at the coordinator must fail before a broadcast starts.
const drainedRung = drainRung(process.env);

describe('V11, a viewer watches through one rung losing its postage', { skip }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let startedAt: string;
  let armed: ArmedStageReading;

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    // ⛔ After the stamp gate. That one asks whether every rung can stamp for the length of a run,
    // which an armed rung can, because its drain batch is fresh with two days of life. This asks the
    // opposite question of the one rung, and refuses a drain batch a previous run already spent.
    armed = await requireArmedStage(host, cfg, drainedRung);
    console.log(`  armed: ${armed.rung} on :${armed.port} spends depth ${armed.depth} batch ${armed.batch}, unspent`);

    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
    // ⛔ Nothing is restored here. The drain batch is spent by now, and putting the original back
    // means rewriting BEE_PUBLISHERS and redeploying the uploader, which is
    // `deploy/scripts/drain-stage.sh restore` and is the operator's step after this sitting.
  });

  it('keeps watching a ladder that lost one quality, and is never told the broadcast ended', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 3_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments published before a viewer joins`,
    });

    const source = requireByteSource(backend);
    const result = await runBrowserArm(host, cfg, { backend: source, watchMinutes: WATCH_MINUTES });

    console.log(`  watched ${result.watchUrl} for ${result.samples} samples`);
    console.log(`  the viewer passed through: ${result.feedStatesSeen.join(' → ')}`);

    // ⛔ First. It settles whether the browser was a usable instrument and whether anyone watched at
    // all, and every reading below is a property of the harness rather than the product if it was not.
    const notWatched = viewerPlaybackRefusal(result);
    assert.equal(notWatched, null, `this run is not a viewer who watched the broadcast: ${notWatched}`);

    // ⛔ The lie this fault can tell. One rung of four lost its postage and the other three published
    // throughout, so a viewer told the broadcast was over would be leaving one that never stopped.
    assert.ok(
      !result.feedStatesSeen.includes(FEED_STATE_ENDED),
      'this viewer was told the broadcast had ended while three of four rungs were still publishing. ' +
        `They passed through: ${result.feedStatesSeen.join(' → ')}`,
    );

    const wrongQuality = ladderResolutionRefusal(result, cfg.abrLadderResolutions);
    assert.equal(
      wrongQuality,
      null,
      `this viewer was served a quality the deployment never configured: ${wrongQuality}`,
    );

    // ⛔⛔⛔ The shared refusal rather than the two branches this file used to carry, because the
    // branch it was missing is the one that matters: an artifact with no byte source section at all
    // reads back as requested null and reported null, which an equality check passes. A browser
    // image that predates the section, or any driver path that returns before the arm opens, would
    // then have filed this run as a proven condition on evidence that names none. That is the exact
    // hole this same diff closed in V4 and V5, one file later.
    const notItsCondition = byteSourceArmRefusal(result, { maxSegmentRequests: MAX_WEEB3_SEGMENT_REQUESTS });
    assert.equal(notItsCondition, null, `this arm is not the byte source it is filed as: ${notItsCondition}`);

    // ⭐ The ladder half, read off the published master because that is where the drop is decided.
    // Waited on rather than read once, and waited on until the master offers EXACTLY the survivors,
    // which is the same question the assertion below asks. A batch that is filling refuses a growing
    // share of segments rather than all of them, so the drained rung goes on landing the occasional
    // one and every one of those resets its lag and postpones the drop. See `waitForSurvivingMaster`.
    const survivingRungs = cfg.abrRungs.filter((rung) => rung !== drainedRung);
    const { owner } = await discoverCatalogFeed(host, cfg);
    const ladder = ladderGroupOf(await log());
    const master = await waitForSurvivingMaster(host, cfg, {
      owner,
      ladder,
      survivingRungs,
      readTopics: async () => topicsOf(await log()),
    });

    const masterRead = masterRungsOf(master, topicsOf(await log()));
    console.log(`  ${describeMaster(masterRead, master)}`);
    const wrongLadder = masterRungRefusal(masterRead, survivingRungs);
    assert.equal(
      wrongLadder,
      null,
      `the ladder this viewer was offered is not the three rungs that kept their postage: ${wrongLadder}`,
    );

    console.log(
      '  observations, none of them asserted. this viewer decoded ' +
        `${result.resolutions.join(' → ') || 'no resolution'}, ${
          rodeTheDrainedRung(result.resolutions) ? 'including' : 'never'
        } ` +
        `the drained rung's ${drainedResolution() ?? 'unknown geometry'}. advance ` +
        `${result.advanceRatio.toFixed(3)}, ${result.rebufferCount} rebuffers, ` +
        `${result.behindLive.medianS?.toFixed(2) ?? '—'}s behind live, ${result.segmentRequests} segment requests`,
    );

    // The same ramp reading scenario L prints, because a player's figures are only readable beside
    // what the rung under it was actually doing while they were taken.
    const settled = await log();
    const stamped = timestampedMessages(settled);
    const drainedStreamId = newestStreamIdOf(settled, drainedRung);
    const refusedAtMs = drainedStreamId === null ? null : firstRefusalAtMs(stamped, drainedStreamId);
    console.log(
      '  observations, none of them asserted. the ramp of ' +
        `${drainedStreamId ?? drainedRung} in ten second buckets: ${
          drainedStreamId === null || refusedAtMs === null
            ? 'this window holds no dated refusal for the drained rung, so there is no ramp to bucket'
            : describeDrainRamp(drainRampOf(stamped, drainedStreamId, refusedAtMs))
        }`,
    );
  });
});

/**
 * The newest announce for one rung, which is the session this broadcast published on it, or null.
 *
 * ⛔ Newest, for the reason `newestStreamIdByRung` in the scenario suite records: a session an engine
 * restart replaced announces again on a fresh topic while the retired one keeps its own, and the
 * retired stream is mid-finalize as the read happens.
 */
function newestStreamIdOf(logText: string, rung: string): string | null {
  const mine = announcedRungs(logText).filter((announce) => announce.rung === rung);
  return mine.at(-1)?.streamId ?? null;
}

/** The reason a single-rendition deployment skips, or `false` to run. */
function abrOff(enabled: boolean): string | false {
  return enabled ? false : 'ABR_ENABLED is off on this deployment, so there is no other rung for a drain to spare';
}

/** The drained rung's geometry as a browser reports it, or null where the ladder does not declare it. */
function drainedResolution(): string | null {
  const rung = cfg.abrLadder.find((entry) => entry.name === drainedRung);
  return rung === undefined ? null : `${rung.width}x${rung.height}`;
}

/** Whether this viewer ever decoded the rung whose batch was drained. Recorded, never asserted. */
function rodeTheDrainedRung(resolutions: readonly string[]): boolean {
  const drained = drainedResolution();
  return drained !== null && resolutions.includes(drained);
}

/** Every rung's feed topic by rung name, which is how the master's variants are joined to rungs. */
function topicsOf(logText: string): ReadonlyMap<string, string> {
  const byTopic = new Map<string, string>();
  for (const announce of announcedRungs(logText)) {
    byTopic.set(announce.topic, announce.rung);
  }
  return byTopic;
}

/**
 * The one ladder group this window announced, or a refusal naming what it found instead.
 *
 * ⛔ Refuses two rather than picking one. Reading another broadcast's master would hold a stranger's
 * rungs against this run's expectation, and on this shared host that is not hypothetical.
 */
function ladderGroupOf(logText: string): string {
  const groups = [...new Set(announcedRungs(logText).map((announce) => announce.ladder))];
  if (groups.length !== 1) {
    throw new Error(
      `this window announced ${groups.length} ladder group(s) (${groups.join(', ') || 'none'}), so which ` +
        'master this viewer was offered cannot be decided.',
    );
  }
  return groups[0];
}
