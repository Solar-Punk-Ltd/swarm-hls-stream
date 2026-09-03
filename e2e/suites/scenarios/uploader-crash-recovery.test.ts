import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import { announcedSessionTopics, parseUploaderLog } from '../../src/harness/logwatch.js';
import {
  checkPublishedTimeline,
  fragmentSecondsFor,
  publishingRungFeedsOf,
} from '../../src/harness/manifestContractLive.js';
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
 * ⭐ **The join the crash leaves is what this scenario is really about.** SRS posts each closed
 * segment to the webhook once and never retries, so the segments it closed while the uploader was
 * dead are gone and nothing reports them. The uploader infers that gap from the index it is handed
 * being above the last it accounted for, arms an `#EXT-X-DISCONTINUITY` for it, and re-anchors the
 * dating across it. So the playlist a viewer is already reading has to hold two things at once: a
 * media sequence that never moved backwards, and a break in front of the join, because a forward
 * date step wider than one fragment is legal only across one. Both are read here while the join is
 * still in the live window, which is what the wait below is for.
 */

const RECOVERY_TIMEOUT_MS = 60_000; // mirrors the uploader RECOVERY_TIMEOUT default
const WARMUP_SEGMENTS = 4;
const WARMUP_WAIT_MS = 120_000;
const REBOOT_WAIT_MS = 60_000;
const RESUME_WAIT_MS = 120_000;
/** How long the uploader is given to report the gap the crash left, once segments are flowing again. */
const GAP_ARMED_WAIT_MS = 60_000;
/**
 * How long the join is given to appear in a published playlist.
 *
 * A feed read costs no BZZ, so this is generous: the arming is in the log by the time it starts, and
 * what is being waited on is one more manifest publish reaching the gateway.
 */
const JOIN_VISIBLE_WAIT_MS = 90_000;
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
  /** Gaps the uploader worked out from the numbering, which on the SRS path is the only kind there is. */
  const gapsInferred = async (): Promise<number> =>
    parseUploaderLog(await host.logsSince(uploader, startedAt)).inferredSegmentGaps;
  const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
  const readTimeline = async () =>
    checkPublishedTimeline(host, cfg, {
      owner: feed.owner,
      rungs: publishingRungFeedsOf(await log()),
      expectation: cfg.segmentExpectation,
      logAfterTheRead: log,
    });

  /**
   * The timeline read once the join is visible in it, so the verdict is about a window that contains
   * the break rather than about whatever the window happened to hold.
   *
   * ⚠️ A run that pinned no segment length checks no timeline at all and can see no break, so
   * waiting for one would spend the whole window for nothing. Such a run returns the unchecked
   * verdict, which is what every other wired suite prints on one.
   */
  const waitForJoinedTimeline = async () => {
    let latest = await readTimeline();
    if (fragmentSecondsFor(cfg.segmentExpectation) === null || latest.discontinuitiesSeen >= 1) {
      return latest;
    }

    await waitFor(
      async () => {
        latest = await readTimeline();
        return latest.discontinuitiesSeen >= 1;
      },
      {
        timeoutMs: JOIN_VISIBLE_WAIT_MS,
        intervalMs: 5_000,
        label: 'the break the crash left is inside a published live window',
      },
    );
    return latest;
  };

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

    // ⛔ The gap the crash left, read as soon as segments are flowing again rather than at the end.
    // Nothing reported those segments, so this family is the only evidence they were accounted for:
    // the whole armed count would be satisfied by a spent retry window on a stage that armed nothing
    // for the crash. A red here says the join reached the playlist as a silent hole.
    await waitFor(async () => (await gapsInferred()) >= 1, {
      timeoutMs: GAP_ARMED_WAIT_MS,
      intervalMs: 3_000,
      label: 'the uploader reports the segments the engine never posted while it was dead',
    });
    console.log(`  ${await gapsInferred()} rung(s) reported a gap the engine never posted`);

    // ⛔ Then the playlist, and only once the join is IN it. The break is what makes the date step
    // across the join legal, so a read taken before the post-crash segments reached the window would
    // be judging a timeline that does not contain the thing under test. This used to be read once at
    // the very end, after the recovery-timeout sleep and the catalog wait, by which time the join had
    // long slid out of the roughly 31 segment window and F said nothing about it at all.
    const joined = await waitForJoinedTimeline();

    console.log(joined.summary);
    assert.equal(joined.refusal, null, joined.refusal ?? '');

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

    // ⛔ The same playlist read again at the end, now that the window has slid past the join. A
    // recovered session keeps publishing into the playlist a viewer is already reading, so its
    // numbering has to keep holding afterwards too: `restoreState` takes the sequences back off disk
    // rather than recomputing them, and an index below the anchor from there is the engine's counter
    // restarting, which continues FORWARDS. A media sequence that moved backwards is what hls.js
    // reports as a parsing error, and the client answers that by remounting the player at the start
    // of the broadcast.
    //
    // ⚠️ **What a red here is saying.** The join itself was judged above, while it was still in the
    // window. A red here is about the segments published since, so read the reason: it names the
    // segment and the date it objected to, and it is a statement about the product rather than about
    // this file.
    const verdict = await readTimeline();

    console.log(verdict.summary);
    assert.equal(verdict.refusal, null, verdict.refusal ?? '');
  });
});
