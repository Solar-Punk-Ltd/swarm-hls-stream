import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { containerName, loadConfig } from '../../src/config.js';
import { runBrowserArm } from '../../src/harness/browser.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import {
  announcedSessionTopics,
  announcedVodFinalizeCount,
  segmentIndicesByStream,
} from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import {
  type CatalogEntry,
  type CatalogFeed,
  discoverCatalogFeed,
  entryCarriesTopic,
  fetchCatalog,
} from '../../src/harness/viewer.js';
import {
  finishedTimelineRefusal,
  pictureMovedRefusal,
  playedBackRefusal,
  vodArmRefusal,
  vodArmSummary,
  wholeBroadcastRefusal,
  wholeLadderRefusal,
} from '../../src/harness/vodArm.js';
import { waitFor } from '../../src/harness/wait.js';
import { viewerGate } from '../../src/viewerCoverage.js';

/**
 * V4 — a finished ladder recording, opened by a real player and played through.
 *
 * ## ⛔ What was never asked
 *
 * `suites/scenarios/publish-stop-to-vod.test.ts` proves the uploader finalises a recording, from the
 * uploader's own log, with nobody watching. `pnpm browser:vod` proves a recording starts and can be
 * seeked around, from a person reading its report. Neither says what a viewer actually gets.
 *
 * ⛔⛔ **A ladder recording whose master resolved and whose upper rung playlists did not plays
 * perfectly at its bottom rung.** It starts, the duration is finite, the seeks land, the picture
 * moves. Every reading either of those two takes would call it a pass. The rung list is the only
 * thing that separates them, and until 2026-08-30 nothing read it.
 *
 * ## What this asserts
 *
 * That the recording played, that the player was handed a FINISHED timeline rather than a live one,
 * that the recording offers every rung the deployment published, that the timeline covers the whole
 * broadcast, and that a picture actually moved.
 *
 * ## ⛔⛔ Why the recording is found through the CATALOG
 *
 * Because on a ladder there is nothing else to find it by. **A ladder deployment emits no
 * `Adding stream to list` live announce at all**, which is why `announcedSessionTopics` falls back to
 * rung announces, and a rung announce carries the rung's own session topic and no owner. The first
 * version of this suite read `announcedLiveStreams` the way `browser/make-recording.ts` does and
 * found nothing, on 2026-08-30, live.
 *
 * ⭐ The catalog is also the honest path. A viewer clicks a card, and a card carries the owner, the
 * MASTER topic (the ladder group, which is the entry topic a `swarm://` link holds), and one
 * rendition per rung. Reading it gives a second, independent check of the ladder alongside the
 * player's own.
 *
 * ## ⛔ Why this publishes its own broadcast rather than reusing one
 *
 * The suite has to know how long the broadcast ran to say whether the recording is the whole of it.
 * A recording found lying on the stack has no known length, so `wholeBroadcastRefusal` could not be
 * asked at all, and a truncated recording would pass on every other reading.
 *
 * ## ⛔ No timing is asserted
 *
 * Owner ruling of 2026-08-29. How fast a seek landed is measured, printed and filed.
 *
 * ⛔ Requires a deployed profile, a funded stamp and the browser image on the host, like every suite
 * under `suites/`. Nothing in CI runs these.
 */

/**
 * How much MEDIA to record before stopping, in seconds.
 *
 * ⭐ Enough that a truncated recording is visible. A recording missing its last segment out of three
 * is within any honest tolerance, and out of sixty it is not.
 *
 * ⛔ Media seconds rather than a segment count, because the two stages cut at different lengths: 30s
 * is 60 segments on the light-client stage and 15 on the in-browser one. A count would record four
 * times as much on one as the other and mean something different on each.
 */
const RECORD_MEDIA_SECONDS = 30;
const SEGMENT_WAIT_MS = 300_000;
const VOD_WAIT_MS = 120_000;
/**
 * How long the finished entry may take to reach the catalog through the gateway.
 *
 * The catalog is a feed write through the same bee node the segments went through, so it trails the
 * uploader's own log line by however long the pusher takes to drain. `multi-stream-concurrent`
 * budgets the same and calls it an accepted propagation-latency budget rather than a defect.
 */
const CATALOG_WAIT_MS = 300_000;
const MIN_STAMP_TTL_S = 600;

