/**
 * Whether the viewer's main thread is out of room, which the process tree cannot say.
 *
 * ## ⭐⭐⭐ WHY THIS EXISTS AT ALL
 *
 * The 2026-08-14 sitting measured what an in-tab node costs with `docker stats`, and that is the
 * right instrument for the question it answers: the container cgroup is the whole process tree, so
 * 1.85 cores mean and 3.89 peak is genuinely what a viewer costs a machine. It cannot answer the
 * next question. weeb-3 is **one JS thread** by construction, nineteen runtime loops cooperatively
 * interleaved in a single `join!` with no workers, so a 3.8-core peak on a 48-core box says nothing
 * about whether that one thread is pegged. A viewer whose thread is at 0.98 and a viewer whose thread
 * is at 0.35 look identical from outside and are completely different products.
 *
 * `Performance.getMetrics` reports `TaskDuration`, cumulative seconds the page's main thread spent in
 * tasks. Its slope against wall time IS that thread's utilization, with no scaling and no assumption.
 *
 * ## ⛔⛔⛔ THE TARGET GATE IS THE POINT, NOT THE PLUMBING
 *
 * `cdp.mjs` takes the first target of type `page`, which is correct for a browser it launched itself
 * and **wrong here**. This attaches to a Chrome that Playwright is driving, and that Chrome has more
 * than one page in it: `proveInstrumentCanFail` opens a throwaway context and **deliberately blocks
 * its main thread for a second** to show the timer sensor can fail. A sampler that grabbed the first
 * page could sample the proof instead of the viewer and report a pegged thread that was pegged on
 * purpose, in a different context, by the harness itself.
 *
 * So the page is chosen by URL and the choice refuses when it is not unique. And every target that is
 * NOT the sampled page is carried into the summary by name, because the failure this cannot otherwise
 * see is work happening somewhere it never looked. Our path should have no workers at all:
 * `Weeb3FetchBackend` calls `retrieveBytes` directly and deliberately avoids `attachStream`, which is
 * what would drag in the package's service worker. If one shows up anyway, that claim is wrong and
 * the reading is incomplete, and the summary has to say so rather than quietly average a thread that
 * is not the busy one.
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import { connect, sleep } from './cdp.mjs';
import { enableMetrics, readMetrics } from './chrome-cpu.mjs';

const ENDPOINT_ATTEMPTS = 40;
const ENDPOINT_RETRY_MS = 250;

/** Target types that can run script, so one of them existing means this reading is partial. */
const SCRIPTABLE_TYPES = Object.freeze(['worker', 'service_worker', 'shared_worker', 'worklet']);

/**
 * @typedef {{type: string, url?: string, title?: string, webSocketDebuggerUrl?: string}} CdpTarget
 * @typedef {{page: CdpTarget, unsampled: CdpTarget[], complete: boolean}} TargetChoice
 */

/**
 * The one page to sample, and an honest account of everything left unsampled.
 *
 * ⛔ Throws on zero matches and on more than one, naming what it saw. Picking one of two silently is
 * how a harness measures its own proof page and calls it a viewer.
 *
 * @param {CdpTarget[]} targets
 * @param {string} wantUrl a substring the viewer's URL contains and no other page does
 * @returns {TargetChoice}
 */
export function chooseTarget(targets, wantUrl) {
  const pages = targets.filter((target) => target.type === 'page');
  const matching = pages.filter((target) => String(target.url ?? '').includes(wantUrl));

  if (matching.length === 0) {
    const seen = pages.map((target) => target.url ?? '(no url)').join(', ') || '(no pages at all)';
    throw new Error(`no page target matches ${wantUrl}, so there is nothing to sample. Pages seen: ${seen}`);
  }
  if (matching.length > 1) {
    const seen = matching.map((target) => target.url).join(', ');
    throw new Error(`${matching.length} page targets match ${wantUrl}, so the choice is ambiguous: ${seen}`);
  }

  const page = matching[0];
  const unsampled = targets.filter((target) => target !== page);
  return {
    page,
    unsampled,
    complete: !unsampled.some((target) => SCRIPTABLE_TYPES.includes(target.type)),
  };
}

/**
 * One line naming what was not sampled, loud when any of it can run script.
 *
 * ⛔ Returned even when there is nothing to report, because a control that is silent when it passes
 * teaches a reader to expect silence, and then a real warning reads as ordinary output.
 *
 * @param {TargetChoice} choice
 * @returns {string}
 */
export function describeUnsampled({ unsampled, complete }) {
  if (unsampled.length === 0) {
    return 'no other targets exist, so the sampled page is the whole browser';
  }
  const named = unsampled.map((target) => `${target.type} ${target.url ?? '(no url)'}`).join(', ');
  return complete
    ? `${unsampled.length} other target(s), none able to run script: ${named}`
    : `⛔ INCOMPLETE READING: ${unsampled.length} unsampled target(s) can run script, so work may be ` +
        `happening off this thread: ${named}`;
}

