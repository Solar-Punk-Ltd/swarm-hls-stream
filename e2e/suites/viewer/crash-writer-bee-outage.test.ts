import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { scenarioByName } from '../../src/browser/faults.js';
import { FEED_STATE_DEGRADED, FEED_STATE_RECONNECTING, FEED_STATE_STALLED } from '../../src/browser/feedState.js';
import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { containerName, loadConfig } from '../../src/config.js';
import { runBrowserArm } from '../../src/harness/browser.js';
import { ladderResolutionRefusal } from '../../src/harness/browserVerdict.js';
import {
  crashArmMinutes,
  crashArmRefusal,
  crashArmSummary,
  frozenOverlayRefusal,
  MAX_WEEB3_SEGMENT_REQUESTS,
  resumeRefusal,
} from '../../src/harness/crashArm.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { waitFor } from '../../src/harness/wait.js';
import { requireByteSource, viewerGate } from '../../src/viewerCoverage.js';

/**
 * V9 — the writer's node is taken away for longer than the uploader can retry, and a viewer plays
 * through the break in the timeline.
 *
 * ## What this promotes
 *
 * Arm 5 of the crash matrix, `docs/bench/crash-at-an-in-tab-viewer-2026-08-27.md`. Past the fifteen
 * second retry window the uploader gives up on the segment in flight and arms `#EXT-X-DISCONTINUITY`,
 * so the next good segment declares that the timeline broke.
 * `suites/scenarios/bee-outage-long.test.ts` proves the uploader does that correctly and stops there.
 * Whether hls.js then recovers the timeline, or stalls on a discontinuity it was told about, is a
 * different question, and the matrix is the first time anything watched it: 29.5s frozen, playback
 * moving again 12.5s after the node answered, two rebuffers.
 *
 * ⚠️ **No control ran for this fault inside that sitting**, and the readings of it disagree by era
 * and by configuration: 54.9s frozen on 2026-08-06 before the loop fix, 29.5s in the matrix, and
 * 57.0s on the four rung ladder on 2026-08-29. Three numbers, three different stacks.
 *
 * ## ⛔ No timing is asserted
 *
 * Owner ruling of 2026-08-29: an e2e suite checks feature correctness and stability, and performance
 * is a separate kind of test. This once held the freeze between 10 and 45 seconds and the resume
 * inside 25, chosen to sit between the matrix and the pre-loop-fix era. The ladder read 57.0s and the
 * case went red for a configuration difference rather than a broken feature: an in-browser node
 * admits roughly one segment a second, so half second segments cap it near half of real time. Both
 * figures are still measured, printed per arm and filed in the artifact.
 *
 * ## ⚠️ The known gap this REPORTS rather than asserts: issue #100, the overlay says nothing
 *
 * The picture stopped for 29.5 seconds and `FeedStateOverlay` rendered nothing, the same silence V7
 * reports and the same mechanism: `UNSERVED_SLOT_POLL_LIMIT` counts polls whose rate collapses during
 * the stall it exists to detect, and one long freeze is a single playback stall rather than the burst
 * `degraded` needs. Half a minute of frozen frame with no explanation is the worst instance of it in
 * the matrix.
 *
 * ⭐ **So the silence is printed, and only a FALSE message fails.** This used to assert the silence
 * exactly, which turned the case red the day the product improved. Under the owner ruling of
 * 2026-08-29 a correctness suite goes green when that happens.
 *
 * ⛔ Requires a deployed profile, a funded stamp and the browser image on the host, like every suite
 * under `suites/`. Nothing in CI runs these.
 */

const SCENARIO = scenarioByName('writer-bee-outage');

/**
 * How much wall clock the arm gets, derived from the fault rather than picked here.
 *
 * It must outlast the driver's whole timeline: the in-tab node's settle, the 45s baseline before the
 * fault, this scenario's own 20s outage, the node's restart and the 60s recovery watch.
 */
const WATCH_MINUTES = crashArmMinutes(SCENARIO);

