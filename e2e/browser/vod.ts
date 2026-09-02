/**
 * `pnpm browser:vod` — play a finished broadcast back and seek around inside it.
 *
 * Phase 1.2. The VOD path looks correct by construction: `buildVODManifest` emits every segment with
 * `PLAYLIST-TYPE:VOD` and `ENDLIST`, the client resolves the head once and gets that manifest whole,
 * and hls.js seeks natively over it. **That is a reading of the code and it has never been a result.**
 * Nobody has watched a recording play, and nothing tests it.
 *
 * It matters more than it did. The path into a recording was changed twice on 2026-08-06, once to
 * publish a closing live manifest ahead of the VOD and once to make a finished playlist extend a
 * viewer's list rather than replace it, so the entry to this surface is newer than any evidence
 * about it.
 *
 * What this answers, and deliberately only this:
 *   - does a recording play at all, and does it report a finite duration rather than a live edge
 *   - does seeking land where it was asked, forwards and backwards
 *   - does playback resume after each seek, or does the player stall on a fresh retrieval
 *
 * `BROWSER_FETCH_BACKEND` chooses where the segment bytes come from, `weeb3` being the in-tab node
 * and `gateway` the control, and the run proves the bytes came from where it says before it ends.
 *
 * ## The squeeze mode, `BROWSER_VOD_SQUEEZE_KBPS`
 *
 * Set it and the run stops seeking and squeezes instead: play from the start, cap the tab's download
 * part way through, lift it, and read the three stretches either side. Unset, everything below is
 * exactly the seek battery it has always been.
 *
 * What the squeeze answers:
 *   - does the picture keep moving under the cap, and how often does it stop in each stretch
 *   - which rung the player chose, asked for and decoded across each stretch
 *   - which level each fragment belonged to, how each attempt ended, and what answered too late
 *   - how many bytes the tab's own sockets pulled in each stretch, which is the in-tab node's traffic
 *
 * ⭐ **A recording is the control a squeezed live watch never had.** A capped live viewer has two
 * things going wrong at once, the link and the edge moving away from them, and a recording removes
 * the second: there is no edge, and every byte the player wants already exists. On 2026-09-02 the
 * in-tab node's raw retrievals were measured under Chrome's emulated cap and our own PLAYER under
 * the same cap was not, which is the gap this closes. `browser/weeb3-native.ts` squeezes weeb-3's own
 * page at the same cap, so the two sit side by side.
 *
 * ⛔ Nothing here is asserted. Every ratio, byte count and stall count is measured, printed under a
 * heading that says so, and filed. Owner ruling of 2026-08-29.
 *
 * Usage, on the deployment host, against a stream that has already finished:
 *   deploy/scripts/browser-on-host.sh --script browser:vod -- \
 *     BROWSER_VOD_OWNER=<owner> BROWSER_VOD_TOPIC=<rawTopic>
 *
 * And the same recording with its link squeezed to 2800 kbps:
 *   deploy/scripts/browser-on-host.sh --script browser:vod -- \
 *     BROWSER_VOD_OWNER=<owner> BROWSER_VOD_TOPIC=<rawTopic> BROWSER_VOD_SQUEEZE_KBPS=2800
 */

import { type Page } from 'playwright-core';

import {
  type ByteSourceArmSession,
  DEFAULT_BYTE_SOURCE_SETTLE_SECONDS,
  openByteSourceArmSession,
} from '../src/browser/byteSourceArm.js';
import { byteSourceFromEnv } from '../src/browser/fetchBackendSweep.js';
import {
  abandonedAnswerVerdict,
  type FragmentLog,
  fragmentLogVerdict,
  type FragmentRequestTimeline,
  fragmentSettleVerdict,
  judgeFragmentRequests,
  recordFragmentLog,
} from '../src/browser/fragmentRequests.js';
import { type InstrumentReading, judgeRun } from '../src/browser/instrument.js';
import { type RequestRecord, summarizeNetwork } from '../src/browser/network.js';
import { installPlayerProbe, type PlayerProbe, readPlayerProbe } from '../src/browser/playerProbe.js';
import { judgeQualitySwitch } from '../src/browser/qualitySwitch.js';
import { fragmentRequestSection } from '../src/browser/qualitySwitchReport.js';
import { type ByteSourceCondition, seconds } from '../src/browser/report.js';
import { costSection, judgeCost, readResources, type ResourceCost } from '../src/browser/resources.js';
import {
  envNumber,
  envNumberOrNull,
  requireEnv,
  runIdFrom,
  screenshotDirFor,
  thinRequestLog,
  writeRunArtifacts,
} from '../src/browser/runFiles.js';
import { summarize, type ViewerSample } from '../src/browser/session.js';
import { squeezeDownload, type ThrottleHandle } from '../src/browser/throttle.js';
import {
  installClockOverlay,
  installTimerProbe,
  launchViewer,
  proveInstrumentCanFail,
  readInstrument,
  readSample,
  recordRequests,
  VIEWPORT,
} from '../src/browser/viewer.js';
import {
  judgeVodSqueeze,
  vodSqueezeObservations,
  type VodSqueezeReport,
  vodSqueezeSection,
} from '../src/browser/vodSqueeze.js';
import { DEFAULT_SAMPLE_INTERVAL_MS, sampleFor } from '../src/browser/watchLoop.js';
import { recordWebSocketTraffic, type WebSocketTraffic } from '../src/browser/webSocketTraffic.js';
import { loadConfig } from '../src/config.js';
import { makeHost } from '../src/harness/host.js';

