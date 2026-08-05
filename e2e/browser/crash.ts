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
import { envNumber, requireEnv, runIdFrom, screenshotDirFor, writeRunArtifacts } from '../src/browser/runFiles.js';
import { summarize, type ViewerSample } from '../src/browser/session.js';
import { launchViewer, recordRequests, VIEWPORT } from '../src/browser/viewer.js';
import { DEFAULT_SAMPLE_INTERVAL_MS, openViewer, type SampledStretch, sampleFor } from '../src/browser/watchLoop.js';
import { containerName, loadConfig } from '../src/config.js';
import { type Host, makeHost } from '../src/harness/host.js';

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
  await host.start(container).catch((error) => console.error(`could not restore ${container}:`, error));
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

  const browser = await launchViewer();
  const chromeVersion = `Chrome ${browser.version()}`;
  console.log(`browser: ${chromeVersion}, scenario ${scenario.name} against ${container}`);
  console.log(`browser: ${scenario.action} for ${scenario.downMs / 1000}s, breaking ${scenario.breaks}`);

  const requests: RequestRecord[] = [];
  const stretches: SampledStretch[] = [];
  let watchUrl = clientUrl;
  let injectedAtMs = 0;
  let liftedAtMs = 0;

  const collect = (stretch: SampledStretch): void => {
    stretches.push(stretch);
  };
  const sampled = (): number => stretches.reduce((total, stretch) => total + stretch.samples.length, 0);

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    recordRequests(page, requests);
    watchUrl = await openViewer(page, clientUrl);

    const watch = (forMs: number): Promise<SampledStretch> =>
      sampleFor({ page, forMs, intervalMs, screenshotDir, startIndex: sampled() });

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
      console.log(`browser: ${container} restored, watching ${recoverMs / 1000}s for recovery`);
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

  const run = {
    measuredAt,
    watchUrl,
    chromeVersion,
    gopSeconds,
    scenario,
    container,
    fault: { injectedAtMs, liftedAtMs },
    summary: summarize(samples),
    recovery: judgeRecovery(samples, { injectedAtMs, liftedAtMs }),
    instrument: judgeRun(stretches.flatMap((stretch) => stretch.readings)),
    network: summarizeNetwork(requests),
    samples,
    screenshots: stretches.flatMap((stretch) => stretch.screenshots),
  };

  const stem = await writeRunArtifacts(`browser-crash-${scenario.name}`, runId, {
    markdown: renderCrashReport(run),
    run,
    requests,
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
