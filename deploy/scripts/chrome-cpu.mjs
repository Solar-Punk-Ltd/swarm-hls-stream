/**
 * What the browser cost, read two ways, because neither one alone answers the question.
 *
 * ## ⭐⭐ WHY A PROCESS TREE AND NOT A PID
 *
 * Every CPU figure this project holds was taken off a single PID, in `retrieval-debt-probe.sh`, and
 * that is correct there: bee is one process. Chrome is not. It runs a browser process, a GPU
 * process, one renderer per site and a handful of utilities, and the PID we spawn is the browser
 * process, which mostly supervises. Sampling it alone would report a small, stable, entirely
 * plausible number that is not the cost of anything a viewer does.
 *
 * ## ⭐ WHY ALSO A CDP READING, WHEN THE TREE ALREADY HAS THE TOTAL
 *
 * The tree says how many cores a viewer eats. It cannot say whether weeb-3 is *out* of them. The
 * node is one JS thread by construction, so a machine at 30% of twelve cores can still be a viewer
 * whose single thread is pegged and whose retrieval is capped by that rather than by the network.
 * `Performance.getMetrics` reports `TaskDuration` for the page's main thread, and its growth per
 * wall second is that thread's utilization directly. Two different ceilings, two different readings.
 *
 * ⚠️ The service worker is a separate target and is NOT in the CDP reading here. It IS in the
 * process-tree total. weeb-3 serves HLS through its service worker, so a main-thread figure alone
 * would understate the node and the two numbers must be quoted together.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SECONDS_PER_DAY = 86400;

/**
 * Seconds of CPU time from the several formats `ps` uses, which it switches between by magnitude
 * without saying so: `MM:SS.ss`, then `HH:MM:SS`, then `DD-HH:MM:SS`.
 *
 * ⛔ Throws rather than falling back to 0 or NaN. An unreadable reading that returns a number is
 * indistinguishable from an idle process, and it would be averaged into the result.
 *
 * @param {string} text
 * @returns {number}
 */
export function parseCpuTime(text) {
  const match = /^(?:(\d+)-)?(\d+(?::\d+)*(?:\.\d+)?)$/.exec(String(text).trim());
  if (!match) {
    throw new Error(`unreadable CPU time from ps: "${text}"`);
  }
  const [, days, clock] = match;
  const parts = clock.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`unreadable CPU time from ps: "${text}"`);
  }
  return Number(days ?? 0) * SECONDS_PER_DAY + parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * Which Chrome process this is, taken from the `--type` flag Chrome gives its own helpers.
 *
 * @param {string} command
 * @returns {string}
 */
export function chromeProcessType(command) {
  return /--type=(\S+)/.exec(command)?.[1] ?? 'browser';
}

/**
 * @typedef {object} ProcessRow
 * @property {number} pid
 * @property {number} ppid
 * @property {number} cpuSeconds
 * @property {string} command
 */

/**
 * Splits `ps -o pid=,ppid=,time=,command=` output, whose last column contains spaces and therefore
 * cannot be split on whitespace.
 *
 * @param {string} text
 * @returns {ProcessRow[]}
 */
export function parseProcessTable(text) {
  return text
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map(([, pid, ppid, time, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      cpuSeconds: parseCpuTime(time),
      command,
    }));
}

/**
 * @typedef {object} TreeCpu
 * @property {number} totalSeconds CPU seconds burned by the root and every descendant.
 * @property {number} processCount How many processes that was, which is how a renderer crash shows up.
 * @property {Record<string, number>} byType The same total split by Chrome's own `--type`.
 */

/**
 * Sums CPU across a process and everything descended from it.
 *
 * ⛔⛔ Descends from a PID rather than matching on the executable name, and that is the whole
 * defence against the operator's own Chrome. A name match would charge their open tabs to this
 * measurement, silently, and the figure would look ordinary.
 *
 * @param {readonly ProcessRow[]} rows
 * @param {number} rootPid
 * @returns {TreeCpu}
 */
export function treeCpu(rows, rootPid) {
  const children = new Map();
  for (const row of rows) {
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  }

  const root = rows.find((row) => row.pid === rootPid);
  const collected = [];
  const queue = root ? [root] : [];
  while (queue.length > 0) {
    const row = queue.shift();
    collected.push(row);
    queue.push(...(children.get(row.pid) ?? []));
  }

  return {
    totalSeconds: collected.reduce((total, row) => total + row.cpuSeconds, 0),
    processCount: collected.length,
    byType: collected.reduce((byType, row) => {
      const type = chromeProcessType(row.command);
      return { ...byType, [type]: (byType[type] ?? 0) + row.cpuSeconds };
    }, {}),
  };
}

