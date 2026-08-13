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

import {
  DEFAULT_GATEWAY_SAMPLE_INTERVAL_MS,
  gatewayReader,
  type GatewaySample,
  startGatewaySampling,
  summarizeGateway,
} from '../src/browser/gatewayHealth.js';
import {
  armWasServedByItsGateway,
  gatewayArmIsComparable,
  readGateway,
  seedGateway,
} from '../src/browser/gatewaySweep.js';
import { judgeRun } from '../src/browser/instrument.js';
import { type RequestRecord, summarizeNetwork } from '../src/browser/network.js';
import { type ArmCondition, renderBrowserReport } from '../src/browser/report.js';
import { judgeCost, readResources } from '../src/browser/resources.js';
import {
  envNumber,
  envNumberOrNull,
  requireEnv,
  runIdFrom,
  screenshotDirFor,
  thinRequestLog,
  writeRunArtifacts,
} from '../src/browser/runFiles.js';
import { summarize } from '../src/browser/session.js';
import { launchViewer, proveInstrumentCanFail, recordRequests, VIEWPORT } from '../src/browser/viewer.js';
import { DEFAULT_SAMPLE_INTERVAL_MS, openViewer, type SampledStretch, sampleFor } from '../src/browser/watchLoop.js';
import { loadConfig } from '../src/config.js';
import { makeHost } from '../src/harness/host.js';

const DEFAULT_WATCH_SECONDS = 180;

