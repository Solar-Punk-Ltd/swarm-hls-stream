import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { scenarioByName } from '../../src/browser/faults.js';
import {
  FEED_STATE_DEGRADED,
  FEED_STATE_ENDED,
  FEED_STATE_RECONNECTING,
  FEED_STATE_STALLED,
} from '../../src/browser/feedState.js';
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
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import { parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { waitFor } from '../../src/harness/wait.js';
import { requireByteSource, viewerGate } from '../../src/viewerCoverage.js';

/**
 * V10 — the ingest engine is restarted under a watching viewer, and their broadcast is over.
 *
 * ## What this promotes
 *
 * Arm 6 of the crash matrix, `docs/bench/crash-at-an-in-tab-viewer-2026-08-27.md`, and the one fault
 * in it whose correct outcome is a picture that never comes back. Restarting the engine takes the
 * publisher's SRT connection with it, so the broadcast this viewer is watching genuinely ends: there
 * is no more media coming and a resume would mean they had been handed a different broadcast.
 *
 * ⭐ **The first time a viewer was watching when the orphan reap spoke.** The viewer froze for 83.2s
 * and the overlay escalated from "Waiting for the broadcast to continue" to "This broadcast has
 * ended", which is issue #86's sixty second reap finalizing the stream and the news reaching a
 * screen. The corpus run of this fault, on 2026-08-05, froze for 84.3s and never recovered, and could
 * only infer that the broadcast had ended.
 *
 * ## How this differs from V5, which also ends a broadcast
 *
 * V5 stops the broadcaster cleanly and the stack finalizes a VOD on purpose. This kills the engine
 * under them, so the ending is discovered rather than announced, by a reap that exists to clean up
 * sessions nobody closed. Both must reach the same screen, and only one of them was ever a plan.
 *
 * ## ⛔ No timing is asserted
 *
 * Owner ruling of 2026-08-29: an e2e suite checks feature correctness and stability, and performance
 * is a separate kind of test. There was never a freeze ceiling here, because the picture stops and
 * stays stopped and the 83.2s the matrix records is just the rest of that arm. There WAS a floor of
 * 20s, and it is the sharpest example of why a timing gate does not belong in a correctness suite:
 * live on the ladder this case froze for 16.3s, reached the ended state exactly as it should, and was
 * refused for costing its viewer four seconds less than the matrix recorded. It failed for being
 * better. The freeze is measured, printed per arm and filed, and it refuses nothing.
 *
 * ⚠️ The terminal message has to arrive inside the ninety seconds of watching that follow the fault,
 * against a reap that fires sixty seconds after the session goes quiet. The recorded arm reached it
 * with room, and the windows here are deliberately the driver's defaults, which is what the matrix
 * was measured with. Widening them would buy margin at the price of no longer running the arm the
 * matrix recorded.
 *
 * ⛔ Requires a deployed profile, a funded stamp and the browser image on the host, like every suite
 * under `suites/`. Nothing in CI runs these.
 */

const SCENARIO = scenarioByName('engine-restart');

/**
 * How much wall clock the arm gets, derived from the fault rather than picked here.
 *
 * It must outlast the driver's whole timeline: the in-tab node's settle, the 45s baseline before the
 * fault, this scenario's own 30s, and the 60s of watching after it in which the reap has to speak.
 */
const WATCH_MINUTES = crashArmMinutes(SCENARIO);

/**
 * The states that are TRUE of this viewer, and the one fault where that includes the terminal one.
 *
 * ⭐ The broadcast is genuinely over: the engine took the publisher's SRT connection with it, no more
 * media is coming, and the orphan reap of issue #86 finalizes the stream sixty seconds after the
 * session goes quiet. So `ended` is the truth here rather than the lie it is in every other crash
 * case, and it is what this suite exists to see reached.
 *
 * The three non-terminal states are true on the way to it. Before the reap fires the client knows
 * only that its picture stopped and the slot is not being served, which is exactly `stalled`, and
 * `degraded` and `reconnecting` are the same situation read through the other two counters. Which of
 * them a stranded viewer passes through is the client's business: the recorded arm escalated
 * `stalled → ended`, and a client that went another way has not treated the viewer any worse.
 */
const TRUTHFUL_WHILE_FROZEN = [
  FEED_STATE_RECONNECTING,
  FEED_STATE_STALLED,
  FEED_STATE_DEGRADED,
  FEED_STATE_ENDED,
] as const;

/** The broadcast has to be established before a viewer joins it, or the join is what gets broken. */
const WARMUP_SEGMENTS = 4;
const SEGMENT_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
// Module scope, so an undeclared run fails the file during import rather than skipping into silence.
const skip = viewerGate(cfg.viewerExpectation, backend, cfg.browserRepoDir);

describe('V10 — a viewer whose broadcast ends because the engine restarted', { skip }, () => {
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
    // The publisher's SRT died with the engine, and stopping an ffmpeg that has already gone is safe.
    // ⛔ No container to put back, unlike every other crash suite: docker brings a restarted container
    // back itself, which is why the driver's own restore does nothing for this action either.
    await publisher?.stop();
  });

  it('is told the broadcast has ended, rather than left on a frozen last frame', async () => {
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
    assert.equal(notWatching, null, `this run is not a viewer who was watching when the engine went: ${notWatching}`);
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

    // ⛔ A resume is the failure here, not the pass. The publisher went with the engine, so a picture
    // that starts moving again is a viewer who was handed a different broadcast, or a fault that
    // never landed. `faults.ts` carries the same expectation, and the two say it for one reason: the
    // report once called a correct run of this fault a failure, in the words it uses for a viewer
    // stranded on a stream that is still being published.
    const wrongEnding = resumeRefusal(recovery, { expectRecovery: false });
    assert.equal(wrongEnding, null, `this broadcast was over and the picture moved anyway: ${wrongEnding}`);

    const notTold = frozenOverlayRefusal(recovery, { truthful: TRUTHFUL_WHILE_FROZEN, mustSpeak: true });
    assert.equal(notTold, null, `the client did not tell this viewer the truth about their picture: ${notTold}`);

    // ⭐ The whole case, and asserted exactly as V5 asserts its own: a viewer told the broadcast ended
    // stops waiting, and one left on a frozen frame that still claims to be live reloads or leaves.
    // The ROUTE there is printed above and not asserted, because which state a stranded viewer passes
    // through on the way is the client's business rather than the viewer's.
    assert.ok(
      result.reachedEndedOverlay,
      `the engine took this broadcast with it and the viewer was never told: they passed through ` +
        `${result.feedStatesSeen.join(' → ')} and never reached '${FEED_STATE_ENDED}', so a real viewer ` +
        'is sitting on a frozen last frame deciding whether to reload',
    );
  });
});