/**
 * `-ww` so the command column is never truncated to the terminal width, which is the default and
 * would drop the `--type` flag on a narrow terminal and silently relabel every helper `browser`.
 */
export async function readProcessTable() {
  const { stdout } = await run('ps', ['-Awwo', 'pid=,ppid=,time=,command=']);
  return parseProcessTable(stdout);
}

/**
 * @param {number} rootPid
 * @returns {Promise<TreeCpu>}
 */
export async function sampleChromeCpu(rootPid) {
  return treeCpu(await readProcessTable(), rootPid);
}

/**
 * What is carried out of `Performance.getMetrics`.
 *
 * `TaskDuration` is the headline: cumulative seconds the main thread spent in tasks, so its slope is
 * that thread's utilization. `ScriptDuration` is the JS share of it, which is where a one-threaded
 * libp2p node lands. `ProcessTime` and `ThreadTime` are the renderer's own CPU accounting, kept as a
 * cross-check against the process tree rather than as the answer.
 */
export const METRICS_OF_INTEREST = Object.freeze([
  'Timestamp',
  'TaskDuration',
  'ScriptDuration',
  'ThreadTime',
  'ProcessTime',
  'JSHeapUsedSize',
]);

export async function enableMetrics(client) {
  await client.send('Performance.enable');
}

/**
 * Reads the metrics of interest, reporting anything this Chrome did not supply as null.
 *
 * ⚠️ Chrome's metric names are not a stable contract and this runs against whatever Chrome the host
 * has installed. A missing name must not arrive as 0, which would read as "the page did no work".
 *
 * @param {{send: Function}} client
 * @returns {Promise<Record<string, number|null>>}
 */
export async function readMetrics(client) {
  const { metrics } = await client.send('Performance.getMetrics');
  const supplied = new Map(metrics.map(({ name, value }) => [name, value]));
  return Object.fromEntries(METRICS_OF_INTEREST.map((name) => [name, supplied.get(name) ?? null]));
}

/**
 * Cores burned between two samples, which is CPU seconds per wall second and needs no scaling.
 *
 * @returns {number|null} null where the pair cannot answer, never 0, which would read as idle.
 */
export function coresBetween(from, to) {
  if (!from || !to) {
    return null;
  }
  const wallS = to.atS - from.atS;
  return wallS > 0 ? (to.cpuSeconds - from.cpuSeconds) / wallS : null;
}

/**
 * Rates across a closed window of samples.
 *
 * ⭐ `mainThreadUtilization` is the reading the process tree cannot give. weeb-3 is one JS thread, so
 * this approaching 1.0 means the node is out of thread and no amount of spare machine helps, while
 * the same run may show two cores of total Chrome usage across renderer, GPU and decode.
 */
export function windowRates(samples, fromS, toS) {
  const within = samples.filter((sample) => sample.atS >= fromS && sample.atS <= toS);
  const first = within[0];
  const last = within[within.length - 1];
  const wallS = first && last ? last.atS - first.atS : 0;
  if (wallS <= 0) {
    return { wallS: 0, cores: null, mainThreadUtilization: null, peakHeapMB: null };
  }
  const taskable = first.taskDuration !== null && last.taskDuration !== null;
  const heaps = within.map((sample) => sample.heapMB).filter((heap) => heap !== null);
  return {
    wallS: +wallS.toFixed(1),
    cores: +((last.cpuSeconds - first.cpuSeconds) / wallS).toFixed(3),
    mainThreadUtilization: taskable ? +((last.taskDuration - first.taskDuration) / wallS).toFixed(3) : null,
    peakHeapMB: heaps.length > 0 ? Math.max(...heaps) : null,
  };
}

/**
 * The table a run prints, with startup separated from steady state.
 *
 * ⛔ THE SPLIT IS NOT PRESENTATION, IT IS THE FINDING. A cold bee gateway measured 14x its settled
 * CPU for thirty seconds and then stopped, and a browser node dials 160 bootnodes before it plays a
 * frame. An average over the whole run buries a burst of that size in a twelve-minute denominator and
 * reports a number that is true of no part of the run.
 */
export function summarizeCpu({ idle, firstPlayheadAtS, samples }) {
  const lastS = samples.length > 0 ? samples[samples.length - 1].atS : 0;
  const splitS = firstPlayheadAtS ?? lastS;
  return {
    'idle, about:blank': {
      wallS: idle ? idle.windowS : null,
      cores: idle && idle.windowS > 0 ? +(idle.seconds / idle.windowS).toFixed(3) : null,
      mainThreadUtilization: null,
      peakHeapMB: null,
    },
    'startup, to first frame': windowRates(samples, 0, splitS),
    'steady, playing': windowRates(samples, splitS, lastS),
    'whole run': windowRates(samples, 0, lastS),
  };
}
