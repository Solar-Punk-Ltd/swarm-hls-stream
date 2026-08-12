/**
 * `pnpm browser:crash` — break something under a watching viewer, and report what they saw.
 *
 * Six crash scenarios already run against this deployment and all six pass, and every one of them
 * reads the **uploader's** log: no spurious VOD, a discontinuity armed, segment numbering contiguous.
 * So this project can say an eight second bee outage loses no segments, and cannot say whether
 * anybody watching noticed, how long their picture stopped, whether it came back without a reload,
 * or whether the client told them anything while it was stopped.
 *
 * The fault is applied from inside this process, over the docker socket the run already mounts, so
 * the moment the service went down and the moment the sample was taken come off one clock. Split
 * across a shell script and a report reader they would come off two, and the quantity being measured
 * is a few seconds.
 *
 * Usage, on the deployment host, against a broadcast that is already running:
 *   deploy/scripts/browser-on-host.sh --script browser:crash -- BROWSER_SCENARIO=viewer-gateway-outage
 */

import { type FaultScenario, scenarioByName } from '../src/browser/faults.js';
import { judgeRun } from '../src/browser/instrument.js';
import { type RequestRecord, summarizeNetwork } from '../src/browser/network.js';
import { judgeRecovery } from '../src/browser/recovery.js';
import { renderCrashReport } from '../src/browser/recoveryReport.js';
import { judgeCost, readResources } from '../src/browser/resources.js';
import {
  envNumber,
  requireEnv,
  runIdFrom,
  screenshotDirFor,
  thinRequestLog,
  writeRunArtifacts,
} from '../src/browser/runFiles.js';
import { summarize, type ViewerSample } from '../src/browser/session.js';
import { launchViewer, proveInstrumentCanFail, recordRequests, VIEWPORT } from '../src/browser/viewer.js';
import { DEFAULT_SAMPLE_INTERVAL_MS, openViewer, type SampledStretch, sampleFor } from '../src/browser/watchLoop.js';
import { containerName, type E2EConfig, loadConfig } from '../src/config.js';
import { type Host, makeHost } from '../src/harness/host.js';
import { sleep } from '../src/harness/wait.js';

/**
 * How long to watch before breaking anything.
 *
 * Long enough for a baseline that means something: the player joins behind the edge and takes a few
 * seconds to settle, and a fault injected during that is a fault injected into a transient.
 */
const DEFAULT_SETTLE_SECONDS = 45;

/** How long to keep watching after the service is back, which is where recovery is measured. */
const DEFAULT_RECOVER_SECONDS = 60;

async function applyFault(host: Host, container: string, scenario: FaultScenario): Promise<void> {
  if (scenario.action === 'stop') {
    await host.stop(container);
    return;
  }
  if (scenario.action === 'kill') {
    await host.kill(container);
    return;
  }
  if (scenario.action === 'pause') {
    await host.pause(container);
    return;
  }
  await host.restart(container);
}

/**
 * Put back whatever the scenario took away.
 *
 * `restart` needs nothing, since docker brings the container back itself. Everything else is started
 * whether or not the run got that far, which is why this is called from `finally` as well: a harness
 * that throws halfway through must not leave the deployment with its gateway switched off.
 */
async function restore(host: Host, container: string, scenario: FaultScenario): Promise<void> {
  if (scenario.action === 'restart') {
    return;
  }
  // A paused container is running, so `start` is not what puts it back and would report success
  // without unfreezing anything. Called from `finally` as well, and `unpause` on a container that is
  // not paused is an error rather than damage, so the catch below is the whole handling it needs.
  const putBack = scenario.action === 'pause' ? host.unpause(container) : host.start(container);
  await putBack.catch((error) => console.error(`could not restore ${container}:`, error));
}

/** How long to keep asking a restored service before giving up and saying the figure includes startup. */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 250;

/**
 * When the restored service actually answered, which is not when docker said it had started.
 *
 * ⚠️ **The gap is seconds, not milliseconds, and it used to be charged to the viewer.** The bee
 * gateway returned from `docker start` at t+79.1s on 2026-08-06, answered a 503 at t+80.3s and served
 * its first 200 at **t+86.3s**. A viewer cannot recover before the thing they read from works, so
 * measuring recovery from docker's return set fix 0.8b a target no client change could reach.
 *
 * Null when readiness cannot be established, so the caller can say the figure includes startup rather
 * than quietly reporting one number as the other.
 */
async function waitUntilServing(host: Host, cfg: E2EConfig, scenario: FaultScenario): Promise<number | null> {
  if (!scenario.ready) {
    return null;
  }
  const { port, path, is } = scenario.ready;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const saysReady = (body: unknown): boolean =>
    typeof body === 'object' &&
    body !== null &&
    Object.entries(is).every(([field, value]) => (body as Record<string, unknown>)[field] === value);

  while (Date.now() < deadline) {
    const ready = await host
      .localJson(cfg.ports[port], path)
      .then(saysReady)
      .catch(() => false);
    if (ready) {
      return Date.now();
    }
    await sleep(READY_POLL_MS);
  }

  console.error(`browser: ${scenario.service} never answered ${path} within ${READY_TIMEOUT_MS / 1000}s`);
  return null;
}

