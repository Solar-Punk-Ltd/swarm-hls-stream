/**
 * `pnpm browser:watch` — watch a live broadcast in a real browser and report what the viewer got.
 *
 * This is task #48, and it is the last thing standing between this project and any statement about
 * what a viewer sees. Everything measured so far stops at "capture to fetchable": the instant a
 * segment could first be retrieved from the gateway. A viewer does not watch the fetchable edge,
 * they watch whatever their player chose to play, which sits a further `LIVE_SYNC_DURATION_S` behind
 * it. That constant was derived from arrival times rather than observed, and a player can fail to
 * honour it in two directions, neither visible from outside a browser.
 *
 * Usage, on the deployment host, against a broadcast that is already running:
 *   deploy/scripts/browser-on-host.sh -- BROWSER_WATCH_SECONDS=180
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type InstrumentReading, judgeRun } from '../src/browser/instrument.js';
import { type RequestRecord, summarizeNetwork } from '../src/browser/network.js';
import { renderBrowserReport } from '../src/browser/report.js';
import { summarize, type ViewerSample } from '../src/browser/session.js';
import {
  discoverWatchUrl,
  installClockOverlay,
  installTimerProbe,
  launchViewer,
  readInstrument,
  readSample,
  recordRequests,
  screenshotBothClocks,
  VIEWPORT,
} from '../src/browser/viewer.js';
import { ROOT_DIR } from '../src/config.js';

const REPORT_DIR = join(ROOT_DIR, 'docs', 'bench');
const SCREENSHOT_DIR = join(REPORT_DIR, 'browser-screenshots');

const DEFAULT_WATCH_SECONDS = 180;
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;

/** How long to wait for the page to reach playing before giving up on the run. */
const PLAYBACK_START_TIMEOUT_MS = 90_000;

/** How many samples between screenshots. Enough for a clock comparison, not a flipbook. */
const SCREENSHOT_EVERY = 30;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got '${raw}'`);
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. browser-on-host.sh reads it out of the deployed profile.`);
  }
  return value;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const clientUrl = requireEnv('BROWSER_CLIENT_URL');
  const watchSeconds = envNumber('BROWSER_WATCH_SECONDS', DEFAULT_WATCH_SECONDS);
  const intervalMs = envNumber('BROWSER_SAMPLE_INTERVAL_MS', DEFAULT_SAMPLE_INTERVAL_MS);
  const gopSeconds = envNumber('BROWSER_GOP_SECONDS', 0.25);

  const browser = await launchViewer();
  const chromeVersion = `Chrome ${browser.version()}`;
  console.log(`browser: ${chromeVersion}, watching via ${clientUrl} for ${watchSeconds}s`);

  const samples: ViewerSample[] = [];
  const readings: InstrumentReading[] = [];
  const screenshots: string[] = [];
  const requests: RequestRecord[] = [];
  let watchUrl = clientUrl;

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await installTimerProbe(page);
    recordRequests(page, requests);

    // Surfaced rather than swallowed: a fatal hls.js error prints its own line in the client, and a
    // run that stalled for a reason the page already explained should not need a second investigation.
    page.on('console', (message) => {
      if (message.type() === 'error') {
        console.log(`  page error: ${message.text()}`);
      }
    });

    watchUrl = process.env.BROWSER_WATCH_URL || (await discoverWatchUrl(page, clientUrl));
    console.log(`browser: watching ${watchUrl}`);
    await page.goto(watchUrl, { waitUntil: 'domcontentloaded' });
    await installClockOverlay(page);

    // Wait for playback rather than for a selector: the video element exists from the first render
    // and says nothing about whether anything arrived.
    await page.waitForFunction(
      () => {
        const video = document.querySelector('video');
        return video !== null && !video.paused && video.currentTime > 0;
      },
      { timeout: PLAYBACK_START_TIMEOUT_MS },
    );
    console.log('browser: playback started');

    await mkdir(SCREENSHOT_DIR, { recursive: true });
    const deadline = Date.now() + watchSeconds * 1000;
    while (Date.now() < deadline) {
      readings.push(await readInstrument(page));
      const sample = await readSample(page);
      samples.push(sample);

      if (samples.length % SCREENSHOT_EVERY === 1) {
        const path = join(SCREENSHOT_DIR, `sample-${String(samples.length).padStart(4, '0')}.png`);
        if (!(await screenshotBothClocks(page, path))) {
          throw new Error(
            `the viewer clock overlay is not in the page, so ${path} carries the publisher's clock and ` +
              'nothing to compare it against. The glass-to-glass reading is the only thing these images ' +
              'are for.',
          );
        }
        screenshots.push(path);
      }

      if (samples.length % 30 === 0) {
        console.log(
          `  ${samples.length} samples, ${sample.liveLatencyS?.toFixed(2) ?? '—'}s behind live, ` +
            `${sample.rebufferCount} rebuffers`,
        );
      }
      await sleep(intervalMs);
    }
  } finally {
    await browser.close();
  }

  if (samples.length === 0) {
    throw new Error('no samples collected');
  }

  const run = {
    measuredAt: new Date().toISOString(),
    watchUrl,
    chromeVersion,
    gopSeconds,
    summary: summarize(samples),
    instrument: judgeRun(readings),
    network: summarizeNetwork(requests),
    samples,
    screenshots,
  };

  await mkdir(REPORT_DIR, { recursive: true });
  const stem = join(REPORT_DIR, `browser-watch-${run.measuredAt.replace(/[:.]/g, '-')}`);
  await writeFile(`${stem}.md`, renderBrowserReport(run), 'utf8');
  await writeFile(`${stem}.json`, JSON.stringify(run, null, 2), 'utf8');
  // Kept beside the report rather than inside it: a three-minute watch makes thousands of requests,
  // and the answer to "why did it stall" is usually a distribution over them rather than one row.
  await writeFile(`${stem}.requests.json`, JSON.stringify(requests), 'utf8');

  console.log(`\nbrowser: wrote ${stem}.md`);
  console.log(`browser: instrument ${run.instrument.sound ? 'SOUND' : 'VOID'}`);
  run.instrument.failures.forEach((failure) => console.log(`  ⛔ ${failure}`));
  console.log(
    `browser: ${run.summary.latency.medianLatencyS?.toFixed(2) ?? '—'}s behind live, ` +
      `${run.summary.rebufferCount} rebuffers, ${run.summary.stalledSamples} stalled samples`,
  );

  // A void instrument is a failed run, not a run with a caveat. Exiting non-zero is what keeps a
  // degraded reading from being quoted by whatever called this.
  if (!run.instrument.sound) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
