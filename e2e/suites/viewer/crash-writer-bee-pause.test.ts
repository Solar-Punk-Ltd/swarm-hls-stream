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
 * V8 — the bee node the uploader writes through is frozen for less time than it can retry.
 *
 * ## What this promotes
 *
 * Arm 4 of the crash matrix, `docs/bench/crash-at-an-in-tab-viewer-2026-08-27.md`. An eight second
 * pause, which is shorter than the uploader's fifteen second retry window, so segments buffer and
 * flush rather than being lost. `suites/scenarios/bee-outage-short.test.ts` already proves the
 * indices stay gapless and no discontinuity is armed, with nobody watching. What had never been asked
 * is whether it reaches a viewer at all.
 *
 * ## What this asserts
 *
 * That the viewer was watching, that they are watching again once the node is unpaused, that nothing
 * untrue was put in front of them while their picture was stopped, and that the timeline they came
 * back to is unbroken. That last one is the discontinuity, asked here of the run this viewer actually
 * sat through rather than of a separate broadcast nobody watched.
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
 * ## Why the overlay saying nothing is tolerated here
 *
 * Two reasons, and the second is the durable one. At the 3.1s this fault used to cost, a message
 * that appears and vanishes inside three seconds is noise rather than help, so silence is what a
 * viewer should get. At the 58.9s the ladder cost, it is issue #100 instead: the gateway keeps
 * answering and only the slot is empty, so the counter that would catch it is
 * `UNSERVED_SLOT_POLL_LIMIT`, whose poll rate collapses during exactly the stall it exists to detect,
 * and one long freeze is a single playback stall rather than the burst `degraded` needs.
 *
 * ⭐ Either way silence is printed rather than refused, and a FALSE message is what fails. This used
 * to assert the silence exactly, so a client that started explaining the fault turned the case red
 * for improving.
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

/**
 * The states that are TRUE of a viewer whose writer node paused, and it is all three non-terminal ones.
 *
 * The gateway answers throughout, so `stalled` is the literal reading of an empty slot while nothing
 * is being written. `degraded` reaches the same viewer by the other route, and `reconnecting` is not
 * this suite's to police: whichever of the three appears, a viewer reads that their picture stopped
 * and the client is working on it, which is what is happening.
 *
 * ⛔ `ended` is the lie. The pause is shorter than the uploader's retry window, so nothing is even
 * lost, and a viewer told the broadcast is over would leave one that never stopped.
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

  it('is watching an unbroken timeline again once the node is unpaused', async () => {
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

    // ⭐ Nothing untrue, and silence tolerated for two reasons at once. See the docblock.
    const untrue = frozenOverlayRefusal(recovery, { truthful: TRUTHFUL_WHILE_FROZEN, mustSpeak: false });
    assert.equal(untrue, null, `the client told this viewer something untrue about their picture: ${untrue}`);
    console.log(
      `  observed, not asserted: the client ${
        recovery.explainedTheFreeze ? 'explained the pause' : 'said NOTHING while the picture was stopped'
      }`,
    );

    // ⭐ The other half of what this viewer is owed, and the only correctness question here that a
    // duration used to stand in for. The pause is shorter than the uploader's retry window, so the
    // segment in flight is buffered and flushed rather than dropped, and a discontinuity armed anyway
    // would put a break in the timeline of the viewer who just sat through it.
    // `suites/scenarios/bee-outage-short.test.ts` asks the same of the uploader with nobody watching.
    const armed = parseUploaderLog(await log()).discontinuitiesArmed;
    assert.equal(
      armed,
      0,
      `${armed} discontinuit(y/ies) were armed across a pause shorter than the uploader's retry window, ` +
        'so this viewer was handed a broken timeline by an outage that should have cost them nothing',
    );
  });
});
