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
 * Usage, on the deployment host, against a stream that has already finished:
 *   deploy/scripts/browser-on-host.sh --script browser:vod -- \
 *     BROWSER_VOD_OWNER=<owner> BROWSER_VOD_TOPIC=<rawTopic>
 */

import { type Page } from 'playwright-core';

import { judgeRun } from '../src/browser/instrument.js';
import { type RequestRecord, summarizeNetwork } from '../src/browser/network.js';
import { envNumber, requireEnv, runIdFrom, thinRequestLog, writeRunArtifacts } from '../src/browser/runFiles.js';
import { installTimerProbe, launchViewer, readInstrument, recordRequests, VIEWPORT } from '../src/browser/viewer.js';

/** How long to watch from the start before seeking, so ordinary playback is established first. */
const SETTLE_SECONDS = 8;
/** How long to allow a seek to land and playback to resume before calling it stalled. */
const SEEK_TIMEOUT_MS = 20_000;
/** How far `currentTime` may sit from the seek target and still count as landed. */
const SEEK_TOLERANCE_S = 1.5;

/** Where in the recording to seek, as a fraction of its duration. Ends backwards on purpose. */
const SEEK_FRACTIONS = [0.5, 0.9, 0.2] as const;

interface PlaybackReading {
  currentTime: number;
  duration: number;
  buffered: number;
  readyState: number;
  paused: boolean;
  seekable: number;
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
  return page.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) {
      return { currentTime: 0, duration: 0, buffered: 0, readyState: 0, paused: true, seekable: 0 };
    }
    return {
      currentTime: video.currentTime,
      duration: video.duration,
      buffered: video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0,
      readyState: video.readyState,
      paused: video.paused,
      seekable: video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) : 0,
    };
  });
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

  const measuredAt = new Date().toISOString();
  const runId = runIdFrom(measuredAt);
  const watchUrl = `${clientUrl}/watch/${mediatype}/${owner}/${topic}?qoe=1`;

  const browser = await launchViewer();
  const chromeVersion = `Chrome ${browser.version()}`;
  console.log(`browser: ${chromeVersion}, playing back ${watchUrl}`);

  const requests: RequestRecord[] = [];
  let startedPlaying: PlaybackReading | undefined;
  let afterSettle: PlaybackReading | undefined;
  const seeks: SeekResult[] = [];
  let openError: string | null = null;

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    recordRequests(page, requests);
    await installTimerProbe(page);
    page.on('console', (message) => {
      if (message.type() === 'error') {
        console.log(`  page error: ${message.text()}`);
      }
    });

    await page.goto(watchUrl, { waitUntil: 'domcontentloaded' });

    // A recording that never starts is the headline result, not an exception, so the wait is caught.
    try {
      await page.waitForFunction(
        () => {
          const video = document.querySelector('video');
          return video !== null && video.readyState >= 2 && video.currentTime > 0;
        },
        undefined,
        { timeout: 60_000 },
      );
      startedPlaying = await readPlayback(page);
      console.log(
        `browser: playing, duration ${startedPlaying.duration.toFixed(2)}s, ` +
          `seekable to ${startedPlaying.seekable.toFixed(2)}s`,
      );
    } catch {
      openError = 'the recording never started playing';
    }

    if (!openError) {
      await page.waitForTimeout(settleSeconds * 1000);
      afterSettle = await readPlayback(page);

      const duration = afterSettle.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        openError = `duration is ${duration}, so the player was not handed a finished playlist`;
      } else {
        for (const fraction of SEEK_FRACTIONS) {
          const seek = await seekTo(page, duration * fraction, fraction);
          seeks.push(seek);
          console.log(
            `browser: seek to ${(fraction * 100).toFixed(0)}% (${seek.targetS.toFixed(2)}s) ` +
              (seek.error ? `⛔ ${seek.error}` : `landed in ${seek.landedInMs}ms, resumed in ${seek.resumedInMs}ms`),
          );
        }
      }
    }

    const run = {
      measuredAt,
      watchUrl,
      chromeVersion,
      openError,
      startedPlaying,
      afterSettle,
      seeks,
      instrument: judgeRun([await readInstrument(page)]),
      network: summarizeNetwork(requests),
    };

    const stem = await writeRunArtifacts('browser-vod', runId, {
      markdown: renderVodReport(run),
      run,
      requests: thinRequestLog(requests),
    });

    console.log(`\nbrowser: wrote ${stem}.md`);
    const failed = openError !== null || seeks.some((seek) => seek.error !== null);
    console.log(`browser: playback ${openError ?? 'started'}, seeks ${failed ? 'FAILED' : 'all landed and resumed'}`);
  } finally {
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
  instrument: { sound: boolean; failures: string[] };
  network: unknown;
}): string {
  const lines: string[] = [];
  lines.push('# Playing a recording back, and seeking inside it');
  lines.push('');
  lines.push(`**${run.measuredAt}.** ${run.chromeVersion}, \`${run.watchUrl}\`.`);
  lines.push('');
  lines.push(`Instrument: **${run.instrument.sound ? 'SOUND' : 'VOID'}**`);
  run.instrument.failures.forEach((failure) => lines.push(`- ⛔ ${failure}`));
  lines.push('');

  if (run.openError) {
    lines.push(`## ⛔ ${run.openError}`);
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## What the player was handed');
  lines.push('');
  lines.push('| | |');
  lines.push('| --- | ---: |');
  lines.push(`| duration | ${run.afterSettle?.duration.toFixed(2)}s |`);
  lines.push(`| seekable to | ${run.afterSettle?.seekable.toFixed(2)}s |`);
  lines.push(`| buffered ahead | ${run.afterSettle?.buffered.toFixed(2)}s |`);
  lines.push(`| position after settling | ${run.afterSettle?.currentTime.toFixed(2)}s |`);
  lines.push('');
  lines.push('A finite duration is the whole point: a live playlist reports `Infinity` here, so this');
  lines.push('is what says the player received a finished playlist rather than a live window.');
  lines.push('');
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
  return lines.join('\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
