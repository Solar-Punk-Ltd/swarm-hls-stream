import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { containerName, loadConfig } from '../../src/config.js';
import { runBrowserArm } from '../../src/harness/browser.js';
import { ladderResolutionRefusal } from '../../src/harness/browserVerdict.js';
import { MAX_WEEB3_SEGMENT_REQUESTS } from '../../src/harness/crashArm.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import { parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import {
  climbedBackRefusal,
  keptPlayingRefusal,
  qualityArmRefusal,
  qualityArmSummary,
  squeezeArmMinutes,
  steppedDownRefusal,
  throttleRefusal,
} from '../../src/harness/qualityArm.js';
import { waitFor } from '../../src/harness/wait.js';
import { requireByteSource, viewerGate } from '../../src/viewerCoverage.js';

/**
 * V2 — a viewer's connection gets worse, and their player finds a quality it can carry.
 *
 * ## ⛔ What this is the first of anything to ask
 *
 * This deployment transcodes four renditions and publishes each to Swarm, and until this file no test
 * had ever established that a player uses them. `suites/service/abr-ladder.test.ts` and
 * `suites/scenarios/abr-engine-restart.test.ts` both read the **uploader's log**, which can say the
 * four rungs were published and gapless and nothing whatever about a viewer. The seven browser suites
 * beside this one watch a player on an unconstrained link, where a correct player has no reason to
 * change rung. So the ladder was four times the transcode and four times the publishing cost, with
 * the feature it buys unobserved.
 *
 * Recorded in `docs/e2e-viewer-coverage-plan.md` and in the memory note
 * `swarm-hls-abr-viewer-never-watched.md`.
 *
 * ## What this asserts
 *
 * That the viewer was watching and their player was choosing its own rung. That the cap reached the
 * player, which is an instrument question and comes before every product one. That the player came
 * down off the rung the link could no longer carry, that the picture kept moving while it was down,
 * and that it climbed back once the link was released.
 *
 * ## ⛔⛔ How the bandwidth is chosen, and why it is not chosen from the ladder alone
 *
 * From THE RUNG THE VIEWER IS ACTUALLY ON. The driver reads it off the overlay after the settle and
 * caps the link at the bitrate of the next rung down, so that rung stays exactly affordable and the
 * one being played no longer fits.
 *
 * ⛔ The first version took the second lowest rung's bitrate regardless of what was playing, which is
 * right only when the viewer starts at the top. Live on 2026-08-30 the gateway profile settled its
 * viewer on **360p, the bottom rung**, before anything was capped. 360p stayed affordable, the player
 * correctly did not move, and this case reported "a ladder nobody descends". That is a property of
 * the byte source, and this project already knew it: an in-tab viewer rides 1080p and a gateway
 * viewer rides 360p on the same broadcast.
 *
 * ⭐ A viewer already on the bottom rung is REFUSED rather than failed. There is no bandwidth that
 * would give them somewhere to go, so the question cannot be put to them.
 *
 * ## ⛔ No timing is asserted
 *
 * Owner ruling of 2026-08-29. How long the player took to come down, and how long it took to go back
 * up, are measured on every arm, printed under a heading that says so, and filed in the artifact.
 * Neither refuses a run.
 *
 * ## ⚠️ The two profiles will not behave alike, and nothing here compares them
 *
 * An in-tab node and a gateway differ by an order of magnitude in request count and carry segment
 * bytes over different transports. Both are expected to switch. Any figure from one read against the
 * other is comparing two deployments.
 *
 * ⛔ Requires a deployed profile, a funded stamp and the browser image on the host, like every suite
 * under `suites/`. Nothing in CI runs these.
 */

/** The broadcast has to be established before a viewer joins it, or the join is what gets squeezed. */
const WARMUP_SEGMENTS = 4;
const SEGMENT_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const WATCH_MINUTES = squeezeArmMinutes();

const cfg = loadConfig();
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
// Module scope, so an undeclared run fails the file during import rather than skipping into silence.
const skip = viewerGate(cfg.viewerExpectation, backend) || abrOff(cfg.abrEnabled);

