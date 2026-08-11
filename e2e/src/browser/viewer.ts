/**
 * Driving a real Chrome at the deployed client, and reading a viewer's session out of it.
 *
 * ## Why headed under Xvfb, and ⛔ why the throttling flags ARE passed anyway
 *
 * The point of the run is to find out whether a viewer's player holds the buffer it is configured
 * with. That question is only answerable in a browser behaving as a foregrounded tab, and the
 * previous attempt failed precisely because the page was permanently hidden. So this file passes no
 * throttling flags of its own, and runs headed against a real X display, and the reasoning for that
 * is sound.
 *
 * ⛔⛔ **It does not achieve what it says, because playwright-core passes them regardless.** Verified
 * against the published 1.61.1 tarball on 2026-08-11: `--disable-background-timer-throttling`,
 * `--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding` are in its
 * hardcoded default argument list, and it sends `Emulation.setFocusEmulationEnabled({enabled: true})`
 * on every main frame, which forces `visibilityState` to `visible` on a genuinely hidden page.
 *
 * ⭐⭐⭐ So **both** checks in {@link judgeInstrument} pass by construction here: the visibility one
 * because Playwright forces it, the timer one because Playwright unthrottles it. They are exactly the
 * "restatement of its own command line" this comment was written to prevent, and the reasoning above
 * is what makes that worth saying rather than quietly deleting.
 *
 * ⚠️ The runs are still believed: under Xvfb the page really is foregrounded, so the flags change
 * nothing about what happened. What is gone is the **proof**, and a guard that cannot fail is not
 * evidence that the thing it guards is true. Setting `ignoreDefaultArgs` does not fix it either, as
 * the focus-emulation handle is keyed to Playwright's own CDP session and a second session cannot
 * release it.
 *
 * The one flag that is passed relaxes the autoplay gate, which is not a degradation being masked: a
 * viewer satisfies that gate by clicking, and there is nobody here to click.
 *
 * ## ⛔ Why real Chrome rather than the bundled Chromium, AND WHY THAT REASON HAS EXPIRED
 *
 * This installed Google Chrome because Playwright's Chromium was the open-source build with no H.264
 * or AAC: it would load the page, run hls.js, fetch every segment from Swarm and decode none of them,
 * which looks exactly like a delivery failure.
 *
 * **Playwright v1.57 replaced the bundled Chromium with Chrome for Testing, which has shipped the
 * proprietary codecs since 119.** Measured 2026-08-11 on **linux64**, the platform
 * `Dockerfile.browser` actually builds, using the pinned playwright-core 1.61.1 and its own browser
 * revision 1228 / 149.0.7827.55: `isTypeSupported` and `canPlayType` both answer for
 * `avc1.42E01E` and `mp4a.40.2`, and a bogus codec answers false, so the probe discriminates.
 *
 * ⚠️ The v1.57 notes carve out Arm64 Linux, which continues on Chromium. This was verified on x86-64
 * only, which is what the image builds.
 *
 * So the codec argument no longer chooses anything, and no replacement argument is offered here
 * rather than invented. Whether to drop the apt repository for Chrome for Testing, which would pin
 * the browser by the lockfile instead of leaving it unpinnable, is an open decision.
 *
 * ⭐ `REQUIRED_CODECS` asserts this at runtime rather than trusting any of the above, which is the
 * property that made it safe to re-examine at all. See `instrument.ts`.
 */

import { type Browser, chromium, type Page, type Request } from 'playwright-core';

import { type InstrumentReading, REQUIRED_CODECS, TIMER_PROBE_INTERVAL_MS } from './instrument.js';
import { type RequestRecord } from './network.js';
import { type OverlayRow, readOverlayMetrics } from './overlay.js';
import { type ViewerSample } from './session.js';

/** Where the image puts Google Chrome. Overridable so a workstation with Chrome elsewhere can run this. */
export const CHROME_PATH = process.env.BROWSER_CHROME_PATH ?? '/opt/google/chrome/chrome';

/** A desktop viewport, since that is what the client's layout is built for. */
export const VIEWPORT = { width: 1440, height: 900 } as const;

/** The card the browse page renders per stream, as `StreamPreview.tsx` classes it. */
const STREAM_CARD = '.stream-preview';

/** How long to wait for the catalog to produce a stream to watch. */
const CATALOG_TIMEOUT_MS = 60_000;

/**
 * Find something to watch the way a viewer does: open the browse page and click a stream.
 *
 * The alternative is composing the watch URL from the owner and topic, which means knowing them,
 * which means reading them out of the deployment rather than out of the product. Going through the
 * catalog costs one page load and gets the discovery path exercised for free, so a run that cannot
 * find a stream fails here, plainly, rather than as a player that never starts.
 */
