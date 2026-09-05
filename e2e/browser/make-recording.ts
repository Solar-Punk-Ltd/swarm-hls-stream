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
import { containerName, type E2EConfig, loadConfig } from '../src/config.js';
import { type Host, makeHost, waitForIdle } from '../src/harness/host.js';
import { announcedLiveStreams, parseUploaderLog } from '../src/harness/logwatch.js';
import { startPublisher } from '../src/harness/publisher.js';
import { recordingProgress, recordingSummary } from '../src/harness/recording.js';
import { readStageSegmenting } from '../src/harness/stage.js';
import { requireStageStamps } from '../src/harness/stageStamps.js';
import { waitFor } from '../src/harness/wait.js';
import { stageSegmentSeconds } from '../src/segmentLength.js';

/**
 * ⚠️ **A segment here is one segment of ONE RUNG, and it is one GOP rather than one `hls_fragment`.**
 *
 * SRS cuts at the first keyframe at or after `hls_fragment`, and `startPublisher` encodes at
 * `-g fps*2`, so against a fragment shorter than that the publisher's GOP is what decides the
 * length. Counting these as fragments makes a recording several times longer and several times more
 * expensive than intended, which is the whole reason this is written down rather than left as a
 * number. The run prints what the stage actually cuts at, read off the running SRS config, so no
 * reader has to hold that arithmetic.
 *
 * ⛔⛔ **Per rung, and it was not until 2026-09-05.** The uploader writes one upload line per rung,
 * so on the four rung latbench stage a target of 60 before and 60 after produced 32 segments per
 * rung: a quarter of what was asked, and a quarter of the recording a player sees, because a player
 * rides one rung. `harness/recording.ts` holds the counting and `test/recording.test.ts` covers it.
 *
 * 45 either side is comfortably past the ~6s the player buffers, so every seek below has to retrieve
 * rather than replay what it already holds.
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
/**
 * `RECORDING_ARM_DISCONTINUITY=0` makes the same recording without the outage.
 *
 * ⭐ **The control arm, and it is the whole reason this is a knob.** A long recording with a
 * discontinuity in it differs from the 27 second ones this project already has in **two** ways, so a
 * playback failure against it names neither. The same length with no discontinuity separates them.
 */
