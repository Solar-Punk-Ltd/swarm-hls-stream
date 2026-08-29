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
 * V8 — the bee node the uploader writes through is frozen for less time than it can retry.
 *
 * ## What this promotes
 *
 * Arm 4 of the crash matrix, `docs/bench/crash-at-an-in-tab-viewer-2026-08-27.md`. An eight second
 * pause, which is shorter than the uploader's fifteen second retry window, so segments buffer and
 * flush rather than being lost. `suites/scenarios/bee-outage-short.test.ts` already proves the
 * indices stay gapless and no discontinuity is armed. What had never been asked is whether it reaches
 * a viewer at all.
 *
 * ⚠️ **The scenario's written expectation and the readings disagree, and this asserts neither.**
 * `browser/faults.ts` declares `expectFreeze: false` and expects a viewer with six seconds of buffer
 * to see nothing at all. The matrix measured a 3.1s freeze, twice: in-tab on 2026-08-27 and through a
 * gateway on 2026-08-06. Then the four rung ladder measured **58.9s** on 2026-08-29, which is what
 * sent the client's manifest retry ceiling from thirty seconds down to eight. Three readings, three
 * different answers, one configuration each. What survives all three, and is what this case now
 * holds, is that the viewer is watching again afterwards. The duration is printed and filed.
 *
 * ## ⛔ No timing is asserted
 *
 * Owner ruling of 2026-08-29. This once capped the freeze at the pause's own eight seconds and the
 * resume at ten. The ladder run read 58.9s and the case went red for a configuration difference: an
 * in-browser node admits roughly one segment per second, so half second segments cap it near half of
 * real time, which is not a defect in this code.
 *
 * ## Why the overlay saying nothing is correct here, and not issue #100
 *
 * 3.1 seconds is under the overlay's horizon. It is meant to explain a stall a viewer would otherwise
 * sit through wondering, and it would be worse at this length: a message that appears and vanishes
 * inside three seconds is noise. That is a different silence from the one V7 and V9 assert, which is
 * #100 and is a defect.
 *
 * ⛔ Requires a deployed profile, a funded stamp and the browser image on the host, like every suite
 * under `suites/`. Nothing in CI runs these.
 */

const SCENARIO = scenarioByName('writer-bee-pause');

/**
 * How much wall clock the arm gets, derived from the fault rather than picked here.
 *
 * It must outlast the driver's whole timeline: the in-tab node's settle, the 45s baseline before the
 * fault, this scenario's own 8s pause, the unpause and the 60s recovery watch.
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

describe("V8 — a viewer barely notices an eight second pause of the writer's node", { skip }, () => {
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
    // ⛔ `unpause` rather than `start`: a paused container is running, so starting it would report
    // success without unfreezing anything. The driver does this itself from a `finally` inside the
    // browser container, which an arm killed by the harness timeout never reaches, and a bee node
    // left frozen holds the postage batch every measurement on this host is paid for with.
    await host.unpause(broken).catch(() => undefined);
  });

  it('is watching again once the node is unpaused, and is told nothing untrue meanwhile', async () => {
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
    // It matters more here than anywhere: this is the case whose expected freeze is nearly nothing,
    // so a run with no viewer in it would look exactly like the best possible outcome.
    const notWatching = crashArmRefusal(result, {
      scenario: SCENARIO.name,
      maxSegmentRequests: MAX_WEEB3_SEGMENT_REQUESTS,
    });
    assert.equal(notWatching, null, `this run is not a viewer who was watching when the node paused: ${notWatching}`);

    const recovery = result.recovery;
    assert.ok(recovery, 'the refusal above should already have caught an artifact with no fault verdict');

    // ⭐ The contract: whatever the pause cost, the viewer is watching again by the end of it. Two
    // outcomes satisfy that and both are correct here, a viewer who never stopped and one who stopped
    // and came back, which is why the scenario's own `expectFreeze: false` is not asserted either way.
    const notBack = resumeRefusal(recovery, { expectRecovery: true });
    assert.equal(notBack, null, `the picture did not come back once the node was unpaused: ${notBack}`);

    // ⭐ Silence, and correctly so: three seconds is under the overlay's horizon, and a message that
    // appears and vanishes inside it would be noise. Not the #100 silence V7 and V9 assert.
    const spoke = frozenOverlayRefusal(recovery, { told: [] });
    assert.equal(spoke, null, `the client now explains a pause short enough that it need not: ${spoke}`);
  });
});
