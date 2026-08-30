/**
 * `pnpm browser:rung-outage` — silence the rung a viewer is actually watching, and report what
 * their player did about it.
 *
 * ## The question, which nothing else in this project asks
 *
 * A ladder is four renditions so that a viewer has somewhere to go. Every ABR test here reads the
 * uploader's log, which can say four rungs were published. `browser:quality` asks what a player does
 * when the LINK gets worse. This asks what it does when the rung it is riding stops existing while
 * three healthy ones sit beside it.
 *
 * ⛔ **The honest expectation is that this may fail, and that is the point.** hls.js switches level on
 * fragment load errors. A Swarm feed that stops advancing does not error, it simply stops producing
 * new fragments, and a player waiting for one it has not been offered has no error to react to. If
 * that is what happens, a viewer freezes on a dead rung with three live ones beside them, which is a
 * real defect this suite exists to find rather than a harness problem to work around.
 *
 * ## ⛔ The rung is chosen by the viewer, not by this file
 *
 * The driver reads `Selected Rung` off the shipped overlay after the settle and silences THAT rung.
 * Hardcoding one would silence a rung the viewer was not on, on whichever profile happens to pick a
 * different one, and the run would then be watching a player ignore a fault that never touched it.
 * In-tab viewers have been measured riding 1080p while gateway viewers rode 360p on the same
 * broadcast, so this is not a theoretical difference.
 *
 * Usage, on the deployment host, against a broadcast that is already running:
 *   deploy/scripts/browser-on-host.sh --script browser:rung-outage
 */

import {
  type ByteSourceArmSession,
  DEFAULT_BYTE_SOURCE_SETTLE_SECONDS,
  openByteSourceArmSession,
} from '../src/browser/byteSourceArm.js';
import { byteSourceFromEnv } from '../src/browser/fetchBackendSweep.js';
import { judgeRun } from '../src/browser/instrument.js';
import { type RequestRecord, summarizeNetwork } from '../src/browser/network.js';
import { judgeRungTimeline } from '../src/browser/qualitySwitch.js';
import { judgeRecovery } from '../src/browser/recovery.js';
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
import { renderRungOutageReport } from '../src/browser/rungOutageReport.js';
import {
  listProcessesCommand,
  type RungProcess,
  rungProcesses,
  SIGNAL_QUIET,
  SIGNAL_RESUME,
  signalCommand,
} from '../src/browser/rungTranscode.js';
import { summarize, type ViewerSample } from '../src/browser/session.js';
import { launchViewer, proveInstrumentCanFail, readSample, recordRequests, VIEWPORT } from '../src/browser/viewer.js';
import { DEFAULT_SAMPLE_INTERVAL_MS, openViewer, type SampledStretch, sampleFor } from '../src/browser/watchLoop.js';
import { containerName, type LadderRung, loadConfig } from '../src/config.js';
import { type Host, makeHost } from '../src/harness/host.js';

/** How long to watch before silencing anything, so the player has settled on a rung of its own choosing. */
const DEFAULT_SETTLE_SECONDS = 45;

/**
 * How long the rung stays quiet.
 *
 * Longer than the crash scenarios' outages on purpose. A player has to run out of the fragments it
 * already has before a dead rung is distinguishable from a slow one, and the client holds a buffer.
 */
const DEFAULT_QUIET_SECONDS = 90;

/** How long to keep watching after the rung speaks again, which is where a climb back is seen. */
const DEFAULT_RECOVER_SECONDS = 60;

/**
 * The rung this viewer is riding, off the shipped overlay.
 *
 * ⛔ Returns the HEIGHT, which then has to be matched back to a ladder entry by name, because the
 * process table knows rungs by name and the player knows them by geometry.
 */
async function ladderRungOnScreen(
  page: Parameters<typeof readSample>[0],
  ladder: readonly LadderRung[],
): Promise<LadderRung> {
  const sample = await readSample(page);
  if (sample.selectedRungHeight === null) {
    throw new Error(
      'the player has selected no rung after the whole settle, so there is nothing to silence. Either no ' +
        'master playlist arrived or this deployment is single rendition, and in both cases a rung outage ' +
        'is not a fault this broadcast can have.',
    );
  }
  const riding = ladder.find((rung) => rung.height === sample.selectedRungHeight);
  if (riding === undefined) {
    throw new Error(
      `the player is riding a ${sample.selectedRungHeight}p rung and ABR_LADDER declares ` +
        `${ladder.map((rung) => `${rung.name}@${rung.height}`).join(' ')}. Silencing a rung by guessing which ` +
        'one that is would break a rung the viewer is not watching.',
    );
  }
  return riding;
}