describe('V2 — a viewer whose connection gets worse keeps watching, at a quality it can carry', { skip }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let startedAt: string;

  before(async () => {
    const stamp = await discoverStamp(host, cfg);
    assert.ok(stamp.batchTTL > MIN_STAMP_TTL_S, `stamp TTL ${stamp.batchTTL}s too low to run a stream`);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
    // ⛔ Nothing to restore on the deployment. The cap lives inside the browser and dies with it, which
    // is the one way this arm is cheaper to clean up after than a crash arm.
  });

  it('steps down under a squeezed link, keeps playing, and climbs back when it is released', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 3_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments published before a viewer joins`,
    });

    const result = await runBrowserArm(host, cfg, {
      backend: requireByteSource(backend),
      watchMinutes: WATCH_MINUTES,
      squeeze: true,
    });
    console.log(`  ${qualityArmSummary(result)}`);

    // ⛔ First, and before any rung is read. It settles whether there was a viewer at all, whether the
    // browser was a usable instrument, and whether this artifact is a squeeze arm rather than a plain
    // watch. A watch produces a full report in which a player that never changed rung looks exactly
    // like a player that refused to.
    const notSqueezed = qualityArmRefusal(result, { maxSegmentRequests: MAX_WEEB3_SEGMENT_REQUESTS });
    assert.equal(notSqueezed, null, `this run is not a viewer whose connection was made worse: ${notSqueezed}`);

    const quality = result.quality;
    assert.ok(quality, 'the refusal above should already have caught an artifact with no quality verdict');

    // ⭐ Phase 1 of docs/e2e-viewer-coverage-plan.md, asked here as everywhere else: whatever rung this
    // viewer rode, it has to be one the deployment declares.
    const wrongQuality = ladderResolutionRefusal(result, cfg.abrLadderResolutions);
    assert.equal(
      wrongQuality,
      null,
      `this viewer was served a quality the deployment never configured: ${wrongQuality}`,
    );

    // ⛔ The instrument question, and it comes before the product one on purpose. Chromium applies the
    // cap itself and an in-tab node carries segment bytes over its own peer connections, so a player
    // that never measured the squeeze must be refused as a harness failure rather than reported as a
    // ladder that does not adapt.
    const capNeverLanded = throttleRefusal(quality);
    assert.equal(
      capNeverLanded,
      null,
      `the cap did not reach this player, so the run proves nothing: ${capNeverLanded}`,
    );

    // ⭐ The assertion that makes ABR a tested property rather than a published one.
    const rodeItOut = steppedDownRefusal(quality);
    assert.equal(rodeItOut, null, `this viewer did not step down when their link could not carry them: ${rodeItOut}`);

    // ⭐ And the half that makes the step down worth having.
    const stalled = keptPlayingRefusal(quality);
    assert.equal(stalled, null, `stepping down bought this viewer nothing: ${stalled}`);

    // ⭐ The other direction. A ladder that only descends leaves a viewer who had one bad minute on the
    // bottom rung for the rest of the broadcast.
    const stuckLow = climbedBackRefusal(quality);
    assert.equal(stuckLow, null, `this viewer never got their quality back: ${stuckLow}`);

    console.log(
      `  observations, none of them asserted. capped at ${quality.throttledToKbps} kbps: came down after ` +
        `${describeMs(quality.steppedDownAfterMs)}, climbed back after ${describeMs(quality.climbedBackAfterMs)}, ` +
        `${quality.switchesCounted} level changes, advance ${quality.during.advance.ratio.toFixed(3)} while capped`,
    );
  });
});

/** The reason a single-rendition deployment skips, or `false` to run. */
function abrOff(enabled: boolean): string | false {
  return enabled ? false : 'ABR_ENABLED is off on this deployment, so there is no ladder to step down';
}

/** A duration for a person, or the plain fact that it never happened. */
function describeMs(ms: number | null): string {
  return ms === null ? 'never' : `${(ms / 1000).toFixed(1)}s`;
}
