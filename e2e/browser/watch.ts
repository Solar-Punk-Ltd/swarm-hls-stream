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

import { judgeRun } from '../src/browser/instrument.js';
import { type RequestRecord, summarizeNetwork } from '../src/browser/network.js';
import { renderBrowserReport } from '../src/browser/report.js';
import { envNumber, requireEnv, runIdFrom, screenshotDirFor, writeRunArtifacts } from '../src/browser/runFiles.js';
import { summarize } from '../src/browser/session.js';
import { launchViewer, recordRequests, VIEWPORT } from '../src/browser/viewer.js';
import { DEFAULT_SAMPLE_INTERVAL_MS, openViewer, type SampledStretch, sampleFor } from '../src/browser/watchLoop.js';

const DEFAULT_WATCH_SECONDS = 180;

async function main(): Promise<void> {
  const clientUrl = requireEnv('BROWSER_CLIENT_URL');
  const watchSeconds = envNumber('BROWSER_WATCH_SECONDS', DEFAULT_WATCH_SECONDS);
  const intervalMs = envNumber('BROWSER_SAMPLE_INTERVAL_MS', DEFAULT_SAMPLE_INTERVAL_MS);
  const gopSeconds = envNumber('BROWSER_GOP_SECONDS', 0.25);

  const measuredAt = new Date().toISOString();
  const runId = runIdFrom(measuredAt);

  const browser = await launchViewer();
  const chromeVersion = `Chrome ${browser.version()}`;
  console.log(`browser: ${chromeVersion}, watching via ${clientUrl} for ${watchSeconds}s`);

  const requests: RequestRecord[] = [];
  let watched: SampledStretch | undefined;
  let watchUrl = clientUrl;

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    recordRequests(page, requests);

    watchUrl = await openViewer(page, clientUrl);
    watched = await sampleFor({
      page,
      forMs: watchSeconds * 1000,
      intervalMs,
      screenshotDir: screenshotDirFor(runId),
      startIndex: 0,
    });
  } finally {
    await browser.close();
  }

  if (!watched || watched.samples.length === 0) {
    throw new Error('no samples collected');
  }

  const run = {
    measuredAt,
    watchUrl,
    chromeVersion,
    gopSeconds,
    summary: summarize(watched.samples),
    instrument: judgeRun(watched.readings),
    network: summarizeNetwork(requests),
    samples: watched.samples,
    screenshots: watched.screenshots,
  };

  const stem = await writeRunArtifacts('browser-watch', runId, {
    markdown: renderBrowserReport(run),
    run,
    requests,
  });

  console.log(`\nbrowser: wrote ${stem}.md`);
  console.log(`browser: instrument ${run.instrument.sound ? 'SOUND' : 'VOID'}`);
  run.instrument.failures.forEach((failure) => console.log(`  ⛔ ${failure}`));
  console.log(
    `browser: ${run.summary.latency.medianLatencyS?.toFixed(2) ?? '—'}s behind live, ` +
      `${run.summary.rebufferCount} rebuffers, ${run.summary.stalledSamples} stalled samples`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
