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
  armBytesCameFromItsSource,
  type ByteSourceArm,
  byteSourceFromEnv,
  openByteSourceArm,
} from '../src/browser/fetchBackendSweep.js';
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

/**
 * How long a byte-source arm plays before its measurement window opens.
 *
 * Generous on purpose. A2 measured the in-tab node's join at 9.4-10.5s and the client gives up on it
 * at 30s, so a boot that fits at all fits inside this with room to spare, and the refusal in
 * `openByteSourceArm` then only fires on an arm that was never going to be comparable.
 */
const DEFAULT_BYTE_SOURCE_SETTLE_SECONDS = 60;

async function main(): Promise<void> {
  const clientUrl = requireEnv('BROWSER_CLIENT_URL');
  const watchSeconds = envNumber('BROWSER_WATCH_SECONDS', DEFAULT_WATCH_SECONDS);
  const intervalMs = envNumber('BROWSER_SAMPLE_INTERVAL_MS', DEFAULT_SAMPLE_INTERVAL_MS);
  const gopSeconds = envNumberOrNull('BROWSER_GOP_SECONDS');
  // Set by a sitting that alternates gateways under one broadcast. Unset for every other caller, and
  // an unset gateway leaves this run exactly the watch it has always been.
  const armGateway = process.env.BROWSER_GATEWAY_URL || null;
  const armName = process.env.BROWSER_GATEWAY_ARM || 'arm';
  // Set by a sitting that alternates where segment bytes come from under one broadcast. Unset for
  // every other caller, and an unset source leaves this run exactly the watch it has always been.
  // ⛔ Parsed rather than compared later: a value that is neither condition is a refusal here.
  const armByteSource = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
  const settleSeconds = envNumber('BROWSER_SETTLE_SECONDS', DEFAULT_BYTE_SOURCE_SETTLE_SECONDS);

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
  let byteSource: ByteSourceArm | undefined;

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
    // `openViewer` returns once the player is actually playing, so this is the age a byte-source arm
    // settles from. Both conditions open their window the same distance from here.
    const playbackStartedAtMs = Date.now();

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

    // After playback is established and before the first sample, for the same reason the gateway
    // readback sits above: an arm on the wrong byte source is an arm of the other condition. It also
    // boots the in-tab node and waits out the settle, so the window below opens on a player of the
    // same age in both conditions.
    if (armByteSource !== null) {
      byteSource = await openByteSourceArm({
        page,
        source: armByteSource,
        playbackStartedAtMs,
        settleMs: settleSeconds * 1000,
      });
      console.log(
        `browser: bytes come from ${byteSource.reported}, window opens ` +
          `${(byteSource.settledForMs / 1000).toFixed(1)}s after playback started`,
      );
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
    byteSource: byteSource && {
      requested: byteSource.requested,
      reported: byteSource.reported,
      settledForMs: byteSource.settledForMs,
    },
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

  // ⛔⛔⛔ The same place and the same reason, for the byte source. The readback above proves the
  // client selected a backend; this proves the bytes went that way. It matters more here than it does
  // for gateways, because a weeb-3 arm's headline is a ZERO, and a client that never loaded the
  // backend at all produces exactly the same zero. `armBytesCameFromItsSource` requires the wasm as a
  // witness for that reason, and judges only from the instant the window opened, since an arm reads
  // through the gateway while its node is still booting.
  if (byteSource) {
    const notFromIt = armBytesCameFromItsSource(requests, byteSource.requested, byteSource.windowStartedAtMs);
    if (notFromIt !== null) {
      throw new Error(`the ${byteSource.requested} arm is not the condition it claims: ${notFromIt}`);
    }
    console.log(`browser: the ${byteSource.requested} arm's segment bytes came from where it says they did`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
