/**
 * `pnpm browser:buffer-sweep` — how far behind live a viewer has to sit before the picture breaks.
 *
 * This is task #87. `LIVE_SYNC_DURATION_S` is 6, the pipeline delivers a segment in about 1.56s at
 * the shipping profile, so roughly four fifths of what a viewer feels is a number we chose rather
 * than a cost the network imposes. Nothing has measured whether 6 is right, and its own justification
 * predates the 0.5s segment #155 ships.
 *
 * ⭐ **Scored on stalls, not on latency.** A smaller buffer always shows a better latency, so latency
 * cannot say where the floor is. Only the picture breaking can.
 *
 * ⛔ One continuous broadcast, arms set on the live player between stretches, which is why the client
 * must be built with `VITE_EXPOSE_PLAYER`. Rebuilding per arm would put a fresh join and a cold start
 * inside every arm of a measurement about how a player holds position.
 *
 * ⛔ The first arms are warm-up and are discarded, and the counted arms run in the reverse order, so
 * a gradient over the sitting cannot align itself with the swept axis.
 *
 * Usage, against a broadcast that is already running:
 *   deploy/scripts/browser-on-host.sh --script browser:buffer-sweep -- BROWSER_ARM_SECONDS=240
 *
 * A paid sweep goes through `deploy/scripts/buffer-sweep-sitting.sh` instead, which sizes and
 * publishes the one broadcast the whole sweep rides, puts the spend gates in the path, and refuses
 * to run without a named byte source.
 */

import {
  type ArmPlan,
  type ArmResult,
  armResultFrom,
  perArmFromSessionTotals,
  setArm,
} from '../src/browser/bufferSweep.js';
import {
  type ByteSourceArmSession,
  DEFAULT_BYTE_SOURCE_SETTLE_SECONDS,
  openByteSourceArmSession,
} from '../src/browser/byteSourceArm.js';
import { byteSourceFromEnv } from '../src/browser/fetchBackendSweep.js';
import {
  DEFAULT_GATEWAY_SAMPLE_INTERVAL_MS,
  gatewayReader,
  type GatewaySample,
  startGatewaySampling,
  summarizeGateway,
} from '../src/browser/gatewayHealth.js';
import { type RequestRecord } from '../src/browser/network.js';
import { judgeCost, readResources } from '../src/browser/resources.js';
import {
  envNumber,
  requireEnv,
  runIdFrom,
  screenshotDirFor,
  thinRequestLog,
  writeRunArtifacts,
} from '../src/browser/runFiles.js';
import { launchViewer, proveInstrumentCanFail, recordRequests, VIEWPORT } from '../src/browser/viewer.js';
import { DEFAULT_SAMPLE_INTERVAL_MS, openViewer, sampleFor } from '../src/browser/watchLoop.js';
import { loadConfig } from '../src/config.js';
import { makeHost } from '../src/harness/host.js';

/** Four minutes at a 0.5s segment is about 480 segments, which is chances enough for a rare event. */
const DEFAULT_ARM_SECONDS = 240;

/**
 * Swept downward from the shipped 6, because the question is where stalls go from none to many
 * rather than how a rate differs. The shipping profile ran a sustained stretch with zero stalls, so
 * the signal, if there is one, lives at the bottom of this list.
 */
const DEFAULT_COUNTED_TARGETS_S = [6, 3, 2, 1.5];

/** Discarded. Two of them, and at the ends of the range, so warm-up cannot favour either direction. */
const DEFAULT_WARMUP_TARGETS_S = [6, 1.5];

function targetsFrom(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = raw
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
  if (parsed.length === 0) {
    throw new Error(`${name} names no usable targets: ${raw}`);
  }
  return parsed;
}

interface SweepRun {
  measuredAt: string;
  armSeconds: number;
  firstTargetDurationS: number | null;
  results: ArmResult[];
  cost: { bzzSpent: number; bucketsUsed: number };
}

/**
 * The report a person reads, which leads with what was thrown away.
 *
 * An excluded arm is printed in the same table as a counted one rather than filtered out, because a
 * sweep that silently drops arms reports a clean result it did not measure. See gate lesson AHC.
 */