/** How long to watch from the start before seeking, so ordinary playback is established first. */
const SETTLE_SECONDS = 8;

/**
 * How often the settle is sampled, and why it is sampled at all.
 *
 * ⭐ This run used to read the media element directly and nothing else, so it could say a recording
 * played and could not say WHAT played. A ladder recording whose master resolved and whose upper rung
 * playlists did not plays perfectly at its bottom rung, and every reading this driver took would have
 * called that a pass. Sampling the shipped overlay is what makes a recording's rungs visible, and it
 * is the same `readSample` every live run uses, so a VOD reading now means what a live one means.
 */
const SAMPLE_INTERVAL_MS = 1_000;
/** How long to allow a seek to land and playback to resume before calling it stalled. */
const SEEK_TIMEOUT_MS = 20_000;
/** How far `currentTime` may sit from the seek target and still count as landed. */
const SEEK_TOLERANCE_S = 1.5;

/** Where in the recording to seek, as a fraction of its duration. Ends backwards on purpose. */
const SEEK_FRACTIONS = [0.5, 0.9, 0.2] as const;

/**
 * How long a squeeze run watches the recording play before capping the link.
 *
 * ⛔ Its own variable, `BROWSER_VOD_SETTLE_S`, and not `BROWSER_VOD_SETTLE_SECONDS`. That one is the
 * seek battery's eight-second warm-up and every recipe in the existing corpus was run with it, so
 * folding a second meaning into it would move a window nobody asked to move. Forty-five matches
 * `browser:quality`, which is the live arm this run is the control for, and two windows of different
 * lengths would not be comparable.
 */
const DEFAULT_SQUEEZE_SETTLE_SECONDS = 45;

/**
 * How long the link stays capped.
 *
 * hls.js re-estimates bandwidth from its own fragment loads, so the cap has to outlast enough
 * fragment loads for the estimate to move. Nothing here is asserted on how quickly it does.
 */
const DEFAULT_SQUEEZE_SECONDS = 60;

/** How long to keep watching after the cap comes off, which is where the climb back is seen. */
const DEFAULT_RECOVER_SECONDS = 60;

/** What a squeeze run was asked to do, so the report states the plan rather than inferring it. */
interface SqueezePlan {
  kbps: number;
  settleMs: number;
  squeezeMs: number;
  recoverMs: number;
  intervalMs: number;
}

/**
 * Whether the player holds a finished playlist rather than a live window.
 *
 * A live playlist reports `Infinity` for its duration, which is the whole point of the reading: it
 * says a recording was expected and a broadcast arrived.
 */
function isFinishedTimeline(playback: PlaybackReading | undefined): boolean {
  return playback !== undefined && Number.isFinite(playback.duration) && playback.duration > 0;
}

/**
 * Say so where the recording is shorter than the plan needs to play through.
 *
 * ⛔ A warning and never a refusal. Sizing a run is the operator's call. What it buys is the one
 * reading nothing else gives: a recording that ends part way through leaves every stretch after that
 * point describing a finished element rather than a viewer, which looks exactly like a picture that
 * stopped under the cap.
 */
function warnIfShorterThanThePlan(recordingS: number | undefined, plan: SqueezePlan, settledForMs: number): void {
  const needsS = (settledForMs + plan.settleMs + plan.squeezeMs + plan.recoverMs) / 1000;
  if (recordingS === undefined || !Number.isFinite(recordingS) || recordingS >= needsS) {
    return;
  }

  console.log(
    `browser: ⚠️ this recording is ${recordingS.toFixed(1)}s and the plan needs ${needsS.toFixed(1)}s of ` +
      'playback, so it ends mid-run and every stretch after that point describes a finished element ' +
      'rather than a viewer. Record for longer, or shorten BROWSER_VOD_SETTLE_S, BROWSER_VOD_SQUEEZE_S, ' +
      'BROWSER_VOD_RECOVER_S and BROWSER_BYTE_SOURCE_SETTLE_SECONDS.',
  );
}

/**
 * The plan, or null for the seek battery this driver has always run.
 *
 * ⛔ `envNumberOrNull` rather than a default, because the presence of the cap is what chooses the
 * mode. A default would make every existing recipe a squeeze run.
 */
