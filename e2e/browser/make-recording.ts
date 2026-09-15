/**
 * `pnpm make:recording` — produce a finished recording long enough to be worth seeking around in,
 * with a hole in its timeline at a known point, and print what a playback run needs to address it.
 *
 * ## ⚠️ What this used to make, and what it makes now
 *
 * Until the owner's ruling of 2026-09-06 a writer-bee outage armed an `#EXT-X-DISCONTINUITY`, and this
 * driver existed to put one in the middle of a long recording. A lost segment no longer arms one: the
 * playlist lists every sequence it lost as an `#EXT-X-GAP` entry instead, so the media behind the hole
 * keeps the numbers it was published with. **So this can no longer make a recording with a
 * discontinuity in it at all.** The two things that still arm one are the origin declaring a break,
 * which the shipped SRS webhook path never does, and the engine's own counter restarting, which is a
 * different fault from the one this drives. What it makes now is a recording with a HOLE at a known
 * point, which is the thing worth seeking across on the shipped build.
 *
 * ## Why this exists
 *
 * Phase 1.2 left two questions unreached, and the roadmap blamed the harness for both: seeking **past
 * a break in the timeline**, and seeking into a region **whose chunks have left the local gateway**.
 * Neither is a harness gap. `browser:vod` already seeks to 0.5, 0.9 and then back to 0.2 of the
 * duration, so it crosses anything sitting in the middle, forwards and backwards.
 *
 * ⭐ **What was missing is the recording.** Every recording this project had was 27 seconds, which
 * fits in the player's buffer whole, so the harness asked both questions and the player answered
 * neither: nothing was retrieved during a seek because everything was already held.
 *
 * So this makes the artifact rather than another instrument. It publishes, takes the writer's bee node
 * away for longer than the uploader's retry window so a segment is lost mid-recording, publishes for
 * as long again, and stops cleanly into a VOD.
 *
 * ⚠️ **`stop` rather than `kill` on the bee node**, for the reason `faults.ts` gives: a SIGKILL risks
 * the database of the node holding the postage batch every measurement is paid for with.
 *
 * ## ⛔⛔ On a split ladder the outage reaches ONE rung, and the run says which
 *
 * Since the per-rung split of 2026-08-31 each rung publishes through its own Bee node, and
 * `bee-uploader` is the LOWEST rung's, because the stream catalog and every ladder's master playlist
 * go through the longest-lived batch, which is the cheapest rung's. So taking that container away
 * costs the bottom rung a segment alone: the other three keep publishing through their own nodes and
 * their playlists come out whole. A player that rides 720p through this recording therefore crosses
 * nothing, and `events.discontinuitiesArmed`, which counts the uploader's loss lines as well as its
 * break lines, is above zero either way. The run prints which rung it landed on rather than leaving a
 * reader to infer it, and a playback run that needs to cross the hole has to ride that rung.
 *
 * Usage, from the repo root against a deployed profile:
 *
 *     E2E_PROFILE=latbench E2E_PORT_SLOT=7 pnpm make:recording
 *
 * It prints `BROWSER_VOD_OWNER` and `BROWSER_VOD_TOPIC` for the playback run, and where in the
 * recording the hole landed so a report can say which seeks crossed it.
 */

import { requireBenchAuthorised } from '../src/bench/authorisation.js';
import { envNumber } from '../src/browser/runFiles.js';
import { containerName, type E2EConfig, loadConfig } from '../src/config.js';
import { type Host, makeHost, waitForIdle } from '../src/harness/host.js';
import { announcedLiveStreams, parseUploaderLog } from '../src/harness/logwatch.js';
import { startPublisher } from '../src/harness/publisher.js';
import { lowestRungOf, recordingProgress, recordingSummary, vodFinalizeWaitMs } from '../src/harness/recording.js';
import { readStageSegmenting } from '../src/harness/stage.js';
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
/** Segments after it, so the hole sits near the middle and seeks cross it in both directions. */
const AFTER_SEGMENTS = 45;
/**
 * How long the writer's node stays down.
 *
 * Longer than `MANIFEST_UPLOAD_RETRY_WINDOW_MS` (15s), which is what makes the uploader give up on the
 * segment in flight and leave a hole its playlist lists as gap entries. Shorter and the segments merely
 * buffer and flush, which is scenario A and leaves nothing to seek across.
 */
const OUTAGE_MS = 20_000;
/**
 * `RECORDING_ARM_DISCONTINUITY=0` makes the same recording without the outage.
 *
 * ⭐ **The control arm, and it is the whole reason this is a knob.** A long recording with a hole in
 * it differs from the 27 second ones this project already has in **two** ways, so a playback failure
 * against it names neither. The same length with no hole separates them.
 *
 * ⚠️ The variable keeps its name. It is what an operator types, it is written down in the bench
 * records that used this driver, and renaming it would silently ignore every existing invocation.
 * What it arms is now a hole rather than a discontinuity, which is what everything below says.
 */
