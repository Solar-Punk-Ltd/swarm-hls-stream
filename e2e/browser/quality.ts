/**
 * `pnpm browser:quality` — squeeze a watching viewer's connection, and report what their player did.
 *
 * ## What this exists to answer
 *
 * An adaptive ladder promises that a viewer whose connection degrades keeps watching at a lower
 * quality instead of stopping. Every ABR test in this project reads the **uploader's** log, so it can
 * say the four rungs were published and cannot say that any player ever used one. No suite had opened
 * a browser and made the connection worse.
 *
 * The cap is applied from inside this process over the page's own debug session, so the moment the
 * link was squeezed and the moment the sample was taken come off one clock, exactly as
 * `browser/crash.ts` applies a fault over the docker socket it already holds.
 *
 * ## ⛔ The bandwidth is the deployment's, not this file's
 *
 * `throttleKbpsFor` derives it from `ABR_LADDER`, so a stack that reconfigures its ladder gets a cap
 * that still means "everything above the bottom two rungs is undeliverable".
 *
 * Usage, on the deployment host, against a broadcast that is already running:
 *   deploy/scripts/browser-on-host.sh --script browser:quality
 */

import {
  type ByteSourceArmSession,
  DEFAULT_BYTE_SOURCE_SETTLE_SECONDS,
  openByteSourceArmSession,
} from '../src/browser/byteSourceArm.js';
import { byteSourceFromEnv } from '../src/browser/fetchBackendSweep.js';
import { judgeRun } from '../src/browser/instrument.js';
import { type RequestRecord, summarizeNetwork } from '../src/browser/network.js';
import { judgeQualitySwitch } from '../src/browser/qualitySwitch.js';
import { renderQualityReport } from '../src/browser/qualitySwitchReport.js';
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
import { summarize, type ViewerSample } from '../src/browser/session.js';
import { squeezeDownload, type ThrottleHandle, throttleKbpsFor } from '../src/browser/throttle.js';
import { launchViewer, proveInstrumentCanFail, recordRequests, VIEWPORT } from '../src/browser/viewer.js';
import { DEFAULT_SAMPLE_INTERVAL_MS, openViewer, type SampledStretch, sampleFor } from '../src/browser/watchLoop.js';
import { loadConfig } from '../src/config.js';
import { makeHost } from '../src/harness/host.js';

/**
 * How long to watch before squeezing anything.
 *
 * The baseline the step down is measured against. The player joins behind the edge, picks a rung and
 * settles, and a cap applied during that would be measuring the join.
 */
const DEFAULT_SETTLE_SECONDS = 45;

/**
 * How long the link stays capped.
 *
 * hls.js re-estimates bandwidth from its own fragment loads, so the cap has to outlast enough
 * fragment loads for the estimate to move. Nothing here is asserted on how quickly it does.
 */
const DEFAULT_SQUEEZE_SECONDS = 60;

/** How long to keep watching after the cap comes off, which is where the climb back is seen. */
const DEFAULT_RECOVER_SECONDS = 60;

