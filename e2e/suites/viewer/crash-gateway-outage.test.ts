import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { scenarioByName } from '../../src/browser/faults.js';
import { FEED_STATE_DEGRADED, FEED_STATE_RECONNECTING, FEED_STATE_STALLED } from '../../src/browser/feedState.js';
import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { containerName, loadConfig } from '../../src/config.js';
import { runBrowserArm } from '../../src/harness/browser.js';
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
 * V6 — the gateway a viewer reads through is taken away under them, and given back.
 *
 * ## What this promotes
 *
 * Arms 1 and 2 of the crash matrix, `docs/bench/crash-at-an-in-tab-viewer-2026-08-27.md`. The gateway
 * was stopped for 20.5s under two viewers minutes apart, one reading segment bytes from a Swarm node
 * in its own tab and one reading everything from the gateway. Both froze for about 28 seconds, both
 * were told why, and both came back about ten seconds after the service answered.
 *
 * ⭐ Those two arms are this one file. The byte source is a property of the run profile rather than of
 * the scenario, so `in-browser` runs the in-tab arm and `light-client` runs its control, and the
 * thresholds below hold for both because the matrix recorded them within a second of each other.
 *
 * ## What this asserts
 *
 * That the viewer was watching, that the gateway coming back brought the picture back, and that they
 * were told something true while it was stopped.
 *
 * ⭐ **This is the one fault where the client is held to saying something.** Its own gateway is the
 * container that was stopped, so every manifest read fails and the client cannot fail to know. The
 * other four break something upstream of a gateway that goes on answering, where issue #100 means the
 * client may genuinely not find out, and their silence is reported rather than refused.
 *
 * ## ⛔ What it does not assert
 *
 * **No timing.** Owner ruling of 2026-08-29: an e2e suite checks feature correctness and stability,
 * and performance is a separate kind of test. This once held the freeze between 10 and 60 seconds,
 * required 3s of buffer in front of it and required the resume inside 30s, all from the 2026-08-27
 * matrix, which was a single-rendition 720p broadcast. Every one of those figures is still measured,
 * printed per arm and filed in the artifact, and none of them refuses a run.
 *
 * Nor where the player ended up behind live, nor the rebuffer count, nor the advance ratio. Those
 * were never asserted and still are not.
 *
 * ⛔ Requires a deployed profile, a funded stamp and the browser image on the host, like every suite
 * under `suites/`. Nothing in CI runs these. See `src/harness/browser.ts` for the launch contract.
 */

const SCENARIO = scenarioByName('viewer-gateway-outage');

/**
 * How much wall clock the arm gets, derived from the fault rather than picked here.
 *
 * It must outlast the driver's whole timeline: the in-tab node's settle, the 45s baseline before the
 * fault, this scenario's own 20s outage, the restart and the 60s recovery watch.
 */
const WATCH_MINUTES = crashArmMinutes(SCENARIO);

/**
 * The states that are TRUE of a viewer whose gateway is gone, and it is all three non-terminal ones.
 *
 * ⛔ This asked for exactly `reconnecting` and got `degraded` live on 2026-08-29. Both are true, and
 * the one that fires depends on plumbing the viewer cannot see. `reconnecting` is the literal reading:
 * the gateway is not answering. `degraded` is what an in-tab arm produces, because its segments keep
 * arriving from the node in its own tab, every arrival calls `recordGatewayReachable()` with no topic
 * and forgives every held topic outright, so the failure count returns to zero and the client falls
 * through to the more specific truth it has, which is that the picture keeps stopping. `stalled` is
 * the third reading of the same situation. A viewer is correctly served by any of them.
 *
 * ⛔ `ended` is the lie. The broadcaster never stopped and the picture comes back, so a viewer told
 * the broadcast is over is a viewer who leaves a broadcast that is still running.
 */
const TRUTHFUL_WHILE_FROZEN = [FEED_STATE_RECONNECTING, FEED_STATE_STALLED, FEED_STATE_DEGRADED] as const;

/** The broadcast has to be established before a viewer joins it, or the join is what gets broken. */
const WARMUP_SEGMENTS = 4;
const SEGMENT_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
// Module scope, so an undeclared run fails the file during import rather than skipping into silence.
const skip = viewerGate(cfg.viewerExpectation, backend);

describe('V6 — a viewer whose gateway is taken away, and given back', { skip }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const broken = containerName(cfg, SCENARIO.service);
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
    // ⛔ The driver puts the gateway back itself, from a `finally` that runs inside the browser
    // container. An arm killed by the harness timeout never reaches it, and this deployment is shared
    // with everything else the project measures, so a stopped gateway would outlive the run.
    await host.start(broken).catch(() => undefined);
  });

  it('plays out its buffer, says why it stopped, and comes back on its own', async () => {
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
    // Every figure below is meaningless until it passes, and a hidden page stops advancing playback
    // on its own in a way indistinguishable from the freeze this case exists to measure.
    const notWatching = crashArmRefusal(result, {
      scenario: SCENARIO.name,
      maxSegmentRequests: MAX_WEEB3_SEGMENT_REQUESTS,
    });
    assert.equal(
      notWatching,
      null,
      `this run is not a viewer who was watching when the gateway went away: ${notWatching}`,
    );

    const recovery = result.recovery;
    assert.ok(recovery, 'the refusal above should already have caught an artifact with no fault verdict');

    // ⭐ The contract: the gateway comes back and so does the picture, on its own and without a
    // reload. How long that took is in the summary above and is not judged here.
    const notBack = resumeRefusal(recovery, { expectRecovery: true });
    assert.equal(notBack, null, `the viewer did not get their picture back: ${notBack}`);

    // ⭐ See the docblock for which states are true here and why the client is held to speaking.
    const notTold = frozenOverlayRefusal(recovery, { truthful: TRUTHFUL_WHILE_FROZEN, mustSpeak: true });
    assert.equal(notTold, null, `the client did not tell this viewer the truth about their picture: ${notTold}`);
  });
});