/** The playback arm's own budget. The driver settles for seconds and seeks three times. */
const WATCH_MINUTES = 3;

const cfg = loadConfig();
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
// Module scope, so an undeclared run fails the file during import rather than skipping into silence.
const skip = viewerGate(cfg.viewerExpectation, backend);

describe('V4 — a finished recording plays through, with the whole ladder it was published as', { skip }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let startedAt: string;
  let feed: CatalogFeed;

  /**
   * This broadcast's finished entry, once the catalog carries it.
   *
   * ⛔ Polled rather than read once. The catalog is a feed write through the same bee node the
   * segments went through, so it trails the uploader's own finalize log line by however long the
   * pusher takes to drain, which `multi-stream-concurrent` budgets minutes for.
   */
  const waitForRecording = async (location: CatalogFeed, ours: ReadonlySet<string>): Promise<CatalogEntry> => {
    let found: CatalogEntry | undefined;
    await waitFor(
      async () => {
        const entries = await fetchCatalog(host, cfg, location).catch(() => []);
        found = entries.find((candidate) => entryCarriesTopic(candidate, ours) && candidate.state === 'vod');
        return found !== undefined;
      },
      { timeoutMs: CATALOG_WAIT_MS, intervalMs: 5_000, label: 'the recording reaches the catalog as a VOD' },
    );
    return found as CatalogEntry;
  };

  before(async () => {
    const stamp = await discoverStamp(host, cfg);
    assert.ok(stamp.batchTTL > MIN_STAMP_TTL_S, `stamp TTL ${stamp.batchTTL}s too low to run a stream`);
    await waitForIdle(host, cfg);
    // ⛔ Before the broadcast, so a discovery that needs an old catalog line does not depend on this
    // run having already produced one.
    feed = await discoverCatalogFeed(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
  });

  it('plays back whole, from a finished timeline, offering every rung it was published as', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

    await waitFor(async () => mediaSecondsPublished(await log()) >= RECORD_MEDIA_SECONDS, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 3_000,
      label: `recording: ${RECORD_MEDIA_SECONDS}s of media before the broadcast is stopped`,
    });

    // ⛔ Measured either side of the stop rather than from the publisher's own start. What the
    // recording has to cover is the media that was published, and the seconds before the first
    // segment was cut are not in it.
    const broadcastEndedAtMs = Date.now();
    await publisher.stop();

    await waitFor(async () => announcedVodFinalizeCount(await log()) >= 1, {
      timeoutMs: VOD_WAIT_MS,
      intervalMs: 2_000,
      label: 'the broadcast finalises as a recording',
    });

    const finalLog = await log();
    const ours = new Set(announcedSessionTopics(finalLog));
    assert.ok(
      ours.size > 0,
      'the uploader announced no session topics, so this broadcast cannot be told from a neighbour and ' +
        'there is nothing to address a recording by',
    );

    // ⛔ Matched on the session topics this broadcast announced, never on "the newest entry". This
    // host carries other people's sittings, and a neighbour's recording finalising inside the window
    // would otherwise be the one played back.
    const entry = await waitForRecording(feed, ours);

    // ⭐ The catalog's own view of the ladder, which is independent of the player's. An entry naming
    // fewer renditions than the deployment published is a recording finalised incomplete, and it
    // reaches a viewer as a master with rungs missing rather than as a broken card.
    const named = entry.renditions ?? [];
    assert.equal(
      named.length,
      cfg.abrRungs.length,
      `the catalog entry names ${named.length} renditions (${named.map((r) => r.name).join(', ') || 'none'}) ` +
        `and the deployment publishes ${cfg.abrRungs.length}. A viewer opening this card gets the ladder ` +
        'the catalog describes, whatever was actually written',
    );

    // ⭐ The broadcast's own length, from the segments the uploader says it published, rather than
    // from wall clock. Wall clock includes the settle before the first segment and the drain after
    // the last, and neither is media a viewer can reach.
    const publishedS = mediaSecondsPublished(finalLog);

    const result = await runBrowserArm(host, cfg, {
      backend: requireByteSourceForVod(backend),
      watchMinutes: WATCH_MINUTES,
      vod: { owner: entry.owner, topic: entry.topic },
    });
    console.log(`  ${vodArmSummary(result)}`);

    // ⛔ First. It settles whether the browser was a usable instrument and whether this artifact is a
    // recording being played rather than a live watch.
    const notPlayback = vodArmRefusal(result);
    assert.equal(notPlayback, null, `this run is not a player opening a finished recording: ${notPlayback}`);

    const vod = result.vod;
    assert.ok(vod, 'the refusal above should already have caught an arm with no playback verdict');

    // ⛔ The headline. Everything below is a reading of a recording that played.
    const neverPlayed = playedBackRefusal(vod);
    assert.equal(neverPlayed, null, `the recording did not play: ${neverPlayed}`);

    // ⛔ Before the ladder and the length. A live playlist reports an infinite duration, and seeking
    // around inside a moving window would make every reading below about a target that had shifted.
    const stillLive = finishedTimelineRefusal(vod);
    assert.equal(stillLive, null, `the player was not handed a finished recording: ${stillLive}`);

    // ⭐⭐ The assertion this file exists for.
    const shortLadder = wholeLadderRefusal(
      vod,
      cfg.abrLadder.map((rung) => rung.height),
    );
    assert.equal(shortLadder, null, `this recording is not the ladder it was published as: ${shortLadder}`);

    const truncated = wholeBroadcastRefusal(vod, publishedS);
    assert.equal(truncated, null, `this recording is not the whole broadcast: ${truncated}`);

    const nothingShown = pictureMovedRefusal(result);
    assert.equal(nothingShown, null, `nothing was actually shown: ${nothingShown}`);

    console.log(
      `  observations, none of them asserted. ${publishedS.toFixed(1)}s of media published over ` +
        `${((broadcastEndedAtMs - Date.parse(startedAt)) / 1000).toFixed(1)}s of wall clock, and the ` +
        `recording reports ${vod.durationS?.toFixed(1)}s`,
    );
  });
});

