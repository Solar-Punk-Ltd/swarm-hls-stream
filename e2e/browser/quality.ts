/**
 * `pnpm browser:quality`: squeeze a watching viewer's connection, and report what their player did.
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
import {
  abandonedAnswerVerdict,
  describeElapsed,
  describeLevelRequests,
  describeSettleOutcomes,
  type FragmentLog,
  fragmentLogVerdict,
  fragmentSettleVerdict,
  judgeFragmentRequests,
  recordFragmentLog,
} from '../src/browser/fragmentRequests.js';
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
import {
  nowhereToStepRefusal,
  squeezeDownload,
  type ThrottleHandle,
  throttleKbpsBelow,
} from '../src/browser/throttle.js';
import {
  launchViewerWatchingWorkers,
  proveInstrumentCanFail,
  readSample,
  recordRequests,
  VIEWPORT,
} from '../src/browser/viewer.js';
import { DEFAULT_SAMPLE_INTERVAL_MS, openViewer, type SampledStretch, sampleFor } from '../src/browser/watchLoop.js';
import { type WebSocketTraffic } from '../src/browser/webSocketTraffic.js';
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

/**
 * How long to keep watching after the cap comes off, which is where the climb back is seen.
 *
 * 120 rather than 60 since 2026-09-02. The client smooths its bandwidth estimate over 27 s and climbs
 * only to a rung under 70% of it, so the climb is slow by design: the first green run reached 480p
 * 28 s after the lift and its estimate stood at 3486 kbps when the 60 s window closed, about six
 * seconds short of the 4000 that 720p needs (`browser-quality-2026-09-02T12-52-16-340Z`). A window
 * that ends mid-climb files "climbed back to 480p" about a player that was still climbing.
 */
