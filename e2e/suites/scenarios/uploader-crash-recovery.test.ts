import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import { announcedSessionTopics, parseUploaderLog } from '../../src/harness/logwatch.js';
import { checkPublishedTimeline, publishingRungFeedsOf } from '../../src/harness/manifestContractLive.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { type CatalogFeed, discoverCatalogFeed, entryCarriesTopic, fetchCatalog } from '../../src/harness/viewer.js';
import { sleep, waitFor } from '../../src/harness/wait.js';

/**
 * Scenario F — uploader hard crash mid-stream; the same live stream must recover AND keep running.
 *
 * REQUIRES the PR #10 recovery fix deployed: StreamOrchestrator.handleSegment now cancels the
 * recovery finalize timer when segments resume. WITHOUT the fix a hard-crash-recovered stream
 * resumes uploading but the 60s recovery timer still VODs it (SRS never re-sends on_publish), so
 * the final assertion fails — that is the pre-fix behaviour, not a flake.
 *
 * SIGKILL (docker kill) leaves the RecoveryStore state intact; the test then restarts the container
 * (docker kill does not trip the restart policy in this environment, so we stand in for it);
 * recoverStreams restores the stream + a 60s timer; SRS keeps POSTing segments (it was not
 * restarted, so seq_no keeps climbing) → handleSegment accepts them and cancels the timer.
 *
 * ⭐ The playlist the recovered session keeps writing is read at the end and held to the manifest
 * contract. It is the same playlist a viewer is already reading, so its numbering has to survive the
 * crash: a media sequence that moved backwards is what hls.js reports as a parsing error, and the
 * client answers that by remounting the player at the start of the broadcast. See
 * `src/harness/manifestContractLive.ts`.
 */

