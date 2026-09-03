import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { getEngine } from '../../src/harness/engine.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { checkPublishedTimeline, publishingRungFeedsOf } from '../../src/harness/manifestContractLive.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { type CatalogEntry, type CatalogFeed, discoverCatalogFeed, fetchCatalog } from '../../src/harness/viewer.js';
import { sleep, waitFor } from '../../src/harness/wait.js';

/**
 * Scenario E — media-engine restart mid-stream; the broadcaster must be able to resume. Runs against
 * whichever engine E2E_ENGINE selects (SRS or OME); only the restarted container and the reconnect
 * grace differ — the recovery behaviour under test is engine-agnostic.
 *
 * REQUIRES the PR #10 recovery fix deployed: StreamOrchestrator.startStream now finalizes a stale
 * re-announced session and starts a fresh one, instead of rejecting it. Against an uploader WITHOUT
 * the fix the reconnect is rejected ("already active") and no new stream ever appears, so this test
 * times out — that is the pre-fix behaviour, not a flake.
 *
 * Restarting the engine drops ffmpeg's SRT (no auto-reconnect) so the first publisher dies. When a
 * new broadcaster session connects, the engine re-announces the publish; the uploader finalizes the
 * stale session as a VOD and starts a fresh live stream — a new, distinct catalog entry via the gateway.
 *
 * ⭐ This is where the two numbers a segment carries come apart, so the resumed session's playlists
 * are read and held to the manifest contract. SRS's own segment counter carries on across the
 * restart, six recordings of this stage having opened at 210, 317, 416, 580, 707 and 850, while the
 * resumed broadcast's playlist has to open at `#EXT-X-MEDIA-SEQUENCE:0`. No uploader log line carries
 * the playlist's number, by design. See `src/harness/manifestContractLive.ts`.
 */

const WARMUP_WAIT_MS = 90_000;
const RESUME_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('E — media-engine restart: broadcaster resumes', () => {
  const engine = getEngine(cfg);
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const mediaContainer = engine.mediaContainer(cfg);
  let first: Publisher;
  let second: Publisher;
  let feed: CatalogFeed;
  let baselineTopics: Set<string>;

  const safeFetch = async () => {
    try {
      return await fetchCatalog(host, cfg, feed);
    } catch {
      return [];
    }
  };
  // A ladder entry's own topic is the master feed's, which is the group and SURVIVES an engine
  // death (the group is only released once every rung's session ends). The fresh identity of a new
  // session lives in the rung topics under `renditions`, so freshness is judged over every topic an
  // entry carries, not the entry's own alone.
  const topicsOf = (entry: CatalogEntry): string[] => [
    entry.topic,
    ...(entry.renditions ?? []).map((rendition) => rendition.topic),
  ];
  const freshLiveTopics = async (): Promise<string[]> => [
    ...new Set(
      (await safeFetch())
        .filter((entry) => entry.state === 'live')
        .flatMap(topicsOf)
        .filter((topic) => !baselineTopics.has(topic)),
    ),
  ];

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    feed = await discoverCatalogFeed(host, cfg);
    await waitForIdle(host, cfg);
    // Deliberately NOT the swallowing `safeFetch`. A failed read here yields an empty baseline, and
    // an empty baseline makes every entry look new — including the previous scenario's, which is
    // still `live` on the gateway because these suites run serially and that catalog lags by
    // minutes. The wait below would then latch onto a stream this test never published. The read
    // carries an 8s deadline while these tests budget 300s for the gateway, so it timing out is the
    // ordinary case rather than an exotic one. On the polls `safeFetch` stays, because there "not
    // ready yet" is a real answer.
    baselineTopics = new Set((await fetchCatalog(host, cfg, feed)).flatMap(topicsOf));
    first = startPublisher(cfg);
  });

  after(async () => {
    await first?.stop();
    await second?.stop();
    await host.start(mediaContainer).catch(() => undefined);
  });

  it('starts a fresh live stream when the broadcaster reconnects after an engine restart', async () => {
    let firstTopic: string | undefined;
    await waitFor(
      async () => {
        const topics = await freshLiveTopics();
        if (topics.length >= 1) {
          firstTopic = topics[0];
        }
        return firstTopic !== undefined;
      },
      { timeoutMs: WARMUP_WAIT_MS, intervalMs: 3_000, label: 'first stream goes live before the engine restart' },
    );

    // Stamped before the restart, so the log window below holds the RESUMED session alone. The
    // retired session's announces and segments are all in front of this instant, and counting them
    // as the resumed broadcast's would make every recovered playlist look like a window that had
    // already slid. See `logAfterTheRead` in `manifestContractLive.ts`.
    const restartedAt = await host.nowIso();
    await host.restart(mediaContainer);
    await first.stop();
    await sleep(engine.reconnectGraceMs); // let the engine accept SRT again before reconnecting

    second = startPublisher(cfg);

    let resumedTopic: string | undefined;
    try {
      await waitFor(
        async () => {
          const topics = (await freshLiveTopics()).filter((t) => t !== firstTopic);
          if (topics.length >= 1) {
            resumedTopic = topics[0];
          }
          return resumedTopic !== undefined;
        },
        {
          timeoutMs: RESUME_WAIT_MS,
          intervalMs: 3_000,
          label: 'a fresh live stream appears after the broadcaster reconnects',
        },
      );
    } catch (error) {
      // A timeout here has three unrelated causes: the uploader never restarted the session, the
      // catalog write never landed, or the gateway is lagging. The bare label cannot tell them
      // apart, so the failure carries what the catalog actually held at the end of the wait.
      const entries = (await safeFetch()).map((entry) => ({
        topic: entry.topic.slice(0, 8),
        state: entry.state,
        fresh: !baselineTopics.has(entry.topic),
      }));
      const seen = ` Catalog at timeout (topic/state/fresh): ${JSON.stringify(entries)}; firstTopic=${firstTopic?.slice(
        0,
        8,
      )}`;
      throw error instanceof Error ? new Error(error.message + seen) : error;
    }

    assert.ok(
      resumedTopic && resumedTopic !== firstTopic,
      'reconnecting after an engine restart must yield a new live stream, not a rejection',
    );

    // ⭐ The resumed broadcast is a fresh session with a fresh anchor, so its FIRST playlist opens at
    // `#EXT-X-MEDIA-SEQUENCE:0` while the engine's own counter carries on from wherever the restart
    // left it. That is the whole point of the two numbers being separate, and the log cannot show it:
    // every uploader line names the engine's index. Read here from the restart's own window, so the
    // retired session's segments are not counted against the resumed session's playlist.
    const resumedLog = async (): Promise<string> => host.logsSince(uploader, restartedAt);
    const verdict = await checkPublishedTimeline(host, cfg, {
      owner: feed.owner,
      rungs: publishingRungFeedsOf(await resumedLog()),
      expectation: cfg.segmentExpectation,
      logAfterTheRead: resumedLog,
    });

    console.log(verdict.summary);
    assert.equal(verdict.refusal, null, verdict.refusal ?? '');
  });
});