/**
 * How many seconds of MEDIA the broadcast published, off the uploader's own log.
 *
 * ⛔⛔ Per rung-stream, and taking the widest. `uploadedSegments` counts every rung, so on a four rung
 * ladder it is four times the media that exists and a recording would be judged against a broadcast
 * four times longer than the one that happened. Every ladder recording would fail as truncated, and
 * the failure would name the recording rather than this arithmetic.
 *
 * ⭐ The widest rather than the sum or the mean: each rung carries the WHOLE broadcast, so the
 * longest one is the broadcast, and a rung that lagged behind at the moment of the stop does not
 * shorten it.
 */
function mediaSecondsPublished(text: string): number {
  const perStream = [...segmentIndicesByStream(text).values()].map((indices) => indices.length);
  const longest = perStream.length === 0 ? 0 : Math.max(...perStream);
  return longest * declaredSegmentSeconds();
}

/**
 * How long one segment is, as the run declared it.
 *
 * ⛔ Required rather than defaulted. Multiplying a segment count by a guessed length gives a
 * broadcast duration nobody chose, and `wholeBroadcastRefusal` would then compare the recording
 * against it and pass or fail on the guess. `suites/preflight/segment-length.test.ts` refuses an
 * undeclared run before any broadcast starts, so reaching this is a defect in the gate.
 */
function declaredSegmentSeconds(): number {
  const declared = cfg.segmentExpectation;
  if (typeof declared !== 'number') {
    throw new Error(
      `this run declares E2E_EXPECT_SEGMENT_S as '${declared}', so a segment count cannot be turned into ` +
        'a broadcast length and whether the recording is the whole of it cannot be asked. The segment ' +
        'preflight should have refused this run before it published anything.',
    );
  }
  return declared;
}

/**
 * The byte source a playback arm is filed under.
 *
 * ⛔ Its own function rather than `requireByteSource`, because a recording run is not a byte-source
 * comparison and the driver takes no side of one. What it still must not do is file a reading against
 * an unnamed condition, so the gate is the same.
 */
function requireByteSourceForVod(source: ReturnType<typeof byteSourceFromEnv>): NonNullable<typeof source> {
  if (source === null) {
    throw new Error(
      'a playback case ran with no byte source named, which the coverage gate should have refused. Set ' +
        'BROWSER_FETCH_BACKEND, and treat this as a defect in the gate rather than in the run.',
    );
  }
  return source;
}
