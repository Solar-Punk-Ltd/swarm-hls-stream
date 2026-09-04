import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { FEED_STATE_ENDED } from '../../src/browser/feedState.js';
import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { containerName, loadConfig } from '../../src/config.js';
import { runBrowserArm } from '../../src/harness/browser.js';
import { byteSourceArmRefusal, ladderResolutionRefusal } from '../../src/harness/browserVerdict.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { announcedVodFinalizeCount, parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { sleep, waitFor } from '../../src/harness/wait.js';
import { requireByteSource, viewerGate } from '../../src/viewerCoverage.js';

/**
 * V5 — a viewer watching when the broadcaster stops is told the broadcast has ended.
 *
 * ## The thing this is about
 *
 * `publish-stop-to-vod.test.ts` already proves the stack finalizes a VOD when the broadcaster stops.
 * It reads the uploader's log, so what it can see is that the service did the right thing. It cannot
 * see whether anybody watching found out. Those are different outcomes: a viewer left on a frozen
 * last frame with a spinner reloads or leaves, and a viewer told the broadcast has ended does neither.
 * `FeedStateOverlay` renders one terminal message for exactly this, and until now nothing asserted
 * that a viewer ever reaches it.
 *
 * ## What this asserts
 *
 * That the viewer decoded a picture, that the quality they were served is one the deployment's
 * ladder declares, that the bytes came from the byte source this run is filed under, and that they
 * reached the terminal ended state once the broadcast finalised as a recording.
 *
 * ## ⛔⛔⛔ The byte source, which this asked nothing about until 2026-09-04
 *
 * Every viewer suite but two refused an in-tab arm whose segments came from the gateway after all.
 * This was one of the two that did not, while `runBrowserArm` recorded the proof on every one
 * of its arms. So an in-browser run whose in-tab node never served a byte passed exactly like one
 * whose node served all of them, and every V5 in-tab result before this date says only that A viewer
 * was told the broadcast ended, never that a viewer reading through the node in their own tab was.
 *
 * ⭐ That is the same failure `src/browser/byteSourceArm.ts` was written to close one layer down: an
 * unread setting looks precisely like a setting at its default.
 *
 * ## ⛔ Why this buys its own broadcast rather than riding V1's
 *
 * It would be cheaper to end V1's broadcast under V1's viewer. It is not possible as the suite is
 * structured: `node --test` runs each file in its own process, so V1's publisher and its browser arm
 * are not reachable from here, and folding the two cases into one file would make a viewer scenario
 * that could only ever assert one of them, since ending the broadcast is the last thing that happens
 * to it. The cost is one short broadcast, and it is named in the constants below.
 *
 * ⛔ Requires a deployed profile, a funded stamp and the browser image on the host, like every suite
 * under `suites/`. Nothing in CI runs these.
 */

/**
 * How long the viewer watches in total.
 *
 * Sized as the lead below plus the tail the ending needs. Everything outside the measured window,
 * the container start and the player's join, is budgeted separately by the harness.
 */
const WATCH_MINUTES = 6;

/**
 * How long after the arm is launched the broadcaster stops.
 *
 * ⛔ Measured from the launch rather than from playback, because nothing outside the container can
 * see playback start: the driver prints that line, and the harness holds one call open for the whole
 * arm. So this has to cover the container start, the catalog discovery the client allows a minute
 * for, and the join, and still land on a viewer who is genuinely watching. Two and a half minutes is
 * generous against those, and the tail below is what the budget actually protects.
 */
const BEFORE_STOP_MS = 150_000;

/**
 * What is left of the watch after the stop, which is the window the ending has to arrive in.
 *
 * Not a constant to tune: it is stated so the arithmetic is visible, and checked below so a change to
 * either number above cannot silently leave the viewer watching a broadcast that never ends inside
 * its own window. `publish-stop-to-vod.test.ts` allows the VOD finalize 90 seconds, and the client
 * then has to poll and re-render, so the tail is several times that.
 */
const MIN_TAIL_MS = 180_000;

/**
 * The most `/bytes/` requests an in-tab arm may make across the whole watch.
 *
 * ⭐ Nine, the same ceiling V1 holds a live watch to, because this is the same driver on the same
 * window. `browser:watch` opens the arm between playback starting and the first sample and judges
 * its request log from the end of the settle, exactly as V1's does, so the reads that reach this
 * count are the ones the in-tab node's boot legitimately makes through the gateway while 4.5 MB of
 * wasm loads and a peer is dialled. Measured on that path: a ladder arm made 6 where a gateway
 * viewer made 500, and live in-tab arms have read 3 to 6 across every sitting since.
 *
 * ⛔ Neither of this case's two differences from V1 adds a gateway read, which is why the number is
 * not raised for them. The watch is six minutes rather than four, and the extra two are spent after
 * the switch, so they buy node reads and not gateway ones. And the broadcast ENDS partway through:
 * once it has, no rung publishes another segment, so there is nothing left for a starved player to
 * fetch from anywhere. A viewer sitting in the ended state makes no segment request at all.
 */