function squeezePlanFromEnv(): SqueezePlan | null {
  const kbps = envNumberOrNull('BROWSER_VOD_SQUEEZE_KBPS');
  if (kbps === null) {
    return null;
  }

  return {
    kbps,
    settleMs: envNumber('BROWSER_VOD_SETTLE_S', DEFAULT_SQUEEZE_SETTLE_SECONDS) * 1000,
    squeezeMs: envNumber('BROWSER_VOD_SQUEEZE_S', DEFAULT_SQUEEZE_SECONDS) * 1000,
    recoverMs: envNumber('BROWSER_VOD_RECOVER_S', DEFAULT_RECOVER_SECONDS) * 1000,
    intervalMs: envNumber('BROWSER_SAMPLE_INTERVAL_MS', DEFAULT_SAMPLE_INTERVAL_MS),
  };
}

interface PlaybackReading {
  currentTime: number;
  duration: number;
  buffered: number;
  readyState: number;
  paused: boolean;
  seekable: number;
  /** `MediaError.code` and its message, which is where a segment the player refused shows up. */
  mediaError: string | null;
  /** What the media element itself thinks it is doing, which a stalled `readyState` does not say. */
  networkState: number;
}

/** What a page with no media element at all reads as, which is a distinct fault from one that stalled. */
const NO_VIDEO: PlaybackReading = {
  currentTime: 0,
  duration: 0,
  buffered: 0,
  readyState: 0,
  paused: true,
  seekable: 0,
  mediaError: null,
  networkState: 0,
};

/** One line the page logged. Warnings included: hls.js reports a non-fatal error as one. */
interface PageMessage {
  type: string;
  text: string;
}

interface SeekResult {
  fraction: number;
  targetS: number;
  landedAtS: number | null;
  landedInMs: number | null;
  resumedInMs: number | null;
  error: string | null;
}

async function readPlayback(page: Page): Promise<PlaybackReading> {
  return (
    (await page.evaluate(() => {
      const video = document.querySelector('video');
      if (!video) {
        return null;
      }
      return {
        currentTime: video.currentTime,
        duration: video.duration,
        buffered: video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0,
        readyState: video.readyState,
        paused: video.paused,
        seekable: video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) : 0,
        mediaError: video.error ? `${video.error.code}: ${video.error.message}` : null,
        networkState: video.networkState,
      };
    })) ?? NO_VIDEO
  );
}

/** Seek, then wait for the position to land and for the picture to start moving again. */
async function seekTo(page: Page, targetS: number, fraction: number): Promise<SeekResult> {
  const startedAt = Date.now();
  const result: SeekResult = {
    fraction,
    targetS,
    landedAtS: null,
    landedInMs: null,
    resumedInMs: null,
    error: null,
  };

  await page.evaluate((to) => {
    const video = document.querySelector('video');
    if (video) {
      video.currentTime = to;
    }
  }, targetS);

  try {
    await page.waitForFunction(
      ([to, tolerance]) => {
        const video = document.querySelector('video');
        return video !== null && !video.seeking && Math.abs(video.currentTime - to) <= tolerance;
      },
      [targetS, SEEK_TOLERANCE_S] as [number, number],
      { timeout: SEEK_TIMEOUT_MS },
    );
    result.landedInMs = Date.now() - startedAt;
    result.landedAtS = (await readPlayback(page)).currentTime;
  } catch {
    result.error = `never landed within ${SEEK_TOLERANCE_S}s of ${targetS.toFixed(2)}s`;
    result.landedAtS = (await readPlayback(page)).currentTime;
    return result;
  }

  // Landing is not playing. A seek into a region whose chunks have left the local gateway lands
  // instantly and then stalls, and that is the failure this run exists to catch.
  const landedAt = result.landedAtS;
  const resumeStartedAt = Date.now();
  try {
    await page.waitForFunction(
      (from) => {
        const video = document.querySelector('video');
        return video !== null && video.currentTime > from + 0.3;
      },
      landedAt,
      { timeout: SEEK_TIMEOUT_MS },
    );
    result.resumedInMs = Date.now() - resumeStartedAt;
  } catch {
    result.error = `landed at ${landedAt.toFixed(2)}s and the picture never moved again`;
  }

  return result;
}