export async function discoverWatchUrl(page: Page, clientUrl: string): Promise<string> {
  await page.goto(clientUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(STREAM_CARD, { timeout: CATALOG_TIMEOUT_MS });
  await page.click(STREAM_CARD);
  await page.waitForURL(/\/watch\//, { timeout: CATALOG_TIMEOUT_MS });

  // `qoe=1` turns on the shipped overlay, which is where `hls.latency` becomes readable from outside.
  // Appended and reloaded rather than clicked into, so the session being sampled is one whose
  // metrics were collected from its own first frame.
  return `${page.url().split('?')[0]}?qoe=1`;
}

export async function launchViewer(): Promise<Browser> {
  return chromium.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
}

/**
 * Install the timer-fidelity probe, before the app runs.
 *
 * `addInitScript` rather than an `evaluate` after load, because the throttling this screens for is
 * triggered by the first stall, and a probe installed after the app has started could miss the
 * window it exists to catch.
 */
export async function installTimerProbe(page: Page): Promise<void> {
  await page.addInitScript((intervalMs: number) => {
    const probe = { lastIntervalMs: intervalMs, lastFireAtMs: performance.now() };
    (window as unknown as Record<string, unknown>).__timerProbe = probe;
    setInterval(() => {
      const now = performance.now();
      probe.lastIntervalMs = now - probe.lastFireAtMs;
      probe.lastFireAtMs = now;
    }, intervalMs);
  }, TIMER_PROBE_INTERVAL_MS);
}

export async function readInstrument(page: Page): Promise<InstrumentReading> {
  return page.evaluate(
    ([intervalMs, codecs]: [number, readonly string[]]) => {
      const probe = (window as unknown as Record<string, { lastIntervalMs: number; lastFireAtMs: number }>)
        .__timerProbe;
      // The longer of "how late the last interval was" and "how long since it last fired". Without
      // the second term a timer throttled to one a minute reads as healthy for the 59 seconds
      // between fires, because the last completed interval is still the old, punctual one.
      const sinceLastFire = performance.now() - probe.lastFireAtMs;
      const worstMs = Math.max(probe.lastIntervalMs, sinceLastFire);

      return {
        visibilityState: document.visibilityState,
        timerDriftRatio: worstMs / intervalMs,
        codecSupport: Object.fromEntries(codecs.map((codec) => [codec, MediaSource.isTypeSupported(codec)])),
      };
    },
    [TIMER_PROBE_INTERVAL_MS, REQUIRED_CODECS] as [number, readonly string[]],
  );
}

interface RawSample {
  atMs: number;
  currentTime: number;
  paused: boolean;
  readyState: number;
  playbackRate: number;
  bufferAheadS: number;
  decodedFrames: number | null;
  overlayRows: OverlayRow[];
  feedStateMessage: string | null;
}

/**
 * The shipped feed-state overlay, which renders nothing at all while the feed is live.
 *
 * Read by class rather than by message text, so a reworded message stays readable here and a
 * restyled one does not. `FeedStateOverlay.tsx`.
 */
const FEED_STATE_OVERLAY = '.swarm-hls-feed-state';

/**
 * One coherent snapshot of the player.
 *
 * The video element and the overlay are read in a single `evaluate` on purpose. Two round trips
 * would let the media position and the latency come from different instants, which is a
 * disagreement of exactly the size being measured.
 */
export async function readSample(page: Page): Promise<ViewerSample> {
  const raw = await page.evaluate((feedStateSelector: string): RawSample | null => {
    const video = document.querySelector('video');
    if (!video) {
      return null;
    }

    const buffered = video.buffered;
    const bufferAheadS = buffered.length > 0 ? buffered.end(buffered.length - 1) - video.currentTime : 0;

    const overlayRows = Array.from(document.querySelectorAll('.qoe-overlay__section')).flatMap((section) => {
      const title = section.querySelector('.qoe-overlay__section-title')?.textContent?.trim() ?? '';
      return Array.from(section.querySelectorAll('.qoe-overlay__row')).map((row) => ({
        section: title,
        label: row.querySelector('.qoe-overlay__label')?.textContent?.trim() ?? '',
        value: row.querySelector('.qoe-overlay__value')?.textContent?.trim() ?? '',
      }));
    });

    // Every frame the decoder has produced this session. Divided by media time rather than wall time
    // it is the frame rate that actually arrived, which is the only way to see a stream whose frame
    // rate collapsed: nothing errors, the picture just carries less motion than it was asked for.
    const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;

    return {
      atMs: Date.now(),
      currentTime: video.currentTime,
      paused: video.paused,
      readyState: video.readyState,
      playbackRate: video.playbackRate,
      bufferAheadS,
      decodedFrames: quality?.totalVideoFrames ?? null,
      overlayRows,
      feedStateMessage: document.querySelector(feedStateSelector)?.textContent?.trim() || null,
    };
  }, FEED_STATE_OVERLAY);

  if (!raw) {
    throw new Error('the watch page rendered no <video> element, so there is no session to sample');
  }
  if (raw.overlayRows.length === 0) {
    throw new Error(
      'the QoE overlay rendered no rows. It is turned on with ?qoe=1 and the run cannot read a latency without it.',
    );
  }

  const metrics = readOverlayMetrics(raw.overlayRows);
  return {
    atMs: raw.atMs,
    currentTime: raw.currentTime,
    paused: raw.paused,
    readyState: raw.readyState,
    playbackRate: raw.playbackRate,
    bufferAheadS: raw.bufferAheadS,
    decodedFrames: raw.decodedFrames,
    liveLatencyS: metrics.liveLatencyS,
    liveTargetLatencyS: metrics.liveTargetLatencyS,
    bufferStalls: metrics.bufferStalls,
    rebufferCount: metrics.rebufferCount,
    rebufferMs: metrics.rebufferMs,
    fatalErrors: metrics.fatalErrors,
    droppedFrames: metrics.droppedFrames,
    resolution: metrics.resolution,
    feedStateMessage: raw.feedStateMessage,
  };
}

/**
 * Stamp the browser's own clock onto the page, so one screenshot carries both clocks.
 *
 * The publisher burns the host's wall clock into the picture as epoch seconds. This puts the
 * viewer's clock beside it in the same pixels, and the difference between the two numbers in one
 * screenshot is the whole path with the player's own buffering inside it. Read off one image rather
 * than two calls, because anything crossing the wire between them lands in the answer: measured over
 * ssh, that round trip is 2.5 to 3.1 seconds and asymmetric.
 */
/**
 * Record every request the page makes, so a stall can be attributed rather than guessed at.
 *
 * Timings come from the harness's own clock at the request and response events rather than from the
 * page's Resource Timing, because a refused request is the interesting one and the interval that
 * matters is the **gap between** requests, which no per-request timing API reports.
 *
 * Sizes come from the response body length where the body is available. A 404 carries no segment, so
 * it contributes nothing to throughput, which is what makes bytes-per-second a measure of delivery
 * rather than of asking.
 */
export function recordRequests(page: Page, into: RequestRecord[]): void {
  const startedAtMs = new Map<Request, number>();
  page.on('request', (request) => startedAtMs.set(request, Date.now()));

  const finish = (request: Request, status: number | null, bytes: number) => {
    const started = startedAtMs.get(request);
    if (started === undefined) {
      return;
    }
    startedAtMs.delete(request);
    into.push({ url: request.url(), status, startedAtMs: started, endedAtMs: Date.now(), bytes });
  };

  page.on('requestfailed', (request) => finish(request, null, 0));
  page.on('response', (response) => {
    // The body is read for its length only, and a response that cannot be read (redirect, aborted)
    // still has to land in the log with its status, or a refusal would go uncounted.
    response
      .body()
      .then((body) => finish(response.request(), response.status(), body.length))
      .catch(() => finish(response.request(), response.status(), 0));
  });
}

export const CLOCK_OVERLAY_ID = 'harness-clock';

/**
 * Called **after** navigating, not as an init script.
 *
 * An init script runs against a document with no `<body>` yet, so it has to defer to
 * `DOMContentLoaded`, and from there any error it raises is swallowed with no report anywhere.
 * Running it against a page that already exists means a failure comes back as a rejected call.
 *
 * **Nothing in the evaluated body may be a named function.** tsx transpiles with esbuild's
 * `keepNames`, which wraps each named function in a `__name(...)` helper that exists in the harness
 * and not in the page, so `const paint = () => {}` arrives as `ReferenceError: __name is not
 * defined`. That is what the first version of this overlay did, and from inside an init script it
 * failed silently: `browser:selfcheck` said `NOT RENDERED` while the run reported success. The
 * repainting interval below is anonymous for that reason, not by preference.
 */
export async function installClockOverlay(page: Page): Promise<void> {
  await page.evaluate((id: string) => {
    if (document.getElementById(id)) {
      return;
    }
    const node = document.createElement('div');
    node.id = id;
    // Bottom-left, because the publisher burns its clock into the bottom of the picture and the
    // player's own QoE panel occupies the top right. Two clocks in one frame is the whole point, so
    // neither may sit on top of the other.
    node.style.cssText =
      'position:fixed;left:0;bottom:0;z-index:2147483647;background:#000;color:#0f0;' +
      'font:700 28px/1.2 monospace;padding:6px 10px;';
    document.body.appendChild(node);
    // Ten times the resolution of the tenth-of-a-second it prints, so the number in a screenshot is
    // never more than one tick stale.
    setInterval(() => {
      node.textContent = `viewer ${(Date.now() / 1000).toFixed(1)}`;
    }, 100);
  }, CLOCK_OVERLAY_ID);
}

/**
 * Screenshot with both clocks legible, then put the page back as it was.
 *
 * The player's QoE panel sits over the picture and covers the clock the publisher burned into it, so
 * a screenshot taken as-is carries one clock and a panel. `q` is the overlay's own shipped toggle,
 * which means the harness hides it the way a viewer would rather than by reaching into the page.
 *
 * The metrics are not lost by hiding it: the sample beside this screenshot already read them.
 */
export async function screenshotBothClocks(page: Page, path: string): Promise<boolean> {
  await page.keyboard.press('q');
  await page.screenshot({ path });
  await page.keyboard.press('q');

  // Reported rather than assumed. A missing overlay makes the screenshot carry one clock instead of
  // two, which is invisible in a filename and fatal to the only measurement it exists for.
  return page.evaluate((id: string) => document.getElementById(id) !== null, CLOCK_OVERLAY_ID);
}
