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
 * ## ⛔ No timing is asserted
 *
 * Owner ruling of 2026-08-29: an e2e suite checks feature correctness and stability, and performance
 * is a separate kind of test. This once held the freeze between 3 and 45 seconds, required 3s of
 * buffer and required the resume inside 20s. Live on the four rung ladder the freeze read 57.1s and
 * the case went red for a configuration difference, not a broken feature. The resume figure is the
 * one worth watching, since the 0.8a fix moved it from 46.7s to 2.3s, so it is measured on every arm,
 * printed in the summary line and filed in the artifact. It no longer refuses a run.
 *
 * ## ⚠️ The known gap this REPORTS rather than asserts: issue #100, the overlay says nothing
 *
 * The picture stopped for 13.5 seconds and `FeedStateOverlay` rendered nothing at all, so the viewer
 * sat in front of a frozen frame that still claimed to be live. That is not what the product should
 * do and it IS what the product does. #100 traced it to `UNSERVED_SLOT_POLL_LIMIT` counting polls
 * whose rate collapses during the stall the limit exists to detect, so the threshold is never reached
 * while it matters. The other route into a message, the `degraded` burst, does not save it either:
 * one long continuous freeze is a single playback stall rather than the four in twenty seconds that
 * state needs.
 *
 * ⭐ **So the silence is printed, and only a FALSE message fails.** This used to assert the silence
 * exactly, which meant a fix for #100 turned the case red for the product improving. Under the owner
 * ruling of 2026-08-29 a correctness suite goes green when the product gets better, so the client
 * finding its voice here passes and the run's own line says which of the two happened.
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
 * The states that are TRUE of a viewer whose uploader has died, and it is all three non-terminal ones.
 *
 * The gateway is up and answering the whole time, so `stalled` is the literal reading: the slot the
 * player waits on is empty because nothing is writing into it. `degraded` is true of the same viewer
 * by a different route, if the picture keeps stopping. `reconnecting` is included because a read that
 * fails for its own reasons during the outage is not this suite's business to police, and it says
 * nothing false to a viewer either: their picture stopped and the client is retrying.
 *
 * ⛔ `ended` is the lie. The broadcaster never stopped, the uploader comes back and so does the
 * picture, so a viewer told the broadcast is over leaves one that is still running.
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

  it('waits without being told anything untrue, and resumes when the uploader is back', async () => {
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

    // ⭐ The contract: the process comes back and so does the picture, without a reload. How long
    // that took is the 0.8a recovery fix's own figure, and it is in the summary above rather than
    // held against a ceiling here. See the docblock.
    const notBack = resumeRefusal(recovery, { expectRecovery: true });
    assert.equal(notBack, null, `the viewer never got their picture back after the uploader returned: ${notBack}`);

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