const ARM_HOLE = process.env.RECORDING_ARM_DISCONTINUITY !== '0';
const SEGMENT_WAIT_MS = 600_000;
/** How often the finalize wait reads the log. Part of the wait's own derivation, so it is named. */
const VOD_POLL_MS = 3_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const beeUploader = containerName(cfg, 'bee-uploader');
  const before = envNumber('RECORDING_BEFORE_SEGMENTS', BEFORE_SEGMENTS);
  const after = envNumber('RECORDING_AFTER_SEGMENTS', AFTER_SEGMENTS);

  // ⛔ The same three gates the benches run, because this publishes for minutes and pays for every
  // segment exactly as they do: the owner's authorisation in the spend ledger, every publisher's
  // chequebook, and every publisher's postage TTL. Until 2026-09-16 this read postage alone, and
  // before that it read the COORDINATOR's stamp alone and called the answer the stage's, which since
  // the per-rung split speaks for one node of four: an expired batch on the 1080p node cleared it
  // every time and turned up mid-recording as a rung that stopped being produced. A wrong reading
  // here buys an unusable recording rather than a warning. See `src/bench/authorisation.ts`.
  console.log(`recording: ${await requireBenchAuthorised(host, cfg)}`);
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
  let armedRung: string | null = null;
  try {
    console.log(`recording: publishing ${before} segments per rung before the outage`);
    await waitFor(async () => (await progress()) >= before, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 5_000,
      label: `${before} segments per rung before the outage`,
    });
    console.log(`recording: ${await report()}`);

    beforeOutage = await progress();
    if (ARM_HOLE) {
      const rungs = recordingProgress(await log()).rungs.map((rung) => rung.rung);
      armedRung = lowestRungOf(rungs);
      console.log(`recording: taking ${beeUploader} away for ${OUTAGE_MS / 1000}s to tear a hole`);
      if (armedRung !== null) {
        console.log(
          `recording: ${beeUploader} publishes the ${armedRung} rung of ${rungs.length} (${rungs.join(', ')}), ` +
            "plus the stream catalog and this ladder's master playlist. The other rungs publish through " +
            `their own nodes and keep going, so the hole is torn in ${armedRung} alone and only a ` +
            'player riding that rung crosses one',
        );
      }
      await host.stop(beeUploader);
      beeIsDown = true;
      await new Promise((resolve) => setTimeout(resolve, OUTAGE_MS));
      await host.start(beeUploader);
      beeIsDown = false;
    } else {
      console.log('recording: control arm, no outage and no hole');
    }

    console.log(
      ARM_HOLE
        ? `recording: publishing ${after} more segments per rung past the hole`
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

    if (!ARM_HOLE) {
      // The control has to be a control. An outage nobody asked for, from a real hiccup, would put
      // the variable back in and the arm would look like a clean comparison.
      if (events.discontinuitiesArmed > 0) {
        throw new Error(
          `the control arm lost ${events.discontinuitiesArmed} segment(s) on its own, so it is not a control`,
        );
      }
      console.log('recording: control arm clean, nothing lost');
    } else if (events.discontinuitiesArmed === 0) {
      // Reported rather than tolerated: a recording with no hole answers a different question from
      // the one this was made for, and a playback run against it would look like a pass. See
      // scenario A — an outage inside the retry window buffers and flushes instead.
      throw new Error(
        'the outage cost no segment, so this recording cannot answer whether a viewer seeks across a ' +
          'hole. The node came back inside the retry window.',
      );
    }
    console.log(`recording: ${events.discontinuitiesArmed} loss line(s) after ${beforeOutage} segments per rung`);
  } finally {
    await publisher.stop();
    if (beeIsDown) {
      await host.start(beeUploader).catch(() => undefined);
    }
  }

  const vodWaitMs = vodFinalizeWaitMs({ segmentSeconds, pollMs: VOD_POLL_MS });
  console.log(`recording: waiting up to ${(vodWaitMs / 1000).toFixed(0)}s for the broadcast to finalize`);

  // ⛔⛔ The address is printed either way, and the run still exits non-zero. Live on 2026-09-02 this
  // gave up four seconds before the uploader finished all four rungs, so the recording existed and
  // the only thing lost was the owner and topic that address it. A finalize this run did not see is
  // a reason to look at the uploader's log, not a reason to make the broadcast again.
  let notFinalized: Error | null = null;
  try {
    await waitFor(async () => /Updating stream in list to VOD/.test(await log()), {
      timeoutMs: vodWaitMs,
      intervalMs: VOD_POLL_MS,
      label: 'the broadcast finalizes into a recording',
    });
  } catch (error) {
    notFinalized = error as Error;
  }

  const announced = announcedLiveStreams(await log()).at(-1);
  if (!announced) {
    throw new Error('the uploader announced no stream, so the recording cannot be addressed');
  }

  const total = await progress();
  console.log('');
  if (notFinalized !== null) {
    console.log(
      'this run never saw the broadcast finalize, so the recording may still be live. Its address is ' +
        'below either way, and the uploader may have finished since:',
    );
  } else {
    console.log(
      ARM_HOLE
        ? 'recording ready. To play it back and seek across the hole:'
        : 'control recording ready, no hole in it. To play it back and seek:',
    );
  }
  console.log('');
  console.log(`  BROWSER_VOD_OWNER=${announced.owner} \\`);
  console.log(`  BROWSER_VOD_TOPIC=${announced.topic} \\`);
  console.log('  pnpm browser:vod');
  console.log('');
  console.log(`  ${await report()}`);
  console.log(
    ARM_HOLE
      ? `  hole after roughly ${((100 * beforeOutage) / total).toFixed(0)}% of the recording` +
          (armedRung === null ? '' : `, on the ${armedRung} rung and no other`)
      : '  no hole',
  );

  if (notFinalized !== null) {
    throw notFinalized;
  }
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