function renderSweepReport(run: SweepRun): string {
  const counted = run.results.filter((row) => row.counted && !row.excludedBecause);
  const lines = [
    `# Buffer sweep, ${run.measuredAt}`,
    '',
    `${run.armSeconds}s per arm, ${counted.length} of ${run.results.length} arms counted. ` +
      `\`#EXT-X-TARGETDURATION\` ${run.firstTargetDurationS ?? '—'}s, which caps the stall penalty.`,
    '',
    '⛔ Scored on stalls. A smaller buffer always shows a better latency, so the latency column',
    'cannot locate the floor and is here only to show the arm did what it was told.',
    '',
    "The `.json` beside this carries each arm's samples, so a rebuffer can be placed inside its arm",
    'and lined up against the refusals in the `.requests.json`. That series is thinned and holds fewer',
    'rows than the samples column counts: every sample where something happened is kept with the one',
    'before it, and the uneventful rest is sampled evenly.',
    '',
    '| target | held at | samples | rebuffers | stalled | median latency | counted |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];

  for (const row of run.results) {
    lines.push(
      `| ${row.requestedTargetS}s | ${row.setup.targetLatencyS ?? '—'}s | ${row.sampleCount} | ` +
        `${row.rebufferCount} | ${row.stalledSamples} | ${row.medianLatencyS?.toFixed(2) ?? '—'}s | ` +
        `${row.excludedBecause ? `no, ${row.excludedBecause}` : 'yes'} |`,
    );
  }

  const unsound = run.results.filter((row) => !row.instrumentSound);
  if (unsound.length > 0) {
    lines.push('', '## ⛔ Arms whose instrument was not sound', '');
    unsound.forEach((row) => lines.push(`- **${row.label}**: ${row.instrumentFailures.join('; ')}`));
  }

  lines.push('', `Cost: ${run.cost.bzzSpent.toFixed(3)} BZZ over ${run.cost.bucketsUsed} postage buckets.`, '');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const clientUrl = requireEnv('BROWSER_CLIENT_URL');
  const armSeconds = envNumber('BROWSER_ARM_SECONDS', DEFAULT_ARM_SECONDS);
  const intervalMs = envNumber('BROWSER_SAMPLE_INTERVAL_MS', DEFAULT_SAMPLE_INTERVAL_MS);
  // Read before a browser is launched, so a misspelt byte source costs nothing rather than a run.
  const armByteSource = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
  const byteSourceSettleMs = envNumber('BROWSER_BYTE_SOURCE_SETTLE_SECONDS', DEFAULT_BYTE_SOURCE_SETTLE_SECONDS) * 1000;
  const counted = targetsFrom('BROWSER_SWEEP_TARGETS_S', DEFAULT_COUNTED_TARGETS_S);
  const warmup = targetsFrom('BROWSER_SWEEP_WARMUP_S', DEFAULT_WARMUP_TARGETS_S);

  const measuredAt = new Date().toISOString();
  const runId = runIdFrom(measuredAt);
  const cfg = loadConfig();
  const host = makeHost(cfg);
  const resourcesBefore = await readResources(host, cfg);

  const browser = await launchViewer();
  const chromeVersion = `Chrome ${browser.version()}`;
  const instrumentProofs = await proveInstrumentCanFail(browser);

  const plan: ArmPlan[] = [
    ...warmup.map((targetS, index) => ({ targetS, counted: false, label: `warmup-${index}@${targetS}s` })),
    // Reversed against the warm-up order, so a drift across the sitting cannot line up with the axis.
    ...[...counted].reverse().map((targetS) => ({ targetS, counted: true, label: `arm@${targetS}s` })),
  ];

  console.log(
    `browser: ${chromeVersion}, ${plan.length} arms of ${armSeconds}s ` +
      `(${warmup.length} discarded), sweeping ${counted.join(', ')}s`,
  );

  const requests: RequestRecord[] = [];
  let byteSourceArm: ByteSourceArmSession | undefined;
  const results: ArmResult[] = [];
  // Collected as session totals and differenced after the loop, because the counter behind them is
  // monotonic across the whole sweep. See `perArmFromSessionTotals`.
  const rebufferTotals: number[] = [];
  let gatewaySamples: GatewaySample[] = [];
  let firstTargetDurationS: number | null = null;
  let watchUrl = clientUrl;

  const gatewaySampling = startGatewaySampling({
    read: gatewayReader(host, cfg),
    intervalMs: envNumber('BROWSER_GATEWAY_SAMPLE_INTERVAL_MS', DEFAULT_GATEWAY_SAMPLE_INTERVAL_MS),
  });

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    recordRequests(page, requests);
    watchUrl = await openViewer(page, clientUrl);

    // ⛔ Before the first arm, and the whole sweep runs on one byte source. Booting the in-tab node
    // costs 4.5 MB of wasm and several seconds of dialling, so a node joining inside an arm would put
    // the join in that arm's numbers and in no other, which reads as a buffer effect.
    byteSourceArm = await openByteSourceArmSession({
      page,
      source: armByteSource,
      playbackStartedAtMs: Date.now(),
      settleMs: byteSourceSettleMs,
    });

    for (const [index, arm] of plan.entries()) {
      const setup = await setArm(page, arm.targetS);
      if (setup.failure) {
        // Fatal rather than skipped: every later arm would fail the same way, and a sweep that
        // reports four empty arms after spending a broadcast on them is worse than one that stops.
        throw new Error(`${arm.label}: ${setup.failure}`);
      }
      if (firstTargetDurationS === null) {
        firstTargetDurationS = setup.targetDurationS;
      }

      const stretch = await sampleFor({
        page,
        forMs: armSeconds * 1000,
        intervalMs,
        screenshotDir: screenshotDirFor(runId),
        startIndex: index * Math.ceil((armSeconds * 1000) / intervalMs),
        totalSamples: plan.length * Math.ceil((armSeconds * 1000) / intervalMs),
      });

      const result = armResultFrom(arm, setup, firstTargetDurationS, stretch);
      // Still the session total here. Replaced with this arm's own contribution once the sweep ends.
      rebufferTotals.push(result.rebufferCount);
      results.push(result);

      console.log(
        `  ${result.label}: held at ${setup.targetLatencyS ?? '—'}s, ${result.sampleCount} samples, ` +
          `${result.rebufferCount} rebuffers so far this sweep, ${result.stalledSamples} stalled in this arm` +
          `${result.excludedBecause ? `  [EXCLUDED: ${result.excludedBecause}]` : ''}`,
      );
    }
  } finally {
    gatewaySamples = await gatewaySampling.stop();
    await browser.close();
  }

  perArmFromSessionTotals(rebufferTotals).forEach((own, index) => {
    results[index].rebufferCount = own;
  });

  const cost = judgeCost(resourcesBefore, await readResources(host, cfg), 0);
  const run = {
    measuredAt,
    watchUrl,
    chromeVersion,
    armSeconds,
    plan,
    results,
    firstTargetDurationS,
    instrumentProofs,
    cost,
    gateway: summarizeGateway(gatewaySamples),
  };

  const stem = await writeRunArtifacts('browser-buffer-sweep', runId, {
    markdown: renderSweepReport(run),
    run,
    requests: thinRequestLog(requests),
  });
  console.log(`\nbrowser: wrote ${stem}.md`);

  // Printed as a table with the exclusions beside the counts, because an arm dropped quietly is how a
  // sweep reports a clean result it did not measure.
  console.log('\ntarget_s\theld_at\tsamples\trebuffers\tstalled\tmedian_latency_s\tcounted');
  for (const row of results) {
    console.log(
      [
        row.requestedTargetS,
        row.setup.targetLatencyS ?? '—',
        row.sampleCount,
        row.rebufferCount,
        row.stalledSamples,
        row.medianLatencyS?.toFixed(2) ?? '—',
        row.excludedBecause ? `no: ${row.excludedBecause}` : 'yes',
      ].join('\t'),
    );
  }
  console.log(`\nbrowser: cost ${cost.bucketsUsed} postage buckets and ${cost.bzzSpent.toFixed(3)} BZZ`);
  cost.warnings.forEach((warning) => console.log(`  ⚠️ ${warning}`));

  // ⛔⛔⛔ Last, after the artifact is written, as watch.ts and crash.ts do it: failing here keeps the
  // request log that is the evidence. Without it a weeb-3 sweep's zero gateway reads is
  // indistinguishable from a client that never loaded the node.
  byteSourceArm?.proveBytesCameFromIt(requests);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