async function main(): Promise<void> {
  const clientUrl = requireEnv('BROWSER_CLIENT_URL');
  const settleMs = envNumber('BROWSER_SETTLE_SECONDS', DEFAULT_SETTLE_SECONDS) * 1000;
  const squeezeMs = envNumber('BROWSER_SQUEEZE_SECONDS', DEFAULT_SQUEEZE_SECONDS) * 1000;
  const recoverMs = envNumber('BROWSER_RECOVER_SECONDS', DEFAULT_RECOVER_SECONDS) * 1000;
  const intervalMs = envNumber('BROWSER_SAMPLE_INTERVAL_MS', DEFAULT_SAMPLE_INTERVAL_MS);
  const gopSeconds = envNumberOrNull('BROWSER_GOP_SECONDS');
  const armByteSource = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
  const byteSourceSettleMs = envNumber('BROWSER_BYTE_SOURCE_SETTLE_SECONDS', DEFAULT_BYTE_SOURCE_SETTLE_SECONDS) * 1000;

  const cfg = loadConfig();
  const host = makeHost(cfg);
  // ⛔ Before a browser is launched. A ladder with nowhere to step makes this run meaningless, and
  // finding that out after the settle would have cost a minute of broadcast to learn nothing.
  const throttleKbps = throttleKbpsFor(cfg.abrLadder);

  const measuredAt = new Date().toISOString();
  const runId = runIdFrom(measuredAt);
  const screenshotDir = screenshotDirFor(runId);
  const resourcesBefore = await readResources(host, cfg);

  const browser = await launchViewer();
  const chromeVersion = `Chrome ${browser.version()}`;
  const instrumentProofs = await proveInstrumentCanFail(browser);
  console.log(`browser: ${chromeVersion}, squeezing the tab to ${throttleKbps} kbps`);
  console.log(`browser: ladder ${cfg.abrLadder.map((rung) => `${rung.name}@${rung.kbps}`).join(' ')}`);

  const requests: RequestRecord[] = [];
  let byteSourceArm: ByteSourceArmSession | undefined;
  let throttle: ThrottleHandle | undefined;
  const stretches: SampledStretch[] = [];
  let watchUrl = clientUrl;
  let throttledAtMs = 0;
  let releasedAtMs = 0;

  const collect = (stretch: SampledStretch): void => {
    stretches.push(stretch);
  };
  const sampled = (): number => stretches.reduce((total, stretch) => total + stretch.samples.length, 0);

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    recordRequests(page, requests);
    watchUrl = await openViewer(page, clientUrl);

    byteSourceArm = await openByteSourceArmSession({
      page,
      source: armByteSource,
      playbackStartedAtMs: Date.now(),
      settleMs: byteSourceSettleMs,
    });

    const totalSamples = Math.ceil((settleMs + squeezeMs + recoverMs) / intervalMs);
    const watch = (forMs: number): Promise<SampledStretch> =>
      sampleFor({ page, forMs, intervalMs, screenshotDir, startIndex: sampled(), totalSamples });

    console.log(`browser: settling for ${settleMs / 1000}s before the squeeze`);
    collect(await watch(settleMs));

    console.log(`browser: capping the tab's download at ${throttleKbps} kbps`);
    throttle = await squeezeDownload(page, throttleKbps);
    throttledAtMs = Date.now();

    try {
      collect(await watch(squeezeMs));
    } finally {
      await throttle.release().catch((error) => console.error('could not lift the cap:', error));
      throttle = undefined;
      releasedAtMs = Date.now();
      console.log(`browser: cap lifted, watching ${recoverMs / 1000}s for the climb back`);
    }

    collect(await watch(recoverMs));
  } finally {
    // The cap lives in the browser, so closing it lifts everything. Released here anyway for the path
    // where the squeeze stretch threw before its own finally ran.
    await throttle?.release().catch(() => undefined);
    await browser.close();
  }

  const samples: ViewerSample[] = stretches.flatMap((stretch) => stretch.samples);
  if (samples.length === 0) {
    throw new Error('no samples collected');
  }

  const network = summarizeNetwork(requests);
  const cost = judgeCost(resourcesBefore, await readResources(host, cfg), network.segmentBytesDelivered);
  const throttleWindow = { throttledAtMs, releasedAtMs, kbps: throttleKbps };

  const run = {
    measuredAt,
    watchUrl,
    chromeVersion,
    gopSeconds,
    ladder: cfg.abrLadder,
    throttle: throttleWindow,
    byteSource: byteSourceArm?.arm && {
      requested: byteSourceArm.arm.requested,
      reported: byteSourceArm.arm.reported,
      settledForMs: byteSourceArm.arm.settledForMs,
    },
    summary: summarize(samples),
    quality: judgeQualitySwitch(samples, throttleWindow),
    instrumentProofs,
    instrument: judgeRun(stretches.flatMap((stretch) => stretch.readings)),
    network,
    samples,
    screenshots: stretches.flatMap((stretch) => stretch.screenshots),
    cost,
  };

  const stem = await writeRunArtifacts('browser-quality', runId, {
    markdown: renderQualityReport(run),
    run,
    requests: thinRequestLog(requests),
  });

  console.log(`\nbrowser: wrote ${stem}.md`);
  console.log(`browser: instrument ${run.instrument.sound ? 'SOUND' : 'VOID'}`);
  run.instrument.failures.forEach((failure) => console.log(`  ⛔ ${failure}`));

  const { quality } = run;
  console.log(
    `browser: ${quality.before.endedOnRungHeight}p before the cap, down to ${quality.during.lowestRungHeight}p ` +
      `under it, up to ${quality.after.tallestRungHeight}p after`,
  );
  console.log(
    `browser: the player's own estimate went ${quality.before.bandwidthEstimateKbps} → ` +
      `${quality.during.bandwidthEstimateKbps} → ${quality.after.bandwidthEstimateKbps} kbps`,
  );
  console.log(`browser: the picture advanced ${quality.during.advance.ratio.toFixed(3)}x while capped`);
  cost.warnings.forEach((warning) => console.log(`  ⚠️ ${warning}`));

  byteSourceArm?.proveBytesCameFromIt(requests);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