async function main(): Promise<void> {
  const clientUrl = requireEnv('BROWSER_CLIENT_URL');
  const owner = requireEnv('BROWSER_VOD_OWNER');
  const topic = requireEnv('BROWSER_VOD_TOPIC');
  const mediatype = process.env.BROWSER_VOD_MEDIATYPE ?? 'video';
  const settleSeconds = envNumber('BROWSER_VOD_SETTLE_SECONDS', SETTLE_SECONDS);
  // ⛔ Read here rather than where the arm opens, exactly as every other driver reads it: a typo in a
  // byte source should cost a startup and not a whole recording's playback.
  const armByteSource = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
  const byteSourceSettleMs = envNumber('BROWSER_BYTE_SOURCE_SETTLE_SECONDS', DEFAULT_BYTE_SOURCE_SETTLE_SECONDS) * 1000;
  const squeeze = squeezePlanFromEnv();

  const measuredAt = new Date().toISOString();
  const runId = runIdFrom(measuredAt);
  const screenshotDir = screenshotDirFor(runId);
  // The route goes in the **fragment**. The client mounts its routes under a `HashRouter`, so the
  // path form of this URL matches no route at all and renders the catalog instead, silently: the
  // page loads, the catalog renders a thumbnail player per card, one of those loads one segment, and
  // the run reports a recording that would not start. Every reading taken through the path form was
  // of the thumbnail grid. This is the only harness that builds a watch URL rather than clicking a
  // catalog card, which is why it is the only one that could meet this.
  const watchUrl = `${clientUrl}/#/watch/${mediatype}/${owner}/${topic}?qoe=1`;

  const cfg = loadConfig();
  const host = makeHost(cfg);
  // ⛔ Before the browser, so the stage's postage and funding are read on a deployment nothing has
  // touched yet, and so a routing this run cannot read refuses here rather than after a playback.
  const resourcesBefore = await readResources(host, cfg);

  const browser = await launchViewer();
  const chromeVersion = `Chrome ${browser.version()}`;
  // Taken before the measurement so an early failure downstream cannot leave the run reporting a
  // soundness verdict nothing ever tried to break.
  const instrumentProofs = await proveInstrumentCanFail(browser);
  console.log(`browser: ${chromeVersion}, playing back ${watchUrl}`);

  const requests: RequestRecord[] = [];
  const messages: PageMessage[] = [];
  let startedPlaying: PlaybackReading | undefined;
  let afterSettle: PlaybackReading | undefined;
  const seeks: SeekResult[] = [];
  const samples: (ViewerSample | null)[] = [];
  const readings: InstrumentReading[] = [];
  const screenshots: string[] = [];
  /** ⛔ Observations, both of them. Nothing below branches on either and no gate reads them. */
  const fragmentLog: FragmentLog = { requests: [], settles: [], abandonedAnswers: [] };
  const traffic: WebSocketTraffic = { connections: [], frames: [] };
  let openError: string | null = null;
  let byteSourceArm: ByteSourceArmSession | undefined;
  let throttle: ThrottleHandle | undefined;
  let throttledAtMs = 0;
  let releasedAtMs = 0;

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    recordRequests(page, requests);
    if (squeeze !== null) {
      // Before the navigation, for the reason `recordRequests` is: a listener added afterwards misses
      // whatever the player asked for and whatever its node dialled while the page was still opening,
      // and a phase short at one end is indistinguishable from a player that was quiet.
      recordFragmentLog(page, fragmentLog);
      recordWebSocketTraffic(page, traffic);
    }
    await installTimerProbe(page);
    await installPlayerProbe(page);

    // Warnings as well as errors, and this is the whole reason the first run of this said nothing:
    // the player logs a **non-fatal** hls.js error as `console.warn`, and non-fatal is exactly what
    // a player that quietly stops after one segment reports.
    page.on('console', (message) => {
      const type = message.type();
      if (type !== 'error' && type !== 'warning') {
        return;
      }
      messages.push({ type, text: message.text() });
      console.log(`  page ${type}: ${message.text()}`);
    });

    await page.goto(watchUrl, { waitUntil: 'domcontentloaded' });

    // A recording that never starts is the headline result, not an exception, so the wait is caught.
    let playbackStartedAtMs = 0;
    try {
      await page.waitForFunction(
        () => {
          const video = document.querySelector('video');
          return video !== null && video.readyState >= 2 && video.currentTime > 0;
        },
        undefined,
        { timeout: 60_000 },
      );
      // Stamped before the readback, which is a round trip: the byte-source settle is measured from
      // this instant and both conditions have to open their window with a player of the same age.
      playbackStartedAtMs = Date.now();
      startedPlaying = await readPlayback(page);
      console.log(
        `browser: playing, duration ${startedPlaying.duration.toFixed(2)}s, ` +
          `seekable to ${startedPlaying.seekable.toFixed(2)}s`,
      );
    } catch {
      openError = 'the recording never started playing';
      // Read on the failing path too. Without it the run reports only that nothing happened, and
      // "no source buffer was ever created" and "a segment was appended and the picture stayed
      // frozen" are different faults that reach here identically.
      afterSettle = await readPlayback(page);
    }

    // ⛔ A squeeze run checks the timeline HERE rather than after a settle. A live playlist reports
    // Infinity, and capping one for three minutes would spend the whole plan filing a broadcast under
    // a recording's name. The seek battery keeps its own check after its own settle, because
    // `duration` has been seen to move across those eight seconds and every seek target comes off it.
    if (openError === null && squeeze !== null && !isFinishedTimeline(startedPlaying)) {
      openError = `duration is ${startedPlaying?.duration}, so the player was not handed a finished playlist`;
      afterSettle = await readPlayback(page);
    }

    if (!openError) {
      // ⛔⛔ The recording was opened on whatever the build defaults to, and this is where the run
      // becomes the byte source it is filed under. `browser:vod` was handed `BROWSER_FETCH_BACKEND`
      // by every suite that launched it and read it nowhere, which is this repo's oldest defect: an
      // unread variable looks exactly like one set to its default, and `crash.ts` and
      // `buffer-sweep.ts` published gateway readings under the in-tab node's name that way.
      //
      // ⚠️ A weeb-3 arm holds the player for `BROWSER_BYTE_SOURCE_SETTLE_SECONDS` (60 by default)
      // while its node boots, and that time is spent PLAYING the recording. A recording shorter than
      // the settle has finished before the settle ends, which does not break a seek (the whole
      // timeline is buffered) and does mean the settle was not a settle. Size the recording, or
      // shorten the window with that variable.
      byteSourceArm = await openByteSourceArmSession({
        page,
        source: armByteSource,
        playbackStartedAtMs,
        settleMs: byteSourceSettleMs,
      });

      if (squeeze !== null) {
        // Sampled through `sampleFor`, the same loop every live arm uses, so a squeezed recording's
        // advance and rung readings mean exactly what a squeezed broadcast's do. It screenshots both
        // clocks and refuses without the overlay, hence the install.
        await installClockOverlay(page);
        warnIfShorterThanThePlan(startedPlaying?.duration, squeeze, byteSourceArm.arm?.settledForMs ?? 0);

        const totalSamples = Math.ceil((squeeze.settleMs + squeeze.squeezeMs + squeeze.recoverMs) / squeeze.intervalMs);
        const watch = async (forMs: number): Promise<void> => {
          const stretch = await sampleFor({
            page,
            forMs,
            intervalMs: squeeze.intervalMs,
            screenshotDir,
            startIndex: samples.length,
            totalSamples,
          });
          samples.push(...stretch.samples);
          readings.push(...stretch.readings);
          screenshots.push(...stretch.screenshots);
        };

        console.log(`browser: settling for ${squeeze.settleMs / 1000}s before the squeeze`);
        await watch(squeeze.settleMs);

        // ⛔ The cap comes from the environment rather than from the ladder, unlike `browser:quality`.
        // The question here is what OUR player does at the same bandwidth weeb-3's own page was
        // measured at, so the two runs have to be capped at one number rather than each at its own.
        console.log(`browser: capping the tab's download at ${squeeze.kbps} kbps`);
        throttle = await squeezeDownload(page, squeeze.kbps);
        throttledAtMs = Date.now();

        try {
          await watch(squeeze.squeezeMs);
        } finally {
          await throttle?.release().catch((error) => console.error('could not lift the cap:', error));
          throttle = undefined;
          releasedAtMs = Date.now();
          console.log(`browser: cap lifted, watching ${squeeze.recoverMs / 1000}s for the climb back`);
        }

        await watch(squeeze.recoverMs);
        afterSettle = await readPlayback(page);
      } else {
        // ⛔ Sampled rather than slept through. The settle is the only stretch of this run that is
        // ordinary playback, so it is the only one whose rung list and advance describe the recording
        // rather than a seek.
        for (let taken = 0; taken < Math.round((settleSeconds * 1000) / SAMPLE_INTERVAL_MS); taken++) {
          await page.waitForTimeout(SAMPLE_INTERVAL_MS);
          samples.push(await readSample(page).catch(() => null));
        }
        afterSettle = await readPlayback(page);

        const duration = afterSettle.duration;
        if (!Number.isFinite(duration) || duration <= 0) {
          openError = `duration is ${duration}, so the player was not handed a finished playlist`;
        } else {
          // Off `seekable`, not off `duration`. Seeking past the seekable end is not a product
          // failure, it is an invalid request, and the two are not the same number here: `duration`
          // was read as 27.10s at the start of one run and 22.59s eight seconds later, which silently
          // moved every target and turned a run that reached nothing new into a clean pass.
          const reachable = Math.min(duration, afterSettle.seekable);
          for (const fraction of SEEK_FRACTIONS) {
            const seek = await seekTo(page, reachable * fraction, fraction);
            seeks.push(seek);
            console.log(
              `browser: seek to ${(fraction * 100).toFixed(0)}% (${seek.targetS.toFixed(2)}s) ` +
                (seek.error ? `⛔ ${seek.error}` : `landed in ${seek.landedInMs}ms, resumed in ${seek.resumedInMs}ms`),
            );
          }
        }
      }
    }

    // A sample that threw is dropped rather than faked: the overlay can be mid-render, and a zeroed
    // sample would be read as a frozen picture.
    const watched = samples.filter((sample): sample is ViewerSample => sample !== null);

    const network = summarizeNetwork(requests);
    // ⛔ A playback run publishes nothing, so the per-minute rates here come out at zero and the
    // runways read "not measurable from this run", which is the honest answer rather than a gap. What
    // the bracket is for is the pair of health readings either side: every figure this project has
    // retracted for a starved instrument was taken on a run whose postage and funding were never read.
    const cost = judgeCost(resourcesBefore, await readResources(host, cfg), network.segmentBytesDelivered);
    const summary = summarize(watched);

    // One reading per sample in a squeeze run, because the degradation the guard screens for is a
    // consequence of the first stall rather than a property of the page at load. The seek battery
    // takes the one reading at the end it has always taken.
    if (readings.length === 0) {
      readings.push(await readInstrument(page));
    }

    const throttleWindow = { appliedAtMs: throttledAtMs, liftedAtMs: releasedAtMs, kbps: squeeze?.kbps ?? 0 };
    const squeezed: VodSqueezeReport | undefined =
      squeeze === null || openError !== null
        ? undefined
        : {
            throttle: throttleWindow,
            quality: judgeQualitySwitch(watched, throttleWindow),
            phases: judgeVodSqueeze(watched, traffic, throttleWindow),
          };
    // ⛔ Which level the player ASKED for and what became of each attempt, neither of which any other
    // reading here carries. `pictureMoved` is what lets an empty capture read as a client without the
    // instrument rather than as a player that requested nothing.
    const askedFragments: FragmentRequestTimeline | undefined =
      squeezed === undefined
        ? undefined
        : judgeFragmentRequests(fragmentLog, throttleWindow, summary.overallAdvanceRatio > 0);

    const run = {
      measuredAt,
      watchUrl,
      chromeVersion,
      openError,
      startedPlaying,
      afterSettle,
      seeks,
      // ⛔ The vod verdict, under its own key so a reader can tell a recording run from every other
      // kind. A recording that never started still writes one, because "it never started" is the
      // headline result of this run rather than an exception.
      vod: {
        openError,
        durationS: afterSettle?.duration ?? null,
        seekableToS: afterSettle?.seekable ?? null,
        ladderHeights: ladderOfRecording(watched),
      },
      // Undefined on a run that named no byte source, which is a run on whatever the build defaults
      // to rather than a malformed one. `readProof` in `harness/browser.ts` reads it that way.
      byteSource: byteSourceArm?.arm && {
        requested: byteSourceArm.arm.requested,
        reported: byteSourceArm.arm.reported,
        settledForMs: byteSourceArm.arm.settledForMs,
      },
      // ⛔ Undefined outside squeeze mode, and `JSON.stringify` drops an undefined key, so a seek
      // battery's artifact is the shape it has always been. `throttle`, `quality` and
      // `fragmentRequests` are the names `browser:quality` writes, so `parseBrowserArmState` reads a
      // squeezed recording exactly as it reads a squeezed broadcast.
      throttle: squeezed?.throttle,
      quality: squeezed?.quality,
      vodSqueeze: squeezed?.phases,
      fragmentRequests: askedFragments,
      // What the run was asked to do, so a report states the plan rather than inferring it from the
      // stretch lengths it happened to get.
      squeeze: squeeze === null ? undefined : { ...squeeze, byteSourceSettleMs },
      // ⛔ Written under the same names every other driver uses, so `parseBrowserArmState` reads a
      // recording the way it reads a live watch. A second shape here would mean a VOD suite could
      // never assert on the same fields as a live one, which is the whole reason to have both.
      summary,
      samples: watched,
      screenshots,
      player: await readPlayerProbe(page),
      messages,
      instrumentProofs,
      instrument: judgeRun(readings),
      network,
      cost,
    };

    const stem = await writeRunArtifacts('browser-vod', runId, {
      markdown: renderVodReport(run),
      run,
      requests: thinRequestLog(requests),
    });

    console.log(`\nbrowser: wrote ${stem}.md`);
    const failed = openError !== null || seeks.some((seek) => seek.error !== null);
    console.log(`browser: playback ${openError ?? 'started'}, seeks ${failed ? 'FAILED' : 'all landed and resumed'}`);

    if (squeezed !== undefined) {
      vodSqueezeObservations(squeezed).forEach((line) => console.log(`browser: ${line}`));
    }
    if (askedFragments !== undefined) {
      // ⛔ The three verdicts before any count, and they have to be here rather than only in the
      // artifact: a phase of zero and an instrument the deployed client does not carry print the same
      // digits, and these are the lines that say which.
      console.log(`browser: ${fragmentLogVerdict(askedFragments)}`);
      console.log(`browser: ${fragmentSettleVerdict(askedFragments.settled)}`);
      console.log(`browser: ${abandonedAnswerVerdict(askedFragments.abandonedAnswers)}`);
    }
    cost.warnings.forEach((warning) => console.log(`  ⚠️ ${warning}`));

    // ⛔ Last, and after the artifact is on disk. It throws where the segment bytes did not come from
    // the source this run is filed under, and a weeb-3 arm's headline is a ZERO gateway read, which a
    // client that never loaded the node produces just as well. The artifact is the thing worth
    // keeping either way.
    byteSourceArm?.proveBytesCameFromIt(requests);
  } finally {
    // The cap lives in the browser, so closing it lifts everything. Released here anyway for the path
    // where the squeeze stretch threw before its own finally ran.
    await throttle?.release().catch(() => undefined);
    await browser.close();
  }
}

