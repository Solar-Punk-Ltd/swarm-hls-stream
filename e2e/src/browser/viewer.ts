/**
 * Driving a real Chrome at the deployed client, and reading a viewer's session out of it.
 *
 * ## Why headed under Xvfb, and why no throttling flags
 *
 * Chromium takes `--disable-background-timer-throttling` and friends, and every automation guide
 * reaches for them. This does not, deliberately.
 *
 * The point of the run is to find out whether a viewer's player holds the buffer it is configured
 * with. That question is only answerable in a browser behaving as a foregrounded tab, and the
 * previous attempt failed precisely because the page was permanently hidden. Passing the flags would
 * make the timer probe in {@link readInstrument} pass whether or not the page was really
 * foregrounded, which converts the harness's one honest self-check into a restatement of its own
 * command line. Run headed against a real X display instead, and let the probe measure something.
 *
 * The one flag that is passed relaxes the autoplay gate, which is not a degradation being masked: a
 * viewer satisfies that gate by clicking, and there is nobody here to click.
 *
 * ## Why real Chrome rather than the bundled Chromium
 *
 * Playwright's Chromium is the open-source build with no H.264 or AAC. It would load the page, run
 * hls.js, fetch every segment from Swarm and decode none of them, which looks exactly like a
 * delivery failure. See `REQUIRED_CODECS`.
 */

import { type Browser, chromium, type Page } from 'playwright-core';

import { type InstrumentReading, REQUIRED_CODECS, TIMER_PROBE_INTERVAL_MS } from './instrument.js';
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
  overlayRows: OverlayRow[];
}

/**
 * One coherent snapshot of the player.
 *
 * The video element and the overlay are read in a single `evaluate` on purpose. Two round trips
 * would let the media position and the latency come from different instants, which is a
 * disagreement of exactly the size being measured.
 */
export async function readSample(page: Page): Promise<ViewerSample> {
  const raw = await page.evaluate((): RawSample | null => {
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

    return {
      atMs: Date.now(),
      currentTime: video.currentTime,
      paused: video.paused,
      readyState: video.readyState,
      playbackRate: video.playbackRate,
      bufferAheadS,
      overlayRows,
    };
  });

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
    liveLatencyS: metrics.liveLatencyS,
    rebufferCount: metrics.rebufferCount,
    rebufferMs: metrics.rebufferMs,
    fatalErrors: metrics.fatalErrors,
    droppedFrames: metrics.droppedFrames,
    resolution: metrics.resolution,
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