async function main(): Promise<void> {
  const clientUrl = requireEnv('BROWSER_CLIENT_URL');
  const scenario = scenarioByName(requireEnv('BROWSER_SCENARIO'));
  const settleMs = envNumber('BROWSER_SETTLE_SECONDS', DEFAULT_SETTLE_SECONDS) * 1000;
  const recoverMs = envNumber('BROWSER_RECOVER_SECONDS', DEFAULT_RECOVER_SECONDS) * 1000;
  const intervalMs = envNumber('BROWSER_SAMPLE_INTERVAL_MS', DEFAULT_SAMPLE_INTERVAL_MS);
  const gopSeconds = envNumber('BROWSER_GOP_SECONDS', 0.25);

  const cfg = loadConfig();
  const host = makeHost(cfg);
  const container = containerName(cfg, scenario.service);

  const measuredAt = new Date().toISOString();
  const runId = runIdFrom(measuredAt);
  const screenshotDir = screenshotDirFor(runId);
  const resourcesBefore = await readResources(host, cfg);

  const browser = await launchViewer();
  const chromeVersion = `Chrome ${browser.version()}`;
  // Taken before the measurement so an early failure downstream cannot leave the run reporting a
  // soundness verdict nothing ever tried to break.
  const instrumentProofs = await proveInstrumentCanFail(browser);
  console.log(`browser: ${chromeVersion}, scenario ${scenario.name} against ${container}`);
  console.log(`browser: ${scenario.action} for ${scenario.downMs / 1000}s, breaking ${scenario.breaks}`);

  const requests: RequestRecord[] = [];
  const stretches: SampledStretch[] = [];
  let watchUrl = clientUrl;
  let injectedAtMs = 0;
  let liftedAtMs = 0;
  let servingAtMs: number | null = null;

  const collect = (stretch: SampledStretch): void => {
    stretches.push(stretch);
  };
  const sampled = (): number => stretches.reduce((total, stretch) => total + stretch.samples.length, 0);

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    recordRequests(page, requests);
    watchUrl = await openViewer(page, clientUrl);

    const totalSamples = Math.ceil((settleMs + scenario.downMs + recoverMs) / intervalMs);
    const watch = (forMs: number): Promise<SampledStretch> =>
      sampleFor({ page, forMs, intervalMs, screenshotDir, startIndex: sampled(), totalSamples });

    console.log(`browser: settling for ${settleMs / 1000}s before the fault`);
    collect(await watch(settleMs));

    // Stamped either side of the call rather than around it, so the window is the one the service was
    // actually unavailable for and not the one including this process's own docker round trips.
    console.log(`browser: ${scenario.action} ${container}`);
    await applyFault(host, container, scenario);
    injectedAtMs = Date.now();

    try {
      collect(await watch(scenario.downMs));
    } finally {
      await restore(host, container, scenario);
      liftedAtMs = Date.now();
      // Asked in parallel with the watch below rather than awaited here, because waiting for it would
      // stop sampling the viewer over exactly the seconds the service is coming back, which is the
      // stretch the whole run is about.
      void waitUntilServing(host, cfg, scenario).then((at) => {
        servingAtMs = at;
        const startup = at === null ? 'never answered' : `${((at - liftedAtMs) / 1000).toFixed(1)}s to answer`;
        console.log(`browser: ${container} restored, ${startup}, watching ${recoverMs / 1000}s for recovery`);
      });
    }

    collect(await watch(recoverMs));
  } finally {
    await browser.close();
    await restore(host, container, scenario);
  }

  const samples: ViewerSample[] = stretches.flatMap((stretch) => stretch.samples);
  if (samples.length === 0) {
    throw new Error('no samples collected');
  }

  const network = summarizeNetwork(requests);
  const cost = judgeCost(resourcesBefore, await readResources(host, cfg), network.segmentBytesDelivered);

  const run = {
    measuredAt,
    watchUrl,
    chromeVersion,
    gopSeconds,
    scenario,
    container,
    fault: { injectedAtMs, liftedAtMs, servingAtMs },
    summary: summarize(samples),
    recovery: judgeRecovery(samples, { injectedAtMs, liftedAtMs, servingAtMs }),
    instrumentProofs,
    instrument: judgeRun(stretches.flatMap((stretch) => stretch.readings)),
    network,
    samples,
    screenshots: stretches.flatMap((stretch) => stretch.screenshots),
    cost,
  };

  const stem = await writeRunArtifacts(`browser-crash-${scenario.name}`, runId, {
    markdown: renderCrashReport(run),
    run,
    requests: thinRequestLog(requests),
  });

  console.log(`\nbrowser: wrote ${stem}.md`);
  console.log(`browser: instrument ${run.instrument.sound ? 'SOUND' : 'VOID'}`);
  run.instrument.failures.forEach((failure) => console.log(`  ⛔ ${failure}`));
  const { recovery } = run;
  console.log(
    `browser: froze ${(recovery.longestFreezeMs / 1000).toFixed(1)}s, ` +
      `${recovery.recovered ? 'recovered' : 'DID NOT RECOVER'}` +
      `${
        recovery.recoveredAfterLiftMs === null
          ? ''
          : ` ${(recovery.recoveredAfterLiftMs / 1000).toFixed(1)}s after the service returned`
      }`,
  );
  console.log(
    `browser: the client said ${
      recovery.saidWhileFrozen.length > 0 ? `"${recovery.saidWhileFrozen.join('", "')}"` : 'NOTHING'
    } while frozen`,
  );
  cost.warnings.forEach((warning) => console.log(`  ⚠️ ${warning}`));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
