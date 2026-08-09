/**
 * `pnpm make:recording` — produce a finished recording long enough to be worth seeking around in,
 * with a discontinuity at a known point, and print what a playback run needs to address it.
 *
 * ## Why this exists
 *
 * Phase 1.2 left two questions unreached, and the roadmap blamed the harness for both: seeking **past
 * a discontinuity**, and seeking into a region **whose chunks have left the local gateway**. Neither
 * is a harness gap. `browser:vod` already seeks to 0.5, 0.9 and then back to 0.2 of the duration, so
 * it crosses anything sitting in the middle, forwards and backwards.
 *
 * ⭐ **What was missing is the recording.** Every recording this project had was 27 seconds, which
 * fits in the player's buffer whole, so the harness asked both questions and the player answered
 * neither: nothing was retrieved during a seek because everything was already held.
 *
 * So this makes the artifact rather than another instrument. It publishes, takes the writer's bee node
 * away for longer than the uploader's retry window so a discontinuity is armed mid-recording,
 * publishes for as long again, and stops cleanly into a VOD.
 *
 * ⚠️ **`stop` rather than `kill` on the bee node**, for the reason `faults.ts` gives: a SIGKILL risks
 * the database of the node holding the postage batch every measurement is paid for with.
 *
 * Usage, from the repo root against a deployed profile:
 *
 *     E2E_PROFILE=latbench E2E_PORT_SLOT=7 pnpm make:recording
 *
 * It prints `BROWSER_VOD_OWNER` and `BROWSER_VOD_TOPIC` for the playback run, and where in the
 * recording the discontinuity landed so a report can say which seeks crossed it.
 */

import { envNumber } from '../src/browser/runFiles.js';
import { containerName, loadConfig } from '../src/config.js';
import { discoverStamp, makeHost, waitForIdle } from '../src/harness/host.js';
import { announcedLiveStreams, parseUploaderLog } from '../src/harness/logwatch.js';
import { startPublisher } from '../src/harness/publisher.js';
import { waitFor } from '../src/harness/wait.js';

/**
 * ⚠️ **A segment here is one GOP, not one `hls_fragment`.**
 *
 * SRS cuts at the first keyframe at or after `hls_fragment`, and `startPublisher` encodes at
 * `-g fps*2`, so against the shipping 0.25s fragment the publisher's two second GOP is what decides
 * the length: each segment is ~2s, not 0.25s. Counting these as fragments makes a recording **eight
 * times longer and eight times more expensive** than intended, which is the whole reason this is
 * written down rather than left as a number.
 *
 * 45 either side is therefore about **three minutes of media**, comfortably past the ~6s the player
 * buffers, so every seek below has to retrieve rather than replay what it already holds.
 */
const BEFORE_SEGMENTS = 45;
/** Segments after it, so the discontinuity sits near the middle and seeks cross it in both directions. */
const AFTER_SEGMENTS = 45;
/**
 * How long the writer's node stays down.
 *
 * Longer than `MANIFEST_UPLOAD_RETRY_WINDOW_MS` (15s), which is what makes the uploader give up on the
 * segment in flight and arm `#EXT-X-DISCONTINUITY`. Shorter and the segments merely buffer and flush,
 * which is scenario A and leaves no discontinuity to seek across.
 */
const OUTAGE_MS = 20_000;
const SEGMENT_WAIT_MS = 600_000;
const VOD_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const beeUploader = containerName(cfg, 'bee-uploader');
  const before = envNumber('RECORDING_BEFORE_SEGMENTS', BEFORE_SEGMENTS);
  const after = envNumber('RECORDING_AFTER_SEGMENTS', AFTER_SEGMENTS);

  const stamp = await discoverStamp(host, cfg);
  if (stamp.batchTTL <= MIN_STAMP_TTL_S) {
    throw new Error(`stamp TTL ${stamp.batchTTL}s is too low to run a stream`);
  }
  await waitForIdle(host, cfg);

  const startedAt = await host.nowIso();
  const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
  const uploaded = async (): Promise<number[]> => parseUploaderLog(await log()).uploadedSegments;

  const publisher = startPublisher(cfg);
  let beeIsDown = false;
  try {
    console.log(`recording: publishing ${before} segments before the outage`);
    await waitFor(async () => (await uploaded()).length >= before, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 5_000,
      label: `${before} segments before the outage`,
    });

    const beforeOutage = (await uploaded()).length;
    console.log(`recording: taking ${beeUploader} away for ${OUTAGE_MS / 1000}s to arm a discontinuity`);
    await host.stop(beeUploader);
    beeIsDown = true;
    await new Promise((resolve) => setTimeout(resolve, OUTAGE_MS));
    await host.start(beeUploader);
    beeIsDown = false;

    console.log(`recording: publishing ${after} more segments past the discontinuity`);
    await waitFor(async () => (await uploaded()).length >= beforeOutage + after, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 5_000,
      label: `${after} segments after the outage`,
    });

    const events = parseUploaderLog(await log());
    if (events.discontinuitiesArmed === 0) {
      // Reported rather than tolerated: a recording with no discontinuity answers a different
      // question from the one this was made for, and a playback run against it would look like a
      // pass. See scenario A — an outage inside the retry window buffers and flushes instead.
      throw new Error(
        'the outage armed no discontinuity, so this recording cannot answer whether a viewer seeks ' +
          'across one. The node came back inside the retry window.',
      );
    }
    console.log(`recording: ${events.discontinuitiesArmed} discontinuity(s) armed after ${beforeOutage} segments`);
  } finally {
    await publisher.stop();
    if (beeIsDown) {
      await host.start(beeUploader).catch(() => undefined);
    }
  }

  await waitFor(async () => /Updating stream in list to VOD/.test(await log()), {
    timeoutMs: VOD_WAIT_MS,
    intervalMs: 3_000,
    label: 'the broadcast finalizes into a recording',
  });

  const announced = announcedLiveStreams(await log()).at(-1);
  if (!announced) {
    throw new Error('the uploader announced no stream, so the recording cannot be addressed');
  }

  const total = (await uploaded()).length;
  console.log('');
  console.log('recording ready. To play it back and seek across the discontinuity:');
  console.log('');
  console.log(`  BROWSER_VOD_OWNER=${announced.owner} \\`);
  console.log(`  BROWSER_VOD_TOPIC=${announced.topic} \\`);
  console.log('  pnpm browser:vod');
  console.log('');
  console.log(`  segments: ${total}, discontinuity after roughly ${((100 * before) / total).toFixed(0)}% of them`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