const RECOVERY_TIMEOUT_MS = 60_000; // mirrors the uploader RECOVERY_TIMEOUT default
const WARMUP_SEGMENTS = 4;
const WARMUP_WAIT_MS = 120_000;
const REBOOT_WAIT_MS = 60_000;
const RESUME_WAIT_MS = 120_000;
const POST_TIMEOUT_MARGIN_MS = 20_000;
// The recovered stream is live on the uploader immediately, but that state reaches the
// gateway-served catalog on the deferred single-node push path — allow minutes for it to surface.
const LIVE_VISIBLE_WAIT_MS = 300_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('F — uploader hard crash: same stream recovers and keeps running', () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let feed: CatalogFeed;
  let startedAt: string;

  const safeFetch = async () => {
    try {
      return await fetchCatalog(host, cfg, feed);
    } catch {
      return [];
    }
  };
  const uploaded = async (): Promise<number[]> =>
    parseUploaderLog(await host.logsSince(uploader, startedAt)).uploadedSegments;

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    feed = await discoverCatalogFeed(host, cfg);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
  });

  it('resumes the recovered stream and does not VOD it at the recovery timeout', async () => {
    await waitFor(async () => (await uploaded()).length >= WARMUP_SEGMENTS, {
      timeoutMs: WARMUP_WAIT_MS,
      intervalMs: 3_000,
      label: 'stream is live and uploading before the crash',
    });
    // Identify our broadcast by the topics the uploader assigned in its OWN log — authoritative and
    // lag-free. Reading them from the gateway catalog here can latch a stale topic from a prior
    // stream while that eventually-consistent catalog is still catching up. A set, because a ladder
    // announces one topic per rung and any of them identifies this broadcast's catalog entry.
    const ourTopics = new Set(announcedSessionTopics(await host.logsSince(uploader, startedAt)));
    assert.ok(ourTopics.size > 0, 'the uploader must have announced a live topic before the crash');
    const preKill = Math.max(...(await uploaded()));

    // Hard crash: SIGKILL leaves the RecoveryStore state on disk. `docker kill` does not trip the
    // restart policy here, so bring the container back explicitly (standing in for the restart
    // policy / orchestrator rebooting a crashed process). The publisher keeps streaming throughout.
    await host.kill(uploader);
    await waitFor(async () => !(await host.isRunning(uploader)), {
      timeoutMs: 15_000,
      intervalMs: 1_000,
      label: 'uploader container fully stopped after the kill',
    });
    await host.start(uploader);
    await waitFor(
      async () => {
        try {
          return (await uploaderHealth(host, cfg)).status === 'ok';
        } catch {
          return false;
        }
      },
      { timeoutMs: REBOOT_WAIT_MS, intervalMs: 2_000, label: 'uploader reboots after the hard crash' },
    );

    // Segments resume — SRS was not restarted, so its seq_no keeps climbing past the pre-crash max.
    await waitFor(
      async () => {
        const ups = await uploaded();
        return ups.length > 0 && Math.max(...ups) > preKill;
      },
      { timeoutMs: RESUME_WAIT_MS, intervalMs: 3_000, label: 'segments resume after recovery' },
    );

    // Wait past the recovery timeout, then assert on the AUTHORITATIVE, lag-free signal: the uploader
    // must still track the stream as active. If the timer had VOD-ed it, stopStream would have removed
    // it from activeStreams. (The gateway catalog cannot gate this — being eventually-consistent, a
    // stale 'live' could mask a real VOD, i.e. a false pass.)
    await sleep(RECOVERY_TIMEOUT_MS + POST_TIMEOUT_MARGIN_MS);
    const health = await uploaderHealth(host, cfg);
    assert.ok(
      health.activeStreams >= 1,
      `the recovered stream must stay active past the recovery timeout, not be VOD-ed by the timer; activeStreams=${health.activeStreams}`,
    );

    // End-to-end: it is genuinely live (asserted above), so it must also surface as live to a viewer
    // through the gateway — poll for it, since that catalog trails the uploader by minutes.
    await waitFor(async () => (await safeFetch()).find((e) => entryCarriesTopic(e, ourTopics))?.state === 'live', {
      timeoutMs: LIVE_VISIBLE_WAIT_MS,
      intervalMs: 3_000,
      label: 'the recovered stream surfaces as live in the gateway catalog',
    });

    // ⛔ A recovered session keeps publishing into the SAME playlist a viewer is already reading, so
    // its timeline has to survive the crash: `restoreState` takes the sequences back off disk rather
    // than recomputing them, and `sequenceFor` treats an index below the anchor from there as the
    // engine's counter restarting and continues FORWARDS. A playlist whose numbering moved backwards
    // is what hls.js reports as a parsing error, and the client answers that by remounting the player
    // at the beginning of the broadcast. Nothing until now read the playlist to find out.
    //
    // ⚠️ **What a red here may be saying, and it is not a flake.** SRS posts each closed segment once
    // and never retries, so the segments it closed while the uploader was dead are lost, and nothing
    // on the SRS path arms a discontinuity for them: `handleSegment` does not look at the index it is
    // handed, `pendingDiscontinuity` comes back off disk as whatever it was before the kill, and
    // `handleSegmentLoss` is the OME puller's. So the join can be a gap of several fragments with no
    // `#EXT-X-DISCONTINUITY` in front of it, which is a playlist promising a viewer media it does not
    // name. It reaches this assertion only while the join is still inside the live window, which is
    // about 31 segments here, and this read comes after the recovery timeout plus the gateway
    // catalog's own lag, so ordinarily the join has long slid out. If it does go red on that, read the
    // reason: it names the segment and the width of the gap, and it is a statement about the product
    // rather than about this file.
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
    const verdict = await checkPublishedTimeline(host, cfg, {
      owner: feed.owner,
      rungs: publishingRungFeedsOf(await log()),
      expectation: cfg.segmentExpectation,
      logAfterTheRead: log,
    });

    console.log(verdict.summary);
    assert.equal(verdict.refusal, null, verdict.refusal ?? '');
  });
});
