/**
 * Opening a viewer's session and sampling it, shared by every run that watches one.
 *
 * Extracted when the crash scenarios arrived, because a crash run is a watch run with the
 * infrastructure moving underneath it and nothing else. Kept in one place so the two cannot drift:
 * the whole point of a crash report is that its numbers are comparable to a clean one's, and two
 * copies of a sampling loop is exactly how that stops being true.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';

import { type InstrumentReading } from './instrument.js';
import { type ViewerSample } from './session.js';
import {
  discoverWatchUrl,
  installClockOverlay,
  installTimerProbe,
  readInstrument,
  readSample,
  screenshotBothClocks,
} from './viewer.js';

/** How long to wait for the page to reach playing before giving up on the run. */
export const PLAYBACK_START_TIMEOUT_MS = 90_000;

/** How many samples between screenshots. Enough for a clock comparison, not a flipbook. */
export const SCREENSHOT_EVERY = 30;

/** How many samples between progress lines, so a long run shows it is still watching something. */
const PROGRESS_EVERY = 30;

export const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Get a viewer to the point of watching something, the way a viewer does.
 *
 * @returns The url actually being watched, which the report needs so a reading can be traced to a
 *   broadcast.
 */
export async function openViewer(page: Page, clientUrl: string): Promise<string> {
  await installTimerProbe(page);

  // Surfaced rather than swallowed: a fatal hls.js error prints its own line in the client, and a
  // run that stalled for a reason the page already explained should not need a second investigation.
  page.on('console', (message) => {
    if (message.type() === 'error') {
      console.log(`  page error: ${message.text()}`);
    }
  });

  const watchUrl = process.env.BROWSER_WATCH_URL || (await discoverWatchUrl(page, clientUrl));
  console.log(`browser: watching ${watchUrl}`);
  await page.goto(watchUrl, { waitUntil: 'domcontentloaded' });
  await installClockOverlay(page);

  // Wait for playback rather than for a selector: the video element exists from the first render and
  // says nothing about whether anything arrived.
  await page.waitForFunction(
    () => {
      const video = document.querySelector('video');
      return video !== null && !video.paused && video.currentTime > 0;
    },
    { timeout: PLAYBACK_START_TIMEOUT_MS },
  );
  console.log('browser: playback started');

  return watchUrl;
}

export interface SamplingOptions {
  page: Page;
  /** How long this stretch runs for. A crash run is three stretches with a fault between them. */
  forMs: number;
  intervalMs: number;
  screenshotDir: string;
  /** Where this stretch's samples start in the run as a whole, so screenshots stay numbered in order. */
  startIndex: number;
}

export interface SampledStretch {
  samples: ViewerSample[];
  readings: InstrumentReading[];
  screenshots: string[];
}

/**
 * Sample one stretch of a session.
 *
 * The instrument reading is taken on **every** sample rather than once at the start, because the
 * degradation it screens for is a consequence of the first stall rather than a property of the page
 * at load: Chromium throttles a hidden page's timers to about one a minute once playback stops, and
 * that is precisely the moment a crash scenario is measuring.
 */
export async function sampleFor(options: SamplingOptions): Promise<SampledStretch> {
  const { page, forMs, intervalMs, screenshotDir, startIndex } = options;
  const samples: ViewerSample[] = [];
  const readings: InstrumentReading[] = [];
  const screenshots: string[] = [];

  await mkdir(screenshotDir, { recursive: true });
  const deadline = Date.now() + forMs;

  while (Date.now() < deadline) {
    readings.push(await readInstrument(page));
    samples.push(await readSample(page));

    const index = startIndex + samples.length;
    if (index % SCREENSHOT_EVERY === 1) {
      const path = join(screenshotDir, `sample-${String(index).padStart(4, '0')}.png`);
      if (!(await screenshotBothClocks(page, path))) {
        throw new Error(
          `the viewer clock overlay is not in the page, so ${path} carries the publisher's clock and ` +
            'nothing to compare it against. The glass-to-glass reading is the only thing these images ' +
            'are for.',
        );
      }
      screenshots.push(path);
    }

    if (index % PROGRESS_EVERY === 0) {
      const latest = samples[samples.length - 1];
      console.log(
        `  ${index} samples, ${latest.liveLatencyS?.toFixed(2) ?? '—'}s behind live, ` +
          `${latest.rebufferCount} rebuffers${latest.feedStateMessage ? `, "${latest.feedStateMessage}"` : ''}`,
      );
    }

    await sleep(intervalMs);
  }

  return { samples, readings, screenshots };
}