const DEFAULT_RECOVER_SECONDS = 120;

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

  const measuredAt = new Date().toISOString();
  const runId = runIdFrom(measuredAt);
  const screenshotDir = screenshotDirFor(runId);
  const resourcesBefore = await readResources(host, cfg);

  // ⛔⛔ V2's cap has to reach the SharedWorker the node runs in, and until 2026-09-02 it reached the
  // page and stopped there. The traffic object is what the worker watch appends into: this arm files
  // no frame log, so nothing reads it, and `Network.emulateNetworkConditions` needs the domain
  // enabled on a session before it will hold one, which is what produces the frames.
  //
  // ⭐ V2's own proof that the cap landed is unchanged and is `throttleRefusal`, which asks whether
  // anything a viewer could feel changed. It never was the player's bandwidth estimate: measured
  // 2026-08-30 that estimate read 74221 kbps under a 2800 kbps cap, because hls.js times the handover
  // from a local node and never the node's own retrieval.
  const traffic: WebSocketTraffic = { connections: [], frames: [] };
  const { browser, workers } = await launchViewerWatchingWorkers(traffic);
  const chromeVersion = `Chrome ${browser.version()}`;
  const instrumentProofs = await proveInstrumentCanFail(browser);
  console.log(`browser: ${chromeVersion}, ladder ${cfg.abrLadder.map((r) => `${r.name}@${r.kbps}`).join(' ')}`);

  const requests: RequestRecord[] = [];
  /** ⛔ An observation. Nothing below branches on it and no gate reads it. */
  const fragmentLog: FragmentLog = { requests: [], settles: [], abandonedAnswers: [] };
  let byteSourceArm: ByteSourceArmSession | undefined;
  let throttle: ThrottleHandle | undefined;
  const stretches: SampledStretch[] = [];
  let watchUrl = clientUrl;
  let throttledAtMs = 0;
  let releasedAtMs = 0;
  let throttleKbps = 0;
  let ridingHeight: number | null = null;
  let cannotAsk: string | null = null;

  const collect = (stretch: SampledStretch): void => {
    stretches.push(stretch);
  };
  const sampled = (): number => stretches.reduce((total, stretch) => total + stretch.samples.length, 0);

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    recordRequests(page, requests);
    // Before the navigation, for the reason `recordRequests` is: a listener added afterwards misses
    // whatever the player asked for while the harness was still opening the page.
    recordFragmentLog(page, fragmentLog);
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

    // ⛔⛔ Read AFTER the settle, and the cap is derived from it. Which rung a player rides is its own
    // decision and it differs by BYTE SOURCE: live on 2026-08-30 the gateway profile settled on 360p,
    // the bottom of the ladder, while an in-tab viewer rides the top of the same broadcast. A cap
    // taken from the ladder in the abstract left that viewer's own rung affordable, so they correctly
    // did not move and the run reported a ladder nobody descends.
    ridingHeight = (await readSample(page)).selectedRungHeight;
    cannotAsk =
      ridingHeight === null
        ? 'the player had selected no rung after the whole settle, so there is nothing to squeeze it off'
        : nowhereToStepRefusal(cfg.abrLadder, ridingHeight);

    if (cannotAsk === null && ridingHeight !== null) {
      throttleKbps = throttleKbpsBelow(cfg.abrLadder, ridingHeight) as number;
      console.log(`browser: this viewer is riding ${ridingHeight}p, capping the tab at ${throttleKbps} kbps`);
      throttle = await squeezeDownload(page, throttleKbps, workers);
    } else {
      console.log(`browser: NOT squeezing, ${cannotAsk}`);
    }
    throttledAtMs = Date.now();

    try {
      collect(await watch(squeezeMs));
    } finally {
      await throttle?.release().catch((error) => console.error('could not lift the cap:', error));
      throttle = undefined;
      releasedAtMs = Date.now();
      console.log(`browser: cap lifted, watching ${recoverMs / 1000}s for the climb back`);
    }

    collect(await watch(recoverMs));
  } finally {
    // The cap lives in the browser, so closing it lifts everything. Released here anyway for the path
    // where the squeeze stretch threw before its own finally ran.
    await throttle?.release().catch(() => undefined);
    await workers.close().catch((error) => console.error('could not close the worker CDP client:', error));
    await browser.close();
  }

  const samples: ViewerSample[] = stretches.flatMap((stretch) => stretch.samples);
  if (samples.length === 0) {
    throw new Error('no samples collected');
  }

  const network = summarizeNetwork(requests);
  const cost = judgeCost(resourcesBefore, await readResources(host, cfg), network.segmentBytesDelivered);
  const throttleWindow = { appliedAtMs: throttledAtMs, liftedAtMs: releasedAtMs, kbps: throttleKbps };
  const summary = summarize(samples);

  const run = {
    measuredAt,
    watchUrl,
    chromeVersion,
    gopSeconds,
    ladder: cfg.abrLadder,
    throttle: throttleWindow,
    // ⛔ Carried so a suite can tell "the ladder does not adapt" from "this viewer had nowhere to go".
    // The second is a property of the byte source, and reporting it as the first is a finding about
    // the gateway filed against the client.
    squeeze: { ridingHeight, cannotAsk },
    byteSource: byteSourceArm?.arm && {
      requested: byteSourceArm.arm.requested,
      reported: byteSourceArm.arm.reported,
      settledForMs: byteSourceArm.arm.settledForMs,
    },
    summary,
    quality: judgeQualitySwitch(samples, throttleWindow),
    // ⛔ Which level the player ASKED for and what became of each attempt, neither of which any other
    // reading in this artifact carries. An observation: nothing asserts on it. `pictureMoved` is what
    // lets an empty capture read as a client without the instrument rather than as a player that
    // requested nothing. ⭐ Both raw lists go in whole, because the bucketed counts cannot separate six
    // fragments from one fragment asked for six times.
    fragmentRequests: judgeFragmentRequests(fragmentLog, throttleWindow, summary.overallAdvanceRatio > 0),
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

  const asked = run.fragmentRequests;
  console.log(`browser: ${fragmentLogVerdict(asked)}`);
  console.log(
    `browser: levels asked for: ${describeLevelRequests(asked.before)} before the cap, then ` +
      `${describeLevelRequests(asked.during)} while capped, then ${describeLevelRequests(asked.after)} after the lift`,
  );
  console.log(`browser: ${fragmentSettleVerdict(asked.settled)}`);
  if (asked.settled !== null) {
    const { during } = asked.settled;
    console.log(
      `browser: while capped those attempts ended ${describeSettleOutcomes(during)}, taking ` +
        `${describeElapsed(during)}`,
    );
  }
  // ⛔ An observation, and the one bit `aborted` cannot carry: whether the node ever produced the bytes
  // of a fragment the player had already walked away from. The per-phase counts are in the state file.
  console.log(`browser: ${abandonedAnswerVerdict(asked.abandonedAnswers)}`);
  cost.warnings.forEach((warning) => console.log(`  ⚠️ ${warning}`));

  byteSourceArm?.proveBytesCameFromIt(requests);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