const ARM_DISCONTINUITY = process.env.RECORDING_ARM_DISCONTINUITY !== '0';
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

  // ⛔ Every publisher node, the way all 27 suites gate. This read the COORDINATOR's stamp alone and
  // called the answer the stage's, which since the per-rung split speaks for one node of four: an
  // expired batch on the 1080p node cleared it every time and turned up mid-recording as a rung that
  // stopped being produced. This script publishes for minutes and pays for every segment, so the
  // wrong node's TTL here buys an unusable recording rather than a warning.
  await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
  await waitForIdle(host, cfg);

  const segmentSeconds = await stageSegmentLength(host, cfg);
  console.log(
    segmentSeconds === null
      ? `recording: the ${cfg.engine} stage does not report a segment length this harness can read, so ` +
          'the media figures below are segment counts alone'
      : `recording: the stage cuts ${segmentSeconds}s segments, so ${before} + ${after} per rung is ` +
          `${(((before + after) * segmentSeconds) / 60).toFixed(1)} minutes of media`,
  );

  const startedAt = await host.nowIso();
  const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
  const progress = async (): Promise<number> => recordingProgress(await log()).perRung;
  const report = async (): Promise<string> => recordingSummary(recordingProgress(await log()), segmentSeconds);

  const publisher = startPublisher(cfg);
  let beeIsDown = false;
  let beforeOutage = 0;
  try {
    console.log(`recording: publishing ${before} segments per rung before the outage`);
    await waitFor(async () => (await progress()) >= before, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 5_000,
      label: `${before} segments per rung before the outage`,
    });
    console.log(`recording: ${await report()}`);

    beforeOutage = await progress();
    if (ARM_DISCONTINUITY) {
      console.log(`recording: taking ${beeUploader} away for ${OUTAGE_MS / 1000}s to arm a discontinuity`);
      await host.stop(beeUploader);
      beeIsDown = true;
      await new Promise((resolve) => setTimeout(resolve, OUTAGE_MS));
      await host.start(beeUploader);
      beeIsDown = false;
    } else {
      console.log('recording: control arm, no outage and no discontinuity');
    }

    console.log(
      ARM_DISCONTINUITY
        ? `recording: publishing ${after} more segments per rung past the discontinuity`
        : `recording: publishing ${after} more segments per rung`,
    );
    await waitFor(async () => (await progress()) >= beforeOutage + after, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 5_000,
      label: `${after} segments per rung after the outage`,
    });
    console.log(`recording: ${await report()}`);

    const events = parseUploaderLog(await log());

    // ⛔ The check that was missing, and it cost a whole write-up. On 2026-08-09 this script produced
    // a recording whose first four segments held 41 AAC packets and **zero video packets**, because
    // the publisher was throttled to near no frames at the start. It reported success. The playback
    // run against it then built an audio-only codec set, refused every later video sample with a
    // non-fatal warning, and read as an intermittent player defect. See task #40.
    //
    // Refused for any videoless segment rather than only a leading one: a recording made to be
    // seeked around in is not usable with a hole in its video either, and this cannot be repaired
    // after the fact.
    if (events.videolessSegments.length > 0) {
      throw new Error(
        `segment ${events.videolessSegments[0]} holds no video packets, so this recording cannot answer ` +
          'anything about playback. The publisher delivered no frames; see task #76 for what throttles it.',
      );
    }

    if (!ARM_DISCONTINUITY) {
      // The control has to be a control. An outage nobody asked for, from a real hiccup, would put
      // the variable back in and the arm would look like a clean comparison.
      if (events.discontinuitiesArmed > 0) {
        throw new Error(
          `the control arm armed ${events.discontinuitiesArmed} discontinuity(s) on its own, so it is not a control`,
        );
      }
      console.log('recording: control arm clean, no discontinuity armed');
    } else if (events.discontinuitiesArmed === 0) {
      // Reported rather than tolerated: a recording with no discontinuity answers a different
      // question from the one this was made for, and a playback run against it would look like a
      // pass. See scenario A — an outage inside the retry window buffers and flushes instead.
      throw new Error(
        'the outage armed no discontinuity, so this recording cannot answer whether a viewer seeks ' +
          'across one. The node came back inside the retry window.',
      );
    }
    console.log(
      `recording: ${events.discontinuitiesArmed} discontinuity(s) armed after ${beforeOutage} segments per rung`,
    );
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

  const total = await progress();
  console.log('');
  console.log(
    ARM_DISCONTINUITY
      ? 'recording ready. To play it back and seek across the discontinuity:'
      : 'control recording ready, no discontinuity in it. To play it back and seek:',
  );
  console.log('');
  console.log(`  BROWSER_VOD_OWNER=${announced.owner} \\`);
  console.log(`  BROWSER_VOD_TOPIC=${announced.topic} \\`);
  console.log('  pnpm browser:vod');
  console.log('');
  console.log(`  ${await report()}`);
  console.log(
    ARM_DISCONTINUITY
      ? `  discontinuity after roughly ${((100 * beforeOutage) / total).toFixed(0)}% of the recording`
      : '  no discontinuity',
  );
}

/**
 * What the running stage cuts a segment at, or null where this run cannot learn it.
 *
 * ⛔ Off the running container rather than out of the env files, for the reason `harness/stage.ts`
 * gives at length: an env file edited after the last deploy states an intention, and this bench host
 * is shared. It costs one `docker exec cat`, publishes nothing and spends nothing.
 *
 * ⭐ A read that fails is a figure this run cannot print, not a reason to abandon a recording. The
 * stamp gate above has already refused the faults that make a recording unusable, and an engine with
 * no config reader here still produces a perfectly good recording. So the reason is printed and the
 * media clause is dropped, rather than an unreadable length ending the run.
 */
async function stageSegmentLength(host: Host, cfg: E2EConfig): Promise<number | null> {
  if (cfg.engine !== 'srs') {
    return null;
  }

  try {
    return stageSegmentSeconds(await readStageSegmenting(host, cfg));
  } catch (error) {
    console.log(
      `recording: could not read what ${containerName(cfg, 'srs')} cuts at, so this run states segment ` +
        `counts and no media length: ${(error as Error).message}`,
    );
    return null;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