function renderVodReport(run: {
  measuredAt: string;
  watchUrl: string;
  chromeVersion: string;
  openError: string | null;
  startedPlaying?: PlaybackReading;
  afterSettle?: PlaybackReading;
  seeks: SeekResult[];
  samples: readonly ViewerSample[];
  player: PlayerProbe;
  messages: PageMessage[];
  instrument: { sound: boolean; failures: string[] };
  network: unknown;
  byteSource?: ByteSourceCondition;
  cost: ResourceCost;
  /** The squeeze readings, or absent on the seek battery this driver runs by default. */
  quality?: VodSqueezeReport['quality'];
  throttle?: VodSqueezeReport['throttle'];
  vodSqueeze?: VodSqueezeReport['phases'];
  fragmentRequests?: FragmentRequestTimeline;
}): string {
  const squeezed = squeezeReportOf(run);
  const lines: string[] = [];
  lines.push(
    squeezed === undefined
      ? '# Playing a recording back, and seeking inside it'
      : '# Playing a recording back with the link squeezed',
  );
  lines.push('');
  lines.push(`**${run.measuredAt}.** ${run.chromeVersion}, \`${run.watchUrl}\`.`);
  lines.push('');
  if (run.byteSource) {
    // The readback, not the request. A switch that silently did nothing would put a gateway reading
    // under the in-tab node's name, which is the whole reason the arm reads itself back.
    lines.push(
      `Segment bytes came from **${run.byteSource.reported}**, which is what the client reports rather ` +
        `than what was asked for. The window opened ${(run.byteSource.settledForMs / 1000).toFixed(1)}s ` +
        'after playback started, and only requests from that instant on decide whether this run is the ' +
        'condition it is filed under.',
    );
    lines.push('');
  }
  lines.push(`Instrument: **${run.instrument.sound ? 'SOUND' : 'VOID'}**`);
  run.instrument.failures.forEach((failure) => lines.push(`- ⛔ ${failure}`));
  lines.push('');

  if (run.openError) {
    lines.push(`## ⛔ ${run.openError}`);
    lines.push('');
    lines.push(...renderWhatThePlayerDid(run));
    // On the failing path too. A recording that would not play is exactly the run whose postage and
    // funding a reader wants, because a starved stage is one of the reasons it would not.
    lines.push(...costSection(run.cost));
    return lines.join('\n');
  }

  // The second reading is taken after the settle on a seek run and after the whole squeeze on a
  // squeezed one, so the label says which rather than leaving a reader to assume the shorter of the two.
  const readAgainAfter = squeezed === undefined ? 'settling' : 'the whole run';
  lines.push('## What the player was handed');
  lines.push('');
  lines.push('| | |');
  lines.push('| --- | ---: |');
  lines.push(`| duration at the first frame | ${run.startedPlaying?.duration.toFixed(2)}s |`);
  lines.push(`| duration after ${readAgainAfter} | ${run.afterSettle?.duration.toFixed(2)}s |`);
  lines.push(`| seekable to | ${run.afterSettle?.seekable.toFixed(2)}s |`);
  lines.push(`| buffered ahead | ${run.afterSettle?.buffered.toFixed(2)}s |`);
  lines.push(`| position after ${readAgainAfter} | ${run.afterSettle?.currentTime.toFixed(2)}s |`);
  lines.push('');
  lines.push('A finite duration is the whole point: a live playlist reports `Infinity` here, so this');
  lines.push('is what says the player received a finished playlist rather than a live window. The two');
  lines.push('duration rows are separate because they have been seen to disagree, and a seek target');
  lines.push('comes off `seekable`, which is what a seek can actually reach.');
  lines.push('');
  lines.push('## The ladder this recording offered');
  lines.push('');
  const rungs = ladderOfRecording(run.samples);
  const rode = distinct(run.samples.map((sample) => sample.selectedRungHeight));
  lines.push(
    rungs.length === 0
      ? '⛔ **The player held no ladder at all.** Either no master playlist resolved for this recording ' +
          'or it is single rendition, and those are not the same thing.'
      : `The player parsed **${rungs.length} rungs**: ${rungs.map((height) => `${height}p`).join(', ')}.`,
  );
  lines.push('');
  lines.push(
    rode.length === 0
      ? '⛔ **It selected none of them**, so nothing above was ever played.'
      : `It rode ${rode.map((height) => `${height}p`).join(', ')} across the run.`,
  );
  lines.push('');
  lines.push('⛔ A recording whose master resolved and whose upper rung playlists did not plays');
  lines.push('perfectly at its bottom rung. Every other reading in this report would call that a pass,');
  lines.push('which is why the rung list is here and is read from the shipped overlay rather than from');
  lines.push('the media element.');
  lines.push('');

  if (squeezed !== undefined) {
    lines.push(...vodSqueezeSection(squeezed));
    if (run.fragmentRequests !== undefined && run.samples.length > 0) {
      // On the report's own axis, seconds from its first sample, so this table reads straight against
      // the stretch table above it. The state file keeps the wall clock the boundaries were cut on.
      const firstSampleAtMs = run.samples[0].atMs;
      lines.push(...fragmentRequestSection(run.fragmentRequests, (atMs) => seconds(atMs - firstSampleAtMs)));
    }
  }

  if (run.seeks.length > 0) {
    lines.push('## Seeking');
    lines.push('');
    lines.push('| target | asked | landed | landed in | resumed in | |');
    lines.push('| --- | ---: | ---: | ---: | ---: | --- |');
    for (const seek of run.seeks) {
      lines.push(
        `| ${(seek.fraction * 100).toFixed(0)}% | ${seek.targetS.toFixed(2)}s | ` +
          `${seek.landedAtS?.toFixed(2) ?? '—'}s | ${seek.landedInMs ?? '—'}ms | ` +
          `${seek.resumedInMs ?? '—'}ms | ${seek.error ? `⛔ ${seek.error}` : '✅'} |`,
      );
    }
    lines.push('');
    lines.push('The last target is backwards on purpose: a forward seek can be served by what the player');
    lines.push('already buffered, and a backward one into a discarded region cannot.');
    lines.push('');
  }

  // On the success path as well, because a seek that fails leaves its evidence on the element rather
  // than in the seek row: a target inside a buffered range with the element paused is a different
  // fault from one that ran out of media, and the row above cannot tell them apart.
  lines.push(...renderWhatThePlayerDid(run));
  lines.push(...costSection(run.cost));
  return lines.join('\n');
}

