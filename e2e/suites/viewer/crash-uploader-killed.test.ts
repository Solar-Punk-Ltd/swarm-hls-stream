import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { scenarioByName } from '../../src/browser/faults.js';
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
 * V7 — the process writing the broadcast into Swarm is killed under a watching viewer.
 *
 * ## What this promotes
 *
 * Arm 3 of the crash matrix, `docs/bench/crash-at-an-in-tab-viewer-2026-08-27.md`. SIGKILL to the
 * uploader, nothing new reaching the feed for fifteen seconds, and a viewer who spent 7.1s of buffer,
 * froze for 13.5s, and had their picture back 2.3s after the process answered again.
 *
 * `suites/scenarios/uploader-crash-recovery.test.ts` already proves the uploader resumes without a
 * spurious VOD. It reads the uploader's log, so what it can see is that the service did the right
 * thing. This is the same fault from the only other side that matters.
 *
 * ## ⛔ The known gap this asserts: issue #100, the overlay says nothing
 *
 * The picture stopped for 13.5 seconds and `FeedStateOverlay` rendered nothing at all, so the viewer
 * sat in front of a frozen frame that still claimed to be live. That is not what the product should
 * do and it IS what the product does. #100 traced it to `UNSERVED_SLOT_POLL_LIMIT` counting polls
 * whose rate collapses during the stall the limit exists to detect, so the threshold is never reached
 * while it matters. It is a threshold-unit defect rather than a byte-source one, and the in-tab
 * reading removed the last excuse to think otherwise.
 *
 * ⭐ So the silence is asserted, exactly, and this is where a fix for #100 shows up: the case turns
 * red the day the overlay starts speaking, and the message it fails with says so. Asserting the
 * behaviour we want instead would leave a case that has never passed and tells nobody anything.
 *
 * ⛔ Requires a deployed profile, a funded stamp and the browser image on the host, like every suite
 * under `suites/`. Nothing in CI runs these.
 */

const SCENARIO = scenarioByName('uploader-crash');

/**
 * How much wall clock the arm gets, derived from the fault rather than picked here.
 *
 * It must outlast the driver's whole timeline: the in-tab node's settle, the 45s baseline before the
 * fault, this scenario's own 15s outage, the restart and the 60s recovery watch.
 */
const WATCH_MINUTES = crashArmMinutes(SCENARIO);

/**
 * The shortest freeze that still means the uploader was killed.
 *
 * Fifteen seconds of nothing reaching the feed against seven of buffer leaves about eight, before the
 * client's own recovery is added. Three is well under that and refuses a run where the process was
 * never killed, which would otherwise pass every other check here.
 */
const MIN_FREEZE_MS = 3_000;

/**
 * The longest it may cost them.
 *
 * 13.5s recorded. The era before the 0.8a recovery fix took 46.7s just to resume after the service
 * came back, which put the freeze somewhere past fifty. Forty-five fails that era and leaves this one
 * more than three times the room it used.
 */
const MAX_FREEZE_MS = 45_000;

/**
 * How long the picture must keep moving after the process dies, which is the buffer doing its job.
 *
 * 7.1s recorded, which is `LIVE_SYNC_DURATION_S` of runway spending itself. Three seconds is under
 * half of that: a viewer who froze faster than that had no buffer in front of them.
 */
const MIN_BUFFER_MS = 3_000;

/**
 * How long after the uploader answers again the picture must be moving.
 *
 * ⭐ The figure the 0.8a recovery fix is judged on, and the reason this ceiling is tight: 2.3s here,
 * 4.1s on the gateway corpus the probe ladder was verified at, and 46.7s before the fix landed.
 * Twenty separates the fixed product from the regression it replaced, at five times the worse of the
 * two fixed readings.
 */
const MAX_RESUME_MS = 20_000;

/** The broadcast has to be established before a viewer joins it, or the join is what gets broken. */
const WARMUP_SEGMENTS = 4;
const SEGMENT_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
// Module scope, so an undeclared run fails the file during import rather than skipping into silence.
const skip = viewerGate(cfg.viewerExpectation, backend);

describe('V7 — a viewer watching when the uploader is killed', { skip }, () => {
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
    // ⛔ The driver restarts the uploader itself, from a `finally` that runs inside the browser
    // container. An arm killed by the harness timeout never reaches it, and a dead uploader would
    // then outlive this run on a deployment shared with everything else the project measures.
    await host.start(broken).catch(() => undefined);
  });

  it('spends its buffer, waits in silence, and resumes when the uploader is back', async () => {
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
    assert.equal(notWatching, null, `this run is not a viewer who was watching when the uploader died: ${notWatching}`);

    const recovery = result.recovery;
    assert.ok(recovery, 'the refusal above should already have caught an artifact with no fault verdict');

    const wrongFreeze = freezeRefusal(recovery, {
      minFreezeMs: MIN_FREEZE_MS,
      maxFreezeMs: MAX_FREEZE_MS,
      minBufferMs: MIN_BUFFER_MS,
    });
    assert.equal(wrongFreeze, null, `the picture did not stop the way a dead uploader stops it: ${wrongFreeze}`);

    const notBack = resumeRefusal(recovery, { expectRecovery: true, withinMs: MAX_RESUME_MS });
    assert.equal(notBack, null, `the uploader-crash recovery fix no longer holds under a real viewer: ${notBack}`);

    // ⛔ Issue #100, asserted as the behaviour the deployment HAS rather than the one it should have.
    // Read the docblock before changing this: a red here is the overlay having started speaking, which
    // is the fix landing, and the right response is to move the expectation and file the new reading.
    const spoke = frozenOverlayRefusal(recovery, { told: [] });
    assert.equal(spoke, null, `the overlay's silence during an uploader crash has changed: ${spoke}`);
  });
});
