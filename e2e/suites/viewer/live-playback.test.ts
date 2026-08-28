import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { byteSourceFromEnv, WEEB3_BYTES } from '../../src/browser/fetchBackendSweep.js';
import { containerName, loadConfig } from '../../src/config.js';
import { runBrowserArm } from '../../src/harness/browser.js';
import { viewerPlaybackRefusal, weeb3ArmRefusal } from '../../src/harness/browserVerdict.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import { ladderRungs, parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { waitFor } from '../../src/harness/wait.js';
import { requireByteSource, viewerGate } from '../../src/viewerCoverage.js';

/**
 * V1 — a real viewer watches a live broadcast and keeps up with it.
 *
 * ## What is new here
 *
 * Every viewer leg of this suite was an HTTP poll: something fetched a manifest, or a segment, and
 * concluded that a viewer could have. This opens a real Chrome on the deployed client, lets hls.js
 * choose what to play, and reads the player's own numbers back. The difference is not academic. The
 * bench has measured capture-to-fetchable for months, and a viewer watches neither the fetchable edge
 * nor the gateway: they watch whatever their player chose, which sits a further target-latency behind.
 *
 * ## What this asserts, and what it deliberately does not
 *
 * It asserts that a viewer got a picture that kept up: no fatal player error, playback advancing with
 * the wall clock, and a decoded resolution to show something arrived. When the run is an in-tab arm it
 * also asserts the arm was that condition, because a weeb-3 arm's headline is a near-zero and a
 * client that never switched produces the same near-zero.
 *
 * ⛔ It asserts NOTHING about how far behind live the player sat. That number is printed and filed,
 * and turning it into a threshold is a product decision about what latency this deployment promises,
 * which is not a call this suite gets to make. See `docs/bench` for what it has actually been.
 *
 * ⛔ Requires a deployed profile, a funded stamp and the browser image on the host, like every suite
 * under `suites/`. Nothing in CI runs these. See `src/harness/browser.ts` for the launch contract.
 */

/**
 * How long the viewer watches.
 *
 * `byte-source-arms.sh` refuses an arm under two minutes as "too short for a player to reach steady
 * state", and its own default is six. Four keeps the join, which is a seek and a catch-up, from
 * dominating the ratio below, without buying more broadcast than the question needs.
 */
const WATCH_MINUTES = 4;

/**
 * The lowest share of wall clock the picture may keep up with and still count as watched.
 *
 * Judged on `overallAdvanceRatio`, which is media delivered per wall second with stalls included, so
 * the shortfall is time on a frozen frame. The shipping profile has sustained 0.9996 and the largest
 * segments 0.9962, so this is not near what a healthy run produces: it is set to pass a session that
 * lost a few seconds to its join seek or a single rebuffer, and to fail one that spent a twentieth of
 * its life stopped.
 */
const MIN_ADVANCE_RATIO = 0.95;

/**
 * The most `/bytes/` requests an in-tab arm may make across the whole run.
 *
 * An arm reads through the gateway while its own node boots, so the honest figure is a handful rather
 * than a zero: a ladder arm measured 6 against a gateway viewer's 500. Single digits is the boundary
 * between "the node served the video" and "the gateway did".
 */
const MAX_WEEB3_SEGMENT_REQUESTS = 9;

/** The broadcast has to be established before a viewer joins it, or the join is what gets measured. */
const WARMUP_SEGMENTS = 4;
const SEGMENT_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
// Module scope, so an undeclared run fails the file during import rather than skipping into silence.
const skip = viewerGate(cfg.viewerExpectation, backend);

describe('V1 — a viewer watches a live broadcast in a real browser', { skip }, () => {
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
    await publisher?.stop();
  });

  it('keeps up with a live broadcast, and is the condition it is filed as', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 3_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments published before a viewer joins`,
    });
    // Printed rather than asserted: which rungs exist is `abr-ladder.test.ts`'s question, and this
    // one is about the viewer. It is here because a resolution below only means something beside it.
    console.log(`  publishing rungs: ${ladderRungs(await log()).join(', ') || 'one rendition'}`);

    const source = requireByteSource(backend);
    const result = await runBrowserArm(host, cfg, { backend: source, watchMinutes: WATCH_MINUTES });

    console.log(
      `  watched ${result.watchUrl} for ${result.samples} samples: advance ${result.advanceRatio.toFixed(3)}, ` +
        `${result.rebufferCount} rebuffers, ${result.resolutions.join(' → ') || 'no resolution'}, ` +
        `${result.behindLive.medianS?.toFixed(2) ?? '—'}s behind live, ${result.segmentRequests} segment requests`,
    );

    const notWatched = viewerPlaybackRefusal(result, { minAdvanceRatio: MIN_ADVANCE_RATIO });
    assert.equal(notWatched, null, `this run is not a viewer who watched the broadcast: ${notWatched}`);

    // ⛔ The switch must have taken in either condition. A switch that silently did nothing puts both
    // arms on one, every metric agrees, and the run reports that an in-tab node performs exactly like
    // a gateway. That is the most attractive headline here, produced by nothing happening.
    assert.equal(
      result.proof.reported,
      result.proof.requested,
      `the client was asked for ${result.proof.requested} and reports ${result.proof.reported}`,
    );

    if (source !== WEEB3_BYTES) {
      return;
    }
    const notInTab = weeb3ArmRefusal(result, { maxSegmentRequests: MAX_WEEB3_SEGMENT_REQUESTS });
    assert.equal(notInTab, null, `this arm is not the in-tab condition it claims: ${notInTab}`);
  });
});
