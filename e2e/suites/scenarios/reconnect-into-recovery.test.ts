import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { getEngine } from '../../src/harness/engine.js';
import { makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import {
  announcedSessionTopics,
  maxSegmentIndexByStream,
  parseUploaderLog,
  segmentIndicesByStream,
  streamsUploadingBelow,
  vodFinalizeCountFor,
} from '../../src/harness/logwatch.js';
import {
  checkPublishedTimeline,
  fragmentSecondsFor,
  publishingRungFeedsOf,
} from '../../src/harness/manifestContractLive.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { recoveryEntryIds } from '../../src/harness/uploaderState.js';
import { type CatalogFeed, discoverCatalogFeed, entryCarriesTopic, fetchCatalog } from '../../src/harness/viewer.js';
import { sleep, waitFor } from '../../src/harness/wait.js';

/**
 * Scenario M — the uploader dies while its engine restarts, and the broadcaster comes back to it.
 *
 * ## The bug this exists to prove fixed
 *
 * Finding 1 of `docs/reviews/2026-09-05-cross-provider-review.md`. When the uploader boots holding a
 * recovery entry it restores the stream, seeds the duplicate filter with every segment index the
 * entry carries, and arms a 60 second timer that finalizes the broadcast if nothing comes back. If
 * the engine opens a NEW publish session for that stream id inside the window,
 * `StreamOrchestrator.startStream` takes its recovery branch, which is the block around
 * `recoveryTimers.get(streamId)`.
 *
 * Before `2d86b84` that branch cancelled the timer and returned with the restored filter still in
 * place, and the new session does not carry the old numbering on. Both shipped engines number
 * segments per session and the engine restarts beside the kill, so the arrivals after
 * the reconnect open near zero. Every one of them that the restored filter already held was answered
 * `accepted` without being uploaded, the engine therefore never retried, and the accounting index
 * sitting above the new counter meant no loss was inferred either. **The new session's opening was
 * simply gone**, out of the playlist a viewer was reading, with nothing in the log calling it an
 * error. The fix starts the filter fresh in that branch and forgets the accounting index.
 *
 * ## Why the uploader is killed and not restarted, and why the engine is restarted beside it
 *
 * Reaching the branch needs two things at once: an uploader that boots holding a recovery entry, and
 * an engine whose counter has gone back to zero so the reconnected session's indexes land inside the
 * range the entry carries.
 *
 * ⛔ **A `docker restart` of the uploader gives neither the first.** It delivers SIGTERM, and the
 * uploader's graceful shutdown stops every live stream, which finalizes each one to VOD and removes
 * its recovery entry, all inside docker's ten second grace. Measured on the live stage on 2026-09-07:
 * `Received SIGTERM` at 02:18:29.9Z, `finalized to VOD` at 02:18:34.7Z, and the container that came
 * back logged no `Recovering` line at all. The publisher that then reconnected opened a fresh
 * broadcast on fresh topics, numbered from zero with no break, which is the correct outcome of a
 * graceful stop and says nothing about finding 1. The first live run of this suite, written with a
 * whole-stack `docker restart`, went red on exactly that. So the uploader is killed, SIGKILL through
 * `host.kill`, the way `uploader-crash-recovery` (F) does it, which leaves the recovery entry on disk,
 * and it is started again by hand because `docker kill` does not trip the restart policy on this
 * stage.
 *
 * The engine is restarted at the same moment, SIGTERM through `host.restart`, because a reconnect
 * into a warm engine continues its numbering and the two ranges never overlap. The bee nodes stay up:
 * they have no part in finding 1, and a SIGKILL to a node risks its database.
 *
 * ## Why scenario I cannot see it
 *
 * `whole-stack-restart.test.ts` restarts every container gracefully and its publisher never comes
 * back. The graceful stop finalizes the broadcast before the containers are even down, no
 * `on_publish` follows, and the recovery branch is never entered. What I asserts is the opposite
 * outcome, one VOD and no recovery entry left behind, which is right for a broadcaster who never
 * returns. The two are complementary rather than duplicates: only M reaches the branch.
 *
 * ## Why the warm-up is 40 segments and not the four scenario I uses
 *
 * The swallow is as wide as the overlap between the restored filter and the restarted counter, so
 * with the bug in place it costs about as much media as the session before the restart had produced.
 * Forty segments is eighty seconds of broadcast where this stage cuts two second fragments and forty
 * where it cuts one, which is a stretch of missing media nobody could read as a hiccup, against the
 * eight seconds four segments would have made it.
 *
 * ⭐ **What makes the first assertion refuse under the bug is not the width, and it is worth being
 * exact about that.** With the filter carried across, the first index the uploader ever logs an
 * upload for is one past the maximum the recovered session reached, so nothing below that maximum
 * appears at all and the wait times out however wide the warm-up was. The width decides how loud the
 * failure is and, more usefully, how likely the two counters are to overlap in the first place: a
 * wider pre-restart range is a wider target for a counter reopening near zero to land inside.
 *
 * Counted per rung and never on the merged view, for the reason `service/abr-ladder` records: four
 * rungs are four independent counters, and one fast rung can satisfy a merged target on its own.
 *
 * ⚠️ **Whether the bug could have bitten this particular run is printed, not assumed.** The overlap
 * is the whole mechanism, and a session that opened on a warm engine at index 850 and a restarted
 * counter opening at 0 do not overlap at all: every index of the reconnected session is one the
 * filter never held, so it is taken whether the branch resets the filter or not. SRS's counter goes
 * back to zero only when the source is reaped, so where the broadcast before this one left it decides
 * the regime. The run says which regime it was in beside the assertions rather than claiming a proof
 * it was not in a position to make.
 *
 * ## What is asserted
 *
 * - **The restarted counter is taken.** Some stream that existed before the restart uploads, after
 *   the reconnect, at an engine index BELOW the maximum it had reached. That upload is the one the
 *   old duplicate filter swallowed, and it is the only one of these four that tells the fixed
 *   uploader from the one the review read.
 * - **The broadcast is still one live broadcast.** No VOD flip is announced for the topics this
 *   broadcast opened on, and `/health` keeps reporting a live stream, across 90 seconds from the
 *   reconnect, which is the 60 second recovery timer plus margin. The recovered session keeps the
 *   topic the recovery entry carried, so these are the same topics throughout and a flip on one of
 *   them would mean the reconnect ended the broadcast instead of continuing it.
 *
 *   ⛔ **This one is not the bug's signature and must not be read as one.** With the filter carried
 *   across, the swallowed indexes still arrive, so `streamIngestAt` keeps moving and the stall reaper
 *   never fires, and the recovery timer was cancelled by the reconnect itself. Nothing finalizes. The
 *   bug's whole visible effect is the missing media, which is the bullet above. This bullet is here
 *   because a reconnect ending the broadcast rather than continuing it is the other way the scenario
 *   can fail, and no existing suite would catch it.
 * - **A viewer is still offered a live stream.** The catalog entry carrying one of those topics is
 *   polled across the same window and must not turn `vod`.
 * - **The playlists are sound across the join.** `checkPublishedTimeline` refuses nothing, at least
 *   one `#EXT-X-DISCONTINUITY` is there because the engine's counter restarted and
 *   `ManifestManager.placeInBroadcast` re-anchors a restarted counter forwards with a break, and
 *   there are no `#EXT-X-GAP` entries, because the forgotten accounting index must not turn that
 *   counter restart into a hole the broadcast never had. A restart is one of the only two things
 *   that still arm a break since the owner's ruling of 2026-09-06, the other being the origin
 *   declaring one, and a lost segment is now said with gap entries instead.
 *
 * ⛔ The uploader writes `Resumed recovering stream` when it takes the branch, but that line is not
 * part of the shared log contract in `packages/shared/src/uploaderLog.ts` and the deployed-log-shape
 * preflight does not confirm it, so nothing here reads it. The branch is proved by its effects.
 *
 * ⭐ The timeline is read as soon as the break lands and before the 90 second live watch, on purpose.
 * The live window is bounded at `LIVE_WINDOW_MAX_BYTES`, about thirty segments, so a break ninety
 * seconds old has slid out of the playlist and a read taken after the watch would refuse a correct
 * product for a tag that had simply aged out.
 *
 * ⛔ Requires a deployed profile and a funded stamp. It buys one broadcast of roughly five minutes.
 * The full suite runs `suites/scenarios/*.test.ts` by glob, so this joins every full sitting with no
 * script change, and `pnpm e2e:reconnect-into-recovery` runs the gates and this suite alone.
 */

/** Per rung, and forty to eighty seconds of broadcast depending on the length the stage cuts. See the docblock. */
const WARMUP_SEGMENTS = 40;
const WARMUP_WAIT_MS = 300_000;
/** The kill, the engine restart and the uploader coming back up, which is seconds with the bee nodes untouched. */
const RESTART_WAIT_MS = 180_000;
/**
 * How late the reconnect may be and still land inside the recovery window.
 *
 * ⛔ A refusal about the HARNESS and never about the product, which is why it is here rather than
 * among the observations. The recovery timer is 60 seconds and it starts when the uploader recovers
 * the stream, marginally before it answers `/health` at all. A reconnect later than this is a
 * scenario that finalized the broadcast on the timer and then watched a fresh session start, which
 * is scenario I with extra steps and not this one.
 */
const RECONNECT_DEADLINE_MS = 45_000;
const RESUMED_UPLOAD_WAIT_MS = 180_000;
const TIMELINE_WAIT_MS = 120_000;
const CATALOG_WAIT_MS = 300_000;
/** The 60 second recovery timer plus margin, counted from the reconnect. */
const STAYS_LIVE_MS = 90_000;
const LIVE_WATCH_INTERVAL_MS = 5_000;
const MIN_STAMP_TTL_S = 600;

/** `35..74`, or the word for a stream the window holds no upload for. */
function describeRange(indices: readonly number[] | undefined): string {
  if (indices === undefined || indices.length === 0) {
    return 'nothing';
  }
  return `${Math.min(...indices)}..${Math.max(...indices)}`;
}

const cfg = loadConfig();

describe('M — the uploader dies while its engine restarts, then the broadcaster reconnects: the recovered stream continues', () => {
  const host = makeHost(cfg);
  const engine = getEngine(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const mediaContainer = engine.mediaContainer(cfg);
  /** Every rung of the ladder, or the one stream a single-rendition deployment publishes. */
  const expectedStreams = cfg.abrEnabled ? cfg.abrRungs.length : 1;
  let publisher: Publisher;
  let feed: CatalogFeed;
  let startedAt: string;

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    feed = await discoverCatalogFeed(host, cfg);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    // The uploader was started again inside the test and the engine was restarted rather than
    // stopped, so the stage is whole, and the broadcast finalizes on its own once the broadcaster is
    // gone. Started once more here only if the kill was the last thing that happened to it.
    await publisher?.stop();
    if (!(await host.isRunning(uploader))) {
      await host.start(uploader).catch(() => undefined);
    }
  });

  it('takes the reconnected session at its restarted counter and keeps the broadcast live', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
    const safeCatalog = async () => fetchCatalog(host, cfg, feed).catch(() => []);

    await waitFor(
      async () => {
        const uploadedPerStream = [...segmentIndicesByStream(await log()).values()];
        return (
          uploadedPerStream.length >= expectedStreams &&
          uploadedPerStream.every((indices) => indices.length >= WARMUP_SEGMENTS)
        );
      },
      {
        timeoutMs: WARMUP_WAIT_MS,
        intervalMs: 3_000,
        label: `warmup: each of the ${expectedStreams} publishing streams uploads ${WARMUP_SEGMENTS} segments, which is the width the swallowed window would have had`,
      },
    );

    const beforeTheRestart = await log();
    const indicesBefore = segmentIndicesByStream(beforeTheRestart);
    const maximumsBefore = maxSegmentIndexByStream(beforeTheRestart);
    // A set, because a ladder announces one topic per rung and the catalog entry carries one of them.
    // These stay the broadcast's topics across the restart: `recoverStream` rebuilds the session from
    // the topic the recovery entry carried, and the recovery branch of `startStream` announces
    // nothing of its own, so nothing new is minted for the reconnect.
    const ourTopics = new Set(announcedSessionTopics(beforeTheRestart));
    assert.ok(ourTopics.size > 0, 'the uploader must have announced a live topic before the restart');

    const entriesBefore = await recoveryEntryIds(host, cfg);
    assert.ok(
      entriesBefore.length > 0,
      'a live broadcast must have a recovery entry, or the kill leaves nothing for a reconnect to rejoin',
    );

    // The fault, both halves at once: SIGKILL to the uploader so its recovery entry stays on disk, and
    // a graceful restart of the engine so its counter goes back to zero. See the docblock for why a
    // graceful stop of the uploader would leave nothing to recover.
    console.log(`  M: killing ${uploader} and restarting ${mediaContainer} together`);
    const restartedAtMs = Date.now();
    await Promise.all([host.kill(uploader), host.restart(mediaContainer)]);
    await waitFor(async () => !(await host.isRunning(uploader)), {
      timeoutMs: RESTART_WAIT_MS,
      intervalMs: 1_000,
      label: 'the uploader container is fully stopped after the kill',
    });
    // `docker kill` does not trip the restart policy on this stage, so the uploader is started by hand,
    // exactly as scenario F does it. Its boot is what restores the stream and arms the recovery timer.
    await host.start(uploader);

    await waitFor(
      async () => {
        try {
          return (await uploaderHealth(host, cfg)).status !== undefined;
        } catch {
          return false;
        }
      },
      {
        timeoutMs: RESTART_WAIT_MS,
        intervalMs: 3_000,
        label: 'the uploader answers again after the kill',
      },
    );
    const answeredAtMs = Date.now();

    // The reconnect. The engine took the broadcaster's SRT with it and neither engine reconnects on
    // its own, so the dying publisher is stopped and a fresh one started after the engine's own
    // grace, the way `abr-engine-restart` does it.
    await publisher.stop();
    await sleep(engine.reconnectGraceMs);
    // Taken before the publisher starts, so no upload of the new session can fall outside the
    // window. Nothing else can be in it: the uploader restarted, so it has nothing queued to drain.
    const reconnectedAt = await host.nowIso();
    publisher = startPublisher(cfg);
    const reconnectedAtMs = Date.now();
    const reconnectLagMs = reconnectedAtMs - answeredAtMs;

    console.log(
      `  M: the uploader answered ${((answeredAtMs - restartedAtMs) / 1000).toFixed(1)}s after the kill, and the ` +
        `broadcaster reconnected ${(reconnectLagMs / 1000).toFixed(1)}s after that`,
    );
    assert.ok(
      reconnectLagMs <= RECONNECT_DEADLINE_MS,
      `the harness took ${(reconnectLagMs / 1000).toFixed(1)}s to reconnect the broadcaster after the uploader ` +
        `answered, past the ${RECONNECT_DEADLINE_MS / 1000}s this scenario allows itself. That is this harness ` +
        'being too slow and not the product failing: the recovery timer is 60s, so a reconnect this late lands ' +
        'after the broadcast was finalized, and everything below would be reading a fresh session rather than ' +
        'the recovered one. Nothing about the uploader is claimed either way',
    );

    const sinceReconnect = async (): Promise<string> => host.logsSince(uploader, reconnectedAt);

    // ⭐ The assertion the scenario exists for. An index below what this stream had already reached
    // is the engine's counter having restarted, and the uploader logging an upload for it is the
    // restored duplicate filter having been let go of.
    await waitFor(async () => streamsUploadingBelow(await sinceReconnect(), maximumsBefore).length > 0, {
      timeoutMs: RESUMED_UPLOAD_WAIT_MS,
      intervalMs: 3_000,
      label:
        "the reconnected session's segments were swallowed as duplicates of the recovered session's. Nothing " +
        'uploaded below the index its stream had already reached, which is what a duplicate filter carried ' +
        'across the recovery branch does to a counter that restarted',
    });

    // ⛔ Read before the live watch below, not after it. The live window is byte bounded, so a break
    // ninety seconds old has slid out of the playlist and this would refuse a correct product for a
    // tag that aged out. See the docblock.
    const timeline = async () =>
      checkPublishedTimeline(host, cfg, {
        owner: feed.owner,
        // From the whole window and not from the reconnect's. The recovery branch announces nothing,
        // so the only lines naming this broadcast's feeds are the ones it wrote before the restart.
        rungs: publishingRungFeedsOf(await log()),
        expectation: cfg.segmentExpectation,
        logAfterTheRead: log,
      });

    let verdict = await timeline();
    // ⚠️ The same guard scenario F's wait for a hole carries. A run that pinned no segment length
    // reads no playlist at all, so `discontinuitiesSeen` is structurally zero and waiting for one
    // would spend the whole window and then red the uploader's recovery path for a check that never
    // ran. Such a run keeps the unchecked verdict, which the summary below prints in place of one.
    const timelineIsChecked = fragmentSecondsFor(cfg.segmentExpectation) !== null;
    try {
      if (timelineIsChecked) {
        await waitFor(
          async () => {
            verdict = await timeline();
            return verdict.discontinuitiesSeen >= 1;
          },
          {
            timeoutMs: TIMELINE_WAIT_MS,
            intervalMs: 5_000,
            label:
              'no rung declared a break after the reconnect. A restarted engine counter is one of the two ' +
              'things that still arm one, because `placeInBroadcast` re-anchors the numbering and the dating ' +
              'forwards rather than reusing a sequence a viewer already holds. This run pinned a segment ' +
              'length, so the playlists really were read and this is the absence of a break rather than the ' +
              'absence of a check',
          },
        );
      }
    } finally {
      // So a timeout still says what the playlists held when it gave up.
      console.log(verdict.summary);
    }

    assert.equal(verdict.refusal, null, verdict.refusal ?? '');

    // ⛔ A hole and a break are different statements, and only one of them belongs to a reconnect.
    // The counter restarting is a break, which the wait above required. It must not ALSO read as
    // media the broadcast lost: the recovery branch forgets the accounting index precisely so the
    // first arrival of the new session measures itself against nothing.
    //
    // ⚠️ The message carries what the uploader itself said it lost in the same window, because a
    // reader has to tell the fabricated hole apart from an honest one. A bee node that restarted
    // with everything else re-syncs its postage batch for tens of seconds, and a segment it refuses
    // in that window is a real loss with real gap entries, and nothing to do with this scenario.
    const losses = parseUploaderLog(await log());
    assert.equal(
      verdict.gapsSeen,
      0,
      `${verdict.gapsSeen} gap entries across the rungs. The uploader reported ` +
        `${losses.inferredSegmentGaps} inferred skips and ${losses.discontinuitySegments.length} failed uploads ` +
        'in the same window. Zero of both beside gap entries is the counter restart being measured as a run of ' +
        'missing segments, which is the inference the recovery branch drops the accounting index to avoid. ' +
        'Anything else is media this broadcast really lost, most likely to a publisher node still re-syncing ' +
        'its batch after the restart, and it is not a fault in the path this scenario tests',
    );

    // The entry was written before the restart, so this waits for the gateway to serve it again
    // rather than for the uploader to write it. A bee node that has just restarted answers nothing
    // for a while, which is a cold read and not a missing broadcast.
    await waitFor(async () => (await safeCatalog()).some((entry) => entryCarriesTopic(entry, ourTopics)), {
      timeoutMs: CATALOG_WAIT_MS,
      intervalMs: 3_000,
      label: 'the catalog serves this broadcast again once the gateway is warm',
    });

    // The live watch. Polled rather than read once because `activeStreams` is not a monotone fact: a
    // broadcast finalized inside the window and never replaced would read zero at the end, but so
    // would one dying at the last second, and only a poll tells them apart.
    const watchUntilMs = reconnectedAtMs + STAYS_LIVE_MS;
    const statusesSeen = new Set<string>();
    const catalogStatesSeen = new Set<string>();
    let lowestActiveStreams: number | null = null;
    let healthReadsThatThrew = 0;
    let catalogReadsThatFoundUs = 0;
    for (;;) {
      try {
        const health = await uploaderHealth(host, cfg);
        statusesSeen.add(health.status);
        lowestActiveStreams = Math.min(lowestActiveStreams ?? health.activeStreams, health.activeStreams);
      } catch {
        healthReadsThatThrew++;
      }
      for (const entry of await safeCatalog()) {
        if (entryCarriesTopic(entry, ourTopics)) {
          catalogStatesSeen.add(entry.state);
          catalogReadsThatFoundUs++;
        }
      }
      if (Date.now() >= watchUntilMs) {
        break;
      }
      await sleep(LIVE_WATCH_INTERVAL_MS);
    }

    assert.ok(
      lowestActiveStreams !== null,
      `no /health read answered across the ${STAYS_LIVE_MS / 1000}s watch, all ${healthReadsThatThrew} of them ` +
        'threw, so nothing about the broadcast staying live was read at all',
    );
    assert.ok(
      lowestActiveStreams >= 1,
      `the uploader reported ${lowestActiveStreams} active streams inside the ${STAYS_LIVE_MS / 1000}s after the ` +
        'reconnect, so the broadcast the reconnect was supposed to continue stopped being live',
    );
    // ⛔ How many reads found the entry is an observation and not an assertion, on purpose. The wait
    // above already showed the catalog serving it, so a read failing inside the watch is a gateway
    // that went cold again rather than a broadcast that left the catalog, and refusing on it would
    // red a correct product for the transport.
    assert.ok(
      !catalogStatesSeen.has('vod'),
      `the catalog entry carrying this broadcast's topic turned vod inside the ${STAYS_LIVE_MS / 1000}s after ` +
        'the reconnect, so a viewer opening it is offered a recording of a broadcast that is still running',
    );

    // ⛔ Read once and at the end, which is enough because a flip is written once and stays in the
    // window. Scoped to this broadcast's own topics, so a neighbour's flip trailing into the window
    // is not read as this one ending. `vodFinalizeCountFor` attributes a ladder flip through the rung
    // announces, which is why the whole window is passed and not the reconnect's.
    assert.equal(
      vodFinalizeCountFor(await log(), [...ourTopics]),
      0,
      'this broadcast was finalized to VOD while its broadcaster was publishing to it, so the reconnect ' +
        'started a second thing rather than continuing the recovered one',
    );

    // Re-read here rather than reused from the wait above, so the ranges below say what each stream
    // has run to and not only where it reopened. The window opens at the same instant either way, so
    // the first index each stream shows is the same number.
    const afterTheReconnect = await sinceReconnect();
    const restartedCounters = streamsUploadingBelow(afterTheReconnect, maximumsBefore);
    const indicesAfter = segmentIndicesByStream(afterTheReconnect);

    // ⭐ Whether this run was in a position to prove anything about finding 1. The bug swallows the
    // opening only where the reconnected counter reopens inside the range the recovered session had
    // run, and a broadcast that opened on a warm engine high above zero does not overlap at all. See
    // the docblock.
    const reopenedInsideTheOldRange = [...maximumsBefore].filter(([streamId, reached]) => {
      const openedAt = indicesAfter.get(streamId)?.[0];
      return openedAt !== undefined && openedAt <= reached;
    });
    const perStream = [...maximumsBefore.keys()]
      .map(
        (id) =>
          `${id} ran ${describeRange(indicesBefore.get(id))} then reopened ${describeRange(indicesAfter.get(id))}`,
      )
      .join(', ');

    console.log(
      `  observations, none of them asserted. ${restartedCounters.length} of ${maximumsBefore.size} streams ` +
        `uploaded below the index they had already reached. Per stream: ${perStream}`,
    );
    console.log(
      `  observations, none of them asserted. ${reopenedInsideTheOldRange.length} of ${maximumsBefore.size} ` +
        'streams reopened at or below the index the recovered session had reached, which is the only regime ' +
        'finding 1 could bite in. Across the ' +
        `${STAYS_LIVE_MS / 1000}s watch the uploader reported ${[...statusesSeen].join(', ') || 'nothing'}, ` +
        `${healthReadsThatThrew} of its reads threw, and ${catalogReadsThatFoundUs} catalog reads found this ` +
        `broadcast holding ${[...catalogStatesSeen].join(', ') || 'nothing'}`,
    );
  });
});