/**
 * The states that are TRUE of a viewer whose writer node is gone, and it is all three non-terminal ones.
 *
 * The gateway answers throughout, so `stalled` is the literal reading: nothing is being written into
 * the slot the player waits on. `degraded` describes the same viewer by the other route, and
 * `reconnecting` says nothing false to them either. All three tell somebody looking at a stopped
 * picture that the client knows and is still trying, which is what is happening.
 *
 * ⛔ `ended` is the lie. The broadcaster never stopped, the node comes back, and the viewer plays on
 * across the discontinuity, so being told the broadcast is over would make them leave one that is
 * still running and about to resume.
 */
const TRUTHFUL_WHILE_FROZEN = [FEED_STATE_RECONNECTING, FEED_STATE_STALLED, FEED_STATE_DEGRADED] as const;

/** The broadcast has to be established before a viewer joins it, or the join is what gets broken. */
const WARMUP_SEGMENTS = 4;
const SEGMENT_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
// Module scope, so an undeclared run fails the file during import rather than skipping into silence.
const skip = viewerGate(cfg.viewerExpectation, backend, cfg.browserRepoDir);

describe("V9 — a viewer plays through the discontinuity a writer's outage arms", { skip }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const broken = containerName(cfg, SCENARIO.service);
  let publisher: Publisher;
  let startedAt: string;

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
    // ⛔ The driver starts the node again itself, from a `finally` that runs inside the browser
    // container, which an arm killed by the harness timeout never reaches. This is the node holding
    // the postage batch every measurement on this host is paid for with, so it must not stay down.
    await host.start(broken).catch(() => undefined);
  });

  it('stops while nothing is being written, then resumes across the break', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 3_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments published before a viewer joins`,
    });

    const result = await runBrowserArm(host, cfg, {
      backend: requireByteSource(backend),
      watchMinutes: WATCH_MINUTES,
      scenario: SCENARIO.name,
    });
    console.log(`  ${crashArmSummary(result)}`);
    console.log(`  the viewer passed through: ${result.feedStatesSeen.join(' → ')}`);

    // ⛔ First. It settles whether there was a viewer at all, whether the browser was a usable
    // instrument, and whether this artifact is the fault and the byte source it is being filed as.
    const notWatching = crashArmRefusal(result, {
      scenario: SCENARIO.name,
      maxSegmentRequests: MAX_WEEB3_SEGMENT_REQUESTS,
    });
    assert.equal(
      notWatching,
      null,
      `this run is not a viewer who was watching when the node went away: ${notWatching}`,
    );
    // ⭐ Phase 1 of docs/e2e-viewer-coverage-plan.md. The resolutions were already being captured and
    // printed, so a viewer riding a rung nobody configured passed every suite on a reading that was
    // sitting right there. Asks whether the rung is one the ladder declares, never which one.
    const wrongQuality = ladderResolutionRefusal(result, cfg.abrLadderResolutions);
    assert.equal(
      wrongQuality,
      null,
      `this viewer was served a quality the deployment never configured: ${wrongQuality}`,
    );

    const recovery = result.recovery;
    assert.ok(recovery, 'the refusal above should already have caught an artifact with no fault verdict');

    // ⭐ The whole question `bee-outage-long` could not answer: hls.js was told the timeline broke,
    // and this is whether it carried on across the break or stalled on being told. A pass or a fail
    // here is that, and nothing about how long the crossing took.
    const notBack = resumeRefusal(recovery, { expectRecovery: true });
    assert.equal(notBack, null, `the viewer did not play through the discontinuity: ${notBack}`);

    // ⭐ Nothing untrue, and silence tolerated. See the docblock: #100 means this client may genuinely
    // not know, so the day it starts explaining this fault the case stays green.
    const untrue = frozenOverlayRefusal(recovery, { truthful: TRUTHFUL_WHILE_FROZEN, mustSpeak: false });
    assert.equal(untrue, null, `the client told this viewer something untrue about their picture: ${untrue}`);
    console.log(
      `  observed, not asserted: the client ${
        recovery.explainedTheFreeze ? 'explained the freeze' : 'said NOTHING while the picture was stopped (#100)'
      }`,
    );
  });
});
