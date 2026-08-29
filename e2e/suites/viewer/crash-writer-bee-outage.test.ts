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
 * ## ⛔ The known gap this asserts: issue #100, the overlay says nothing
 *
 * The picture stopped for 29.5 seconds and `FeedStateOverlay` rendered nothing, the same silence V7
 * asserts and the same mechanism: `UNSERVED_SLOT_POLL_LIMIT` counts polls whose rate collapses during
 * the stall it exists to detect. Half a minute of frozen frame with no explanation is the worst
 * instance of it in the matrix. The silence is asserted exactly, so this case turns red the day the
 * overlay starts speaking, which is the fix landing.
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

/** The broadcast has to be established before a viewer joins it, or the join is what gets broken. */
const WARMUP_SEGMENTS = 4;
const SEGMENT_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
// Module scope, so an undeclared run fails the file during import rather than skipping into silence.
const skip = viewerGate(cfg.viewerExpectation, backend);

describe("V9 — a viewer plays through the discontinuity a writer's outage arms", { skip }, () => {
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

    const recovery = result.recovery;
    assert.ok(recovery, 'the refusal above should already have caught an artifact with no fault verdict');

    // ⭐ The whole question `bee-outage-long` could not answer: hls.js was told the timeline broke,
    // and this is whether it carried on across the break or stalled on being told. A pass or a fail
    // here is that, and nothing about how long the crossing took.
    const notBack = resumeRefusal(recovery, { expectRecovery: true });
    assert.equal(notBack, null, `the viewer did not play through the discontinuity: ${notBack}`);

    // ⛔ Issue #100 again, and its worst instance: half a minute of frozen frame explained by nothing.
    // Asserted as the behaviour the deployment HAS. A red here is the overlay having started to speak,
    // and the right response is to move the expectation and file the new reading.
    const spoke = frozenOverlayRefusal(recovery, { told: [] });
    assert.equal(spoke, null, `the overlay's silence during a writer outage has changed: ${spoke}`);
  });
});