async function main(): Promise<void> {
  const clientUrl = requireEnv('BROWSER_CLIENT_URL');
  const watchSeconds = envNumber('BROWSER_WATCH_SECONDS', DEFAULT_WATCH_SECONDS);
  const intervalMs = envNumber('BROWSER_SAMPLE_INTERVAL_MS', DEFAULT_SAMPLE_INTERVAL_MS);
  const gopSeconds = envNumberOrNull('BROWSER_GOP_SECONDS');
  // Set by a sitting that alternates gateways under one broadcast. Unset for every other caller, and
  // an unset gateway leaves this run exactly the watch it has always been.
  const armGateway = process.env.BROWSER_GATEWAY_URL || null;
  const armName = process.env.BROWSER_GATEWAY_ARM || 'arm';

  const measuredAt = new Date().toISOString();
  const runId = runIdFrom(measuredAt);

  // Read before the browser opens and again after it closes, so what the run cost is measured rather
  // than reconstructed from balances noticed at different times on different days.
  const cfg = loadConfig();
  const host = makeHost(cfg);
  const resourcesBefore = await readResources(host, cfg);

  const browser = await launchViewer();
  const chromeVersion = `Chrome ${browser.version()}`;
  // Taken before the measurement so an early failure downstream cannot leave the run reporting a
  // soundness verdict nothing ever tried to break.
  const instrumentProofs = await proveInstrumentCanFail(browser);
  console.log(`browser: ${chromeVersion}, watching via ${clientUrl} for ${watchSeconds}s`);

  const requests: RequestRecord[] = [];
  let watched: SampledStretch | undefined;
  let watchUrl = clientUrl;
  let arm: ArmCondition | undefined;

  // Started before the page opens and stopped in the same `finally` as the browser, so the node-side
  // series brackets the browser one rather than being a subset of it. A slowdown that begins during
  // startup is one the viewer-facing numbers cannot attribute at all.
  const gatewaySampling = startGatewaySampling({
    read: gatewayReader(host, cfg),
    intervalMs: envNumber('BROWSER_GATEWAY_SAMPLE_INTERVAL_MS', DEFAULT_GATEWAY_SAMPLE_INTERVAL_MS),
  });
  let gatewaySamples: GatewaySample[] = [];

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    // Before the page exists, so the client reads its gateway on the first render and this arm owns
    // its own join rather than buying it from whichever gateway the build defaults to.
    if (armGateway !== null) {
      await seedGateway(context, armGateway);
    }
    const page = await context.newPage();
    recordRequests(page, requests);

    watchUrl = await openViewer(page, clientUrl);

    // ⛔⛔⛔ Checked here, between playback starting and the first sample. An arm on the wrong gateway
    // is not a weaker arm, it is an arm of the other condition, and counting one would put the funded
    // node's numbers in the unfunded column. Failing before the sampling loop costs the sitting about
    // twenty seconds and writes no artifact anybody could later read as a result.
    if (armGateway !== null) {
      const setup = await readGateway(page);
      const notComparable = gatewayArmIsComparable(setup, armGateway);
      if (notComparable !== null) {
        throw new Error(`arm ${armName} is not the condition it claims: ${notComparable}`);
      }
      arm = { name: armName, requestedGateway: armGateway, reportedGateway: setup.gatewayUrl as string };
      console.log(`browser: arm ${armName} confirmed on ${arm.reportedGateway}`);
    }

    watched = await sampleFor({
      page,
      forMs: watchSeconds * 1000,
      intervalMs,
      screenshotDir: screenshotDirFor(runId),
      startIndex: 0,
      totalSamples: Math.ceil((watchSeconds * 1000) / intervalMs),
    });
  } finally {
    gatewaySamples = await gatewaySampling.stop();
    await browser.close();
  }

  if (!watched || watched.samples.length === 0) {
    throw new Error('no samples collected');
  }

  const network = summarizeNetwork(requests);
  const cost = judgeCost(resourcesBefore, await readResources(host, cfg), network.segmentBytesDelivered);
  const gateway = summarizeGateway(gatewaySamples);

  const run = {
    measuredAt,
    watchUrl,
    chromeVersion,
    gopSeconds,
    summary: summarize(watched.samples),
    instrumentProofs,
    instrument: judgeRun(watched.readings),
    network,
    samples: watched.samples,
    screenshots: watched.screenshots,
    cost,
    gateway,
    gatewaySamples,
    arm,
  };

  const stem = await writeRunArtifacts('browser-watch', runId, {
    markdown: renderBrowserReport(run),
    run,
    requests: thinRequestLog(requests),
  });

  console.log(`\nbrowser: wrote ${stem}.md`);
  console.log(`browser: instrument ${run.instrument.sound ? 'SOUND' : 'VOID'}`);
  run.instrument.failures.forEach((failure) => console.log(`  ⛔ ${failure}`));
  console.log(
    `browser: ${run.summary.latency.medianLatencyS?.toFixed(2) ?? '—'}s behind live, ` +
      `${run.summary.rebufferCount} rebuffers, ${run.summary.stalledSamples} stalled samples`,
  );
  console.log(
    `browser: cost ${cost.bucketsUsed} postage buckets and ${cost.bzzSpent.toFixed(3)} BZZ over ` +
      `${cost.minutes.toFixed(1)} min`,
  );
  cost.warnings.forEach((warning) => console.log(`  ⚠️ ${warning}`));
  console.log(
    `browser: gateway answered ${gatewaySamples.length - gateway.unanswered}/${gatewaySamples.length} samples, ` +
      `service time step ${gateway.serviceStepRatio?.toFixed(2) ?? '—'}x`,
  );
  gateway.warnings.forEach((warning) => console.log(`  ⚠️ ${warning}`));

  // ⛔⛔⛔ LAST, AND AFTER THE ARTIFACTS ARE ON DISK. The readback above proves what the client
  // BELIEVES; this proves what the network DID, and on 2026-08-13 those disagreed while both arms of
  // a paid sitting fetched all their video from one node. Failing here rather than before the write
  // keeps the request log that is the evidence, and the driver files the arm as WATCH-FAILED so
  // nobody reads it as a viewer result.
  if (arm) {
    const notServedByIt = armWasServedByItsGateway(requests, arm.requestedGateway, clientUrl);
    if (notServedByIt !== null) {
      throw new Error(`arm ${arm.name} is not the condition it claims: ${notServedByIt}`);
    }
    console.log(`browser: arm ${arm.name} fetched only from ${arm.reportedGateway}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
