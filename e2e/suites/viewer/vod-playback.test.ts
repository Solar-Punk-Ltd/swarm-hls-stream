import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { containerName, loadConfig } from '../../src/config.js';
import { runBrowserArm } from '../../src/harness/browser.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import { announcedLiveStreams, announcedVodFinalizeCount, parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
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
 * How much broadcast to record before stopping.
 *
 * ⭐ Enough that a truncated recording is visible. A recording missing its last segment out of three
 * is within any honest tolerance, and out of twenty it is not.
 */
const RECORD_SEGMENTS = 20;
const SEGMENT_WAIT_MS = 300_000;
const VOD_WAIT_MS = 120_000;
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

  it('plays back whole, from a finished timeline, offering every rung it was published as', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
    const segments = async (): Promise<number> => parseUploaderLog(await log()).uploadedSegments.length;

    await waitFor(async () => (await segments()) >= RECORD_SEGMENTS, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 3_000,
      label: `recording: ${RECORD_SEGMENTS} segments before the broadcast is stopped`,
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
    const announced = announcedLiveStreams(finalLog).at(-1);
    assert.ok(announced, 'the uploader announced no stream, so there is no recording to address');

    // ⭐ The broadcast's own length, from the segments the uploader says it published, rather than
    // from wall clock. Wall clock includes the settle before the first segment and the drain after
    // the last, and neither is media a viewer can reach.
    const publishedS = parseUploaderLog(finalLog).uploadedSegments.length * declaredSegmentSeconds();

    const result = await runBrowserArm(host, cfg, {
      backend: requireByteSourceForVod(backend),
      watchMinutes: WATCH_MINUTES,
      vod: { owner: announced.owner, topic: announced.topic },
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
      `  observations, none of them asserted. ${RECORD_SEGMENTS}+ segments published over ` +
        `${((broadcastEndedAtMs - Date.parse(startedAt)) / 1000).toFixed(1)}s of wall clock, ` +
        `${publishedS.toFixed(1)}s of media, and the recording reports ${vod.durationS?.toFixed(1)}s`,
    );
  });
});

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