/**
 * The squeeze readings as one report, or undefined where this run did not squeeze anything.
 *
 * ⛔ All three or none. The three are written together by a squeeze run and by nothing else, so a
 * file carrying some of them is malformed rather than a plain playback, and rendering half a squeeze
 * beside a seek battery's headline is exactly the mislabelled artifact this driver has already met.
 */
function squeezeReportOf(run: {
  quality?: VodSqueezeReport['quality'];
  throttle?: VodSqueezeReport['throttle'];
  vodSqueeze?: VodSqueezeReport['phases'];
}): VodSqueezeReport | undefined {
  const { quality, throttle, vodSqueeze } = run;
  if (quality === undefined || throttle === undefined || vodSqueeze === undefined) {
    return undefined;
  }
  return { quality, throttle, phases: vodSqueeze };
}

/**
 * Everything that separates one way of not playing from another. A request log ends at "a segment
 * arrived", and every fault after that point looks the same from there.
 */
function renderWhatThePlayerDid(run: {
  afterSettle?: PlaybackReading;
  player: PlayerProbe;
  messages: PageMessage[];
}): string[] {
  const lines: string[] = ['### What the player did with what it was handed', ''];
  const bytes = run.player.appends.reduce((total, append) => total + append.bytes, 0);

  lines.push('| | |');
  lines.push('| --- | --- |');
  lines.push(`| probe installed | ${run.player.installed} |`);
  lines.push(`| networkState | ${run.afterSettle?.networkState ?? '—'} |`);
  lines.push(`| source buffers | ${run.player.sourceBuffers.join(', ') || 'none were ever created'} |`);
  lines.push(`| appends | ${run.player.appends.length}, ${bytes.toLocaleString()} bytes |`);
  lines.push('');

  run.player.failures.forEach((failure) => lines.push(`- ⛔ ${failure}`));

  lines.push('', '#### What each track holds', '');
  lines.push('`HTMLMediaElement.buffered` is the intersection of these, so the shortest one sets the');
  lines.push('whole timeline and the element cannot say which track did it.');
  lines.push('');
  lines.push('| track | buffered |');
  lines.push('| --- | --- |');
  run.player.tracks.forEach((track) => {
    const ranges = track.buffered.map(([from, to]) => `${from.toFixed(3)} - ${to.toFixed(3)}`).join(', ');
    lines.push(`| \`${track.mime}\` | ${ranges || 'nothing'} |`);
  });

  lines.push('', '#### The media elements on the page', '');
  lines.push('| # | readyState | currentTime | paused | muted | autoplay | buffered | error |');
  lines.push('| --- | ---: | ---: | --- | --- | --- | --- | --- |');
  run.player.elements.forEach((media, index) => {
    const ranges = media.buffered.map(([from, to]) => `${from.toFixed(2)}-${to.toFixed(2)}`).join(', ') || 'nothing';
    lines.push(
      `| ${index} | ${media.readyState} | ${media.currentTime.toFixed(2)}s | ${media.paused} | ` +
        `${media.muted} | ${media.autoplay} | ${ranges} | ${media.error ?? 'none'} |`,
    );
  });

  lines.push('', '#### What the element did, in order', '');
  if (run.player.events.length === 0) {
    lines.push('Nothing. No media event fired at all.');
  }
  run.player.events.forEach((event) =>
    lines.push(`- \`${event.atMs}ms\` ${event.name} (readyState ${event.readyState})`),
  );

  if (run.messages.length > 0) {
    lines.push('', '#### What the page said', '');
    run.messages.forEach((message) => lines.push(`- \`${message.type}\` ${message.text}`));
  }
  lines.push('');

  return lines;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/** Every rung any sample saw, so a ladder that arrived late is still counted. */
function ladderOfRecording(samples: readonly ViewerSample[]): readonly number[] {
  return distinct(samples.flatMap((sample) => [...sample.ladderHeights]));
}

function distinct(values: readonly (number | null)[]): readonly number[] {
  const seen: number[] = [];
  for (const value of values) {
    if (value !== null && !seen.includes(value)) {
      seen.push(value);
    }
  }
  return seen;
}