/** Find the transcode producing a rung, or say plainly that nothing was found rather than silencing nothing. */
async function findTranscode(host: Host, container: string, rung: string): Promise<readonly RungProcess[]> {
  const { stdout } = await host.run(listProcessesCommand(container));
  const found = rungProcesses(stdout, rung);
  if (found.length === 0) {
    throw new Error(
      `no transcode in ${container} is producing the ${rung} rung, so this run would silence nothing and ` +
        'report a ladder that survived a fault it never had. The ladder may not be transcoding, or the ' +
        "engine's output url no longer carries the rung name.",
    );
  }
  return found;
}

async function main(): Promise<void> {
  const clientUrl = requireEnv('BROWSER_CLIENT_URL');
  const settleMs = envNumber('BROWSER_SETTLE_SECONDS', DEFAULT_SETTLE_SECONDS) * 1000;
  const quietMs = envNumber('BROWSER_QUIET_SECONDS', DEFAULT_QUIET_SECONDS) * 1000;
  const recoverMs = envNumber('BROWSER_RECOVER_SECONDS', DEFAULT_RECOVER_SECONDS) * 1000;
  const intervalMs = envNumber('BROWSER_SAMPLE_INTERVAL_MS', DEFAULT_SAMPLE_INTERVAL_MS);
  const gopSeconds = envNumberOrNull('BROWSER_GOP_SECONDS');
  const armByteSource = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
  const byteSourceSettleMs = envNumber('BROWSER_BYTE_SOURCE_SETTLE_SECONDS', DEFAULT_BYTE_SOURCE_SETTLE_SECONDS) * 1000;

  const cfg = loadConfig();
  const host = makeHost(cfg);
  const engine = containerName(cfg, cfg.engine);

  const measuredAt = new Date().toISOString();
  const runId = runIdFrom(measuredAt);
  const screenshotDir = screenshotDirFor(runId);
  const resourcesBefore = await readResources(host, cfg);

  const browser = await launchViewer();
  const chromeVersion = `Chrome ${browser.version()}`;
  const instrumentProofs = await proveInstrumentCanFail(browser);
  console.log(`browser: ${chromeVersion}, silencing whichever rung the viewer settles on, in ${engine}`);

  const requests: RequestRecord[] = [];
  let byteSourceArm: ByteSourceArmSession | undefined;
  const stretches: SampledStretch[] = [];
  let watchUrl = clientUrl;
  let silenced: LadderRung | null = null;
  let transcodes: readonly RungProcess[] = [];
  let quietedAtMs = 0;
  let resumedAtMs = 0;

  const collect = (stretch: SampledStretch): void => {
    stretches.push(stretch);
  };
  const sampled = (): number => stretches.reduce((total, stretch) => total + stretch.samples.length, 0);
  const resume = async (): Promise<void> => {
    if (transcodes.length === 0) {
      return;
    }
    await host
      .run(
        signalCommand(
          engine,
          transcodes.map((process) => process.pid),
          SIGNAL_RESUME,
        ),
      )
      .catch((error) => console.error('could not resume the silenced transcode:', error));
  };

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

    const totalSamples = Math.ceil((settleMs + quietMs + recoverMs) / intervalMs);
    const watch = (forMs: number): Promise<SampledStretch> =>
      sampleFor({ page, forMs, intervalMs, screenshotDir, startIndex: sampled(), totalSamples });

    console.log(`browser: settling for ${settleMs / 1000}s before silencing anything`);
    collect(await watch(settleMs));

    // ⛔ Read AFTER the settle, never before. Which rung a player rides is its own decision and it
    // makes it over the first seconds, so a rung chosen at join is often not the one being watched.
    silenced = await ladderRungOnScreen(page, cfg.abrLadder);
    transcodes = await findTranscode(host, engine, silenced.name);
    console.log(
      `browser: this viewer is riding ${silenced.name}. Silencing pid ${transcodes
        .map((process) => process.pid)
        .join(', ')} for ${quietMs / 1000}s`,
    );

    await host.run(
      signalCommand(
        engine,
        transcodes.map((process) => process.pid),
        SIGNAL_QUIET,
      ),
    );
    quietedAtMs = Date.now();

    try {
      collect(await watch(quietMs));
    } finally {
      await resume();
      resumedAtMs = Date.now();
      console.log(`browser: ${silenced.name} speaking again, watching ${recoverMs / 1000}s`);
    }

    collect(await watch(recoverMs));
  } finally {
    // ⛔ From `finally` as well as from the window above. A stopped transcode left behind holds a
    // rung of every later broadcast quiet, and nothing in the deployment would report it: SRS did not
    // spawn a replacement because the process never exited.
    await resume();
    await browser.close();
  }

  const samples: ViewerSample[] = stretches.flatMap((stretch) => stretch.samples);
  if (samples.length === 0) {
    throw new Error('no samples collected');
  }

  const network = summarizeNetwork(requests);
  const cost = judgeCost(resourcesBefore, await readResources(host, cfg), network.segmentBytesDelivered);
  const outage = { appliedAtMs: quietedAtMs, liftedAtMs: resumedAtMs };

  const run = {
    measuredAt,
    watchUrl,
    chromeVersion,
    gopSeconds,
    engine,
    ladder: cfg.abrLadder,
    // ⛔ `scenario` and `fault` beside `recovery`, because `readCrashRecovery` reads all three and a
    // recovery without them is a malformed artifact to it. This driver's fault is not one of
    // `faults.ts`'s, and the reader only wants the name, so it names itself. Missing, this arm ran
    // its whole 276 seconds on 2026-08-30 and then died in the reader with the broadcast already paid
    // for.
    scenario: { name: 'rung-outage', service: cfg.engine, action: 'quiet-one-rung', downMs: quietMs },
    fault: { injectedAtMs: quietedAtMs, liftedAtMs: resumedAtMs, servingAtMs: null },
    silenced: {
      rung: silenced?.name ?? null,
      height: silenced?.height ?? null,
      // ⭐ Filed so a reader can check what was actually stopped against what the run claims.
      processes: transcodes,
      ...outage,
    },
    byteSource: byteSourceArm?.arm && {
      requested: byteSourceArm.arm.requested,
      reported: byteSourceArm.arm.reported,
      settledForMs: byteSourceArm.arm.settledForMs,
    },
    summary: summarize(samples),
    rungs: judgeRungTimeline(samples, outage),
    // The freeze half. A rung outage is a fault like any other from the picture's point of view, and
    // reusing this is what makes its freeze figure comparable with the five crash arms'.
    recovery: judgeRecovery(samples, { injectedAtMs: quietedAtMs, liftedAtMs: resumedAtMs, servingAtMs: null }),
    instrumentProofs,
    instrument: judgeRun(stretches.flatMap((stretch) => stretch.readings)),
    network,
    samples,
    screenshots: stretches.flatMap((stretch) => stretch.screenshots),
    cost,
  };

  const stem = await writeRunArtifacts('browser-rung-outage', runId, {
    markdown: renderRungOutageReport(run),
    run,
    requests: thinRequestLog(requests),
  });

  console.log(`\nbrowser: wrote ${stem}.md`);
  console.log(`browser: instrument ${run.instrument.sound ? 'SOUND' : 'VOID'}`);
  run.instrument.failures.forEach((failure) => console.log(`  ⛔ ${failure}`));
  console.log(
    `browser: silenced ${silenced?.name}, the viewer moved ${run.rungs.before.endedOnRungHeight}p → ` +
      `${run.rungs.during.endedOnRungHeight}p and the picture advanced ${run.rungs.during.advance.ratio.toFixed(3)}`,
  );
  console.log(
    `browser: froze ${(run.recovery.longestFreezeMs / 1000).toFixed(1)}s, the client said ${
      run.recovery.saidWhileFrozen.length > 0 ? `"${run.recovery.saidWhileFrozen.join('", "')}"` : 'NOTHING'
    }`,
  );
  cost.warnings.forEach((warning) => console.log(`  ⚠️ ${warning}`));

  byteSourceArm?.proveBytesCameFromIt(requests);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
