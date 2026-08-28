import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { scenarioByName } from '../../src/browser/faults.js';
import { FEED_STATE_RECONNECTING } from '../../src/browser/feedState.js';
import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { containerName, loadConfig } from '../../src/config.js';
import { runBrowserArm } from '../../src/harness/browser.js';
import {
  crashArmMinutes,
  crashArmRefusal,
  crashArmSummary,
  freezeRefusal,
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
 * ## ⛔ What it does not assert
 *
 * Not where the player ended up behind live. Both arms stalled five times, hls.js raises its latency
 * target on a stall and never lowers it, and the matrix leaves the 1s difference between the two arms
 * explicitly uninterpreted. It is printed and filed.
 *
 * Not the rebuffer count or the advance ratio either. Those are properties of how long the outage was
 * rather than of the product, and a threshold on them would be a number invented here.
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
 * The shortest freeze that still means the gateway went away.
 *
 * A 20s outage against roughly six seconds of buffer cannot honestly cost a viewer much under
 * fourteen. Ten is under everything the arithmetic allows and still refuses a run where the fault
 * never landed, which otherwise passes every other check here and reports the product surviving an
 * outage it never had.
 */
const MIN_FREEZE_MS = 10_000;

/**
 * The longest it may cost them.
 *
 * Three readings of this fault sit between 27.6 and 30.6s: the two arms of 2026-08-27 and the gateway
 * corpus run of 2026-08-05. Sixty is double the worst of the three and still inside the eighty seconds
 * of watching that follow the fault, so a viewer who never came back inside the window fails here
 * rather than passing on the run having ended first.
 */
const MAX_FREEZE_MS = 60_000;

/**
 * How long the picture must keep moving after the gateway dies, which is the buffer doing its job.
 *
 * The matrix recorded 6.0s in-tab and 6.1s through the gateway, which is `LIVE_SYNC_DURATION_S` of
 * runway spending itself. Three seconds is half of that: a viewer who froze faster than that had no
 * buffer in front of them at all.
 */
const MIN_BUFFER_MS = 3_000;

/**
 * How long after the gateway answers again the picture must be moving.
 *
 * 10.7s and 9.9s recorded. Thirty is three times the worse of them and comfortably inside the recovery
 * watch, which the gateway's own seven seconds of startup eats into before the client gets a chance.
 */
const MAX_RESUME_MS = 30_000;

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

    const wrongFreeze = freezeRefusal(recovery, {
      minFreezeMs: MIN_FREEZE_MS,
      maxFreezeMs: MAX_FREEZE_MS,
      minBufferMs: MIN_BUFFER_MS,
    });
    assert.equal(wrongFreeze, null, `the picture did not stop the way a gateway outage stops it: ${wrongFreeze}`);

    const notBack = resumeRefusal(recovery, { expectRecovery: true, withinMs: MAX_RESUME_MS });
    assert.equal(notBack, null, `the viewer did not get their picture back: ${notBack}`);

    // ⭐ The one fault in the matrix whose overlay speaks. A frozen frame that says why is a viewer
    // who waits, and a frozen frame still claiming to be live is a viewer who reloads or leaves.
    const notTold = frozenOverlayRefusal(recovery, { told: [FEED_STATE_RECONNECTING] });
    assert.equal(notTold, null, `the client did not tell the viewer what the matrix records: ${notTold}`);
  });
});