const MAX_WEEB3_SEGMENT_REQUESTS = 9;

/** The broadcast has to be established before it is worth ending. */
const WARMUP_SEGMENTS = 4;
const SEGMENT_WAIT_MS = 180_000;
const VOD_WAIT_MS = 90_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
// Module scope, so an undeclared run fails the file during import rather than skipping into silence.
const skip = viewerGate(cfg.viewerExpectation, backend, cfg.browserRepoDir);

describe('V5 — the viewer is told when the broadcast ends', { skip }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let startedAt: string;

  before(async () => {
    assert.ok(
      WATCH_MINUTES * 60_000 - BEFORE_STOP_MS >= MIN_TAIL_MS,
      `the viewer would have ${(WATCH_MINUTES * 60_000 - BEFORE_STOP_MS) / 1000}s of watching left after the ` +
        `broadcaster stops, against the ${MIN_TAIL_MS / 1000}s the ending needs to reach them. This case ` +
        'would fail on its own arithmetic rather than on the product.',
    );
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
  });

  it('reaches the ended state after the broadcaster stops cleanly', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 3_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments published before a viewer joins`,
    });

    // Not awaited yet. The arm holds one call open for the whole watch, and the whole point of this
    // case is that the broadcast ends underneath a viewer who is already watching it.
    const arm = runBrowserArm(host, cfg, { backend: requireByteSource(backend), watchMinutes: WATCH_MINUTES });
    // ⛔ Marks the arm handled without consuming it. If the VOD wait below times out, nothing would
    // ever await this promise, and a browser arm that then failed would surface as an unhandled
    // rejection: node ends the whole run on one, so a timeout here would take every later suite with
    // it and report as a crash rather than as this case failing. `await arm` still throws.
    arm.catch(() => undefined);

    await sleep(BEFORE_STOP_MS);
    console.log(`  stopping the broadcaster ${BEFORE_STOP_MS / 1000}s into the viewer's watch`);
    await publisher.stop();

    // Scoped to our own broadcast: a neighbour's flip trailing into the window must not stand in
    // for the finalize this viewer is waiting to be told about.
    await waitFor(async () => announcedVodFinalizeCount(await log()) >= 1, {
      timeoutMs: VOD_WAIT_MS,
      intervalMs: 2_000,
      label: 'the stream finalizes as a VOD, which is what the viewer has to be told about',
    });

    const result = await arm;
    console.log(`  the viewer passed through: ${result.feedStatesSeen.join(' → ')}`);

    // ⛔ Before the state, because a viewer who never had a picture reaches no state worth reporting
    // and would otherwise fail here with a message about an overlay.
    assert.ok(
      result.resolutions.length > 0,
      'the player never decoded anything, so this viewer never watched the broadcast that ended',
    );
    // ⛔⛔ Before both product readings below, because each is filed against this condition. A
    // switch that silently did nothing puts the two arms of the matrix on one, every metric agrees,
    // and the run reports that an in-tab node tells a viewer the broadcast ended exactly as well as
    // a gateway does. That is the most attractive headline available here, produced by nothing
    // happening.
    const notItsCondition = byteSourceArmRefusal(result, { maxSegmentRequests: MAX_WEEB3_SEGMENT_REQUESTS });
    assert.equal(notItsCondition, null, `this arm is not the byte source it is filed as: ${notItsCondition}`);
    // ⭐ Phase 1 of docs/e2e-viewer-coverage-plan.md. The resolutions were already being captured and
    // printed, so a viewer riding a rung nobody configured passed every suite on a reading that was
    // sitting right there. Asks whether the rung is one the ladder declares, never which one.
    const wrongQuality = ladderResolutionRefusal(result, cfg.abrLadderResolutions);
    assert.equal(
      wrongQuality,
      null,
      `this viewer was served a quality the deployment never configured: ${wrongQuality}`,
    );
    assert.ok(
      result.reachedEndedOverlay,
      `the broadcast finalized as a VOD and the viewer was never told: they passed through ` +
        `${result.feedStatesSeen.join(' → ')} and never reached '${FEED_STATE_ENDED}', so a real viewer ` +
        'is sitting on a frozen last frame deciding whether to reload',
    );
  });
});