/**
 * Main-thread utilization between two readings, as CPU seconds per wall second.
 *
 * ⛔ Returns null rather than 0 wherever the pair cannot answer. A missing metric that arrives as 0
 * reads as an idle thread, which is the opposite of what an unreadable instrument means.
 *
 * @param {{Timestamp: number|null, TaskDuration: number|null}|null} from
 * @param {{Timestamp: number|null, TaskDuration: number|null}|null} to
 * @returns {number|null}
 */
export function utilisationBetween(from, to) {
  if (!from || !to) {
    return null;
  }
  if (from.Timestamp === null || to.Timestamp === null) {
    return null;
  }
  if (from.TaskDuration === null || to.TaskDuration === null) {
    return null;
  }
  const wallS = to.Timestamp - from.Timestamp;
  return wallS > 0 ? (to.TaskDuration - from.TaskDuration) / wallS : null;
}

/**
 * What a whole arm's samples say about the thread.
 *
 * ⭐ `mean` is taken end to end rather than by averaging the pairwise ratios, so a stretch where
 * sampling stuttered cannot weigh the same as one where it did not. `peak` is the busiest single
 * interval, which is what a stall would be hiding in.
 *
 * @param {Array<{Timestamp: number|null, TaskDuration: number|null}>} samples
 */
export function summariseMainThread(samples) {
  const usable = samples.filter((sample) => sample && sample.Timestamp !== null && sample.TaskDuration !== null);
  if (usable.length < 2) {
    return { samples: samples.length, usable: usable.length, wallS: 0, mean: null, peak: null };
  }

  const first = usable[0];
  const last = usable[usable.length - 1];
  const steps = usable.slice(1).map((sample, index) => utilisationBetween(usable[index], sample));
  const measured = steps.filter((step) => step !== null);

  return {
    samples: samples.length,
    usable: usable.length,
    wallS: last.Timestamp - first.Timestamp,
    mean: utilisationBetween(first, last),
    peak: measured.length > 0 ? Math.max(...measured) : null,
  };
}

/**
 * Wait for the debugging port and pick the viewer's page off it.
 *
 * @param {number|string} port
 * @param {string} wantUrl
 * @returns {Promise<TargetChoice>}
 */
export async function awaitTarget(port, wantUrl) {
  let lastError = new Error(`nothing ever answered on ${port}`);
  for (let attempt = 0; attempt < ENDPOINT_ATTEMPTS; attempt++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      return chooseTarget(targets, wantUrl);
    } catch (error) {
      lastError = error;
    }
    await sleep(ENDPOINT_RETRY_MS);
  }
  throw lastError;
}

/**
 * Sample until the stop file appears, appending one JSON object per reading.
 *
 * ⛔ Appends rather than buffering, so a sitting killed mid-arm keeps everything it had read. The
 * 2026-08-14 sitting is the reason: a harness that writes at the end writes nothing when it is
 * stopped, and the stop is exactly when the reading matters most.
 */
async function main() {
  const [port, wantUrl, outPath, intervalArg, stopFile] = argv.slice(2);
  if (!port || !wantUrl || !outPath) {
    console.error('usage: main-thread.mjs <port> <url-substring> <out.jsonl> [interval_s] [stop_file]');
    process.exit(2);
  }
  const intervalMs = Math.max(1, Number(intervalArg ?? 5)) * 1000;

  const choice = await awaitTarget(port, wantUrl);
  writeFileSync(outPath, '');
  console.log(`main-thread: sampling ${choice.page.url}`);
  console.log(`main-thread: ${describeUnsampled(choice)}`);

  const client = connect(choice.page.webSocketDebuggerUrl);
  await enableMetrics(client);

  const samples = [];
  try {
    while (!(stopFile && existsSync(stopFile))) {
      const reading = await readMetrics(client);
      samples.push(reading);
      appendFileSync(outPath, `${JSON.stringify(reading)}\n`);
      await sleep(intervalMs);
    }
  } finally {
    client.close();
    const summary = { ...summariseMainThread(samples), complete: choice.complete };
    appendFileSync(outPath, `${JSON.stringify({ summary })}\n`);
    console.log(
      `main-thread: ${summary.usable} readings over ${summary.wallS.toFixed(0)}s, ` +
        `mean ${summary.mean === null ? 'unknown' : summary.mean.toFixed(3)} of one thread, ` +
        `peak ${summary.peak === null ? 'unknown' : summary.peak.toFixed(3)}`,
    );
  }
}

// ⚠️ Compared as a resolved file URL rather than by filename. A suffix match is how a module that
// exports pure functions for a test ends up starting a sampler inside the test run.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error(`main-thread: ${error.message}`);
    process.exit(1);
  });
}
