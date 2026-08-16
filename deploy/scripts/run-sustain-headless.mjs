/**
 * Runs `in-browser-sustain.js` unattended, so a sitting no longer costs a person twelve minutes.
 *
 * ## Why this was believed impossible until 2026-08-11
 *
 * The probe refuses to run on a hidden document, because an agent-driven pane is hidden and a hidden
 * page has its timers throttled and its muted video paused. weeb-3 is one JS thread driven by timers,
 * so a hidden tab starves the node into something that reads exactly like poor network throughput,
 * with `video.error` null and nothing raised anywhere. Two sittings were lost to that.
 *
 * ⭐⭐ **Hidden and headless are different things, and conflating them cost a week.** Measured with
 * this driver on 2026-08-11: `--headless=new` reports `visibilityState: visible`, reaches
 * **200 connected / 0 connecting in 10 seconds**, holds it, registers and is controlled by the
 * service worker, and shows a worst timer drift of **1.08x over 145 seconds**. That is a better peer
 * table, sooner, than the human sittings this replaces, which typically plateaued at 134-147.
 *
 * ⛔ REFUTED 2026-08-15: there is no one-node-per-machine limit. Six, then twelve, separate
 * browser processes each reached 200 peers on one host. See `cdp.mjs` for what produced the
 * original numbers and for the harness rule that survives it.
 *
 * Usage:
 *   node deploy/scripts/run-sustain-headless.mjs <stream> [minutes] [out.json]
 *   node deploy/scripts/run-sustain-headless.mjs abel-1 12 docs/bench/abel-1-headless.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

import { clickPage, evaluate, sleep, withPage } from './cdp.mjs';
import { coresBetween, enableMetrics, readMetrics, sampleChromeCpu, summarizeCpu } from './chrome-cpu.mjs';

const WEEB3 = 'https://lat-murmeldjur.github.io/weeb-3/';
const PROBE = fileURLToPath(new URL('./in-browser-sustain.js', import.meta.url));

const SETTLE_MS = 4000;
const POLL_MS = 15000;
/**
 * Matched to `cold-gateway-idle-cpu.sh`, which sampled every five seconds and resolved a burst that
 * was over by twenty-five. A fifteen-second CPU sample would have reported that gateway's 14x startup
 * cost as a single smeared bucket, so this deliberately samples faster than the state poll.
 */
const CPU_SAMPLE_MS = 5000;
/** The null control: what an empty headless Chrome costs before anything is navigated to. */
const IDLE_WINDOW_MS = 10000;

const machineCores = availableParallelism();
/** Whatever the run asks for, plus the probe's own peer wait and a margin, before giving up. */
const OVERHEAD_MS = 6 * 60 * 1000;

const [stream, minutesArg, outPath] = process.argv.slice(2);
if (!stream) {
  console.error('usage: run-sustain-headless.mjs <stream> [minutes] [out.json]');
  process.exit(1);
}
const minutes = Number(minutesArg ?? 12);

const summary = await withPage(
  WEEB3,
  async (client, { pid, idleCpu, idleSeconds }) => {
    await enableMetrics(client);

    /** @type {{atS: number, cpuSeconds: number, taskDuration: number|null, byType: Record<string, number>, processCount: number}[]} */
    const cpuSamples = [];
    /** Sampling failures are collected rather than swallowed, and reported beside the result. */
    const cpuErrors = [];
    const startedAtMs = Date.now();
    /** Set on the first poll that sees the playhead move, which is what splits startup from steady state. */
    let firstPlayheadAtS = null;

    const takeCpuSample = async () => {
      // Playback is read HERE rather than off the fifteen-second state poll, because that poll's
      // granularity was the whole width of the startup window it was being asked to bound: the first
      // validation run put the boundary at 30.2s for a stream whose own `startupS` was 2.0.
      const [tree, metrics, playing] = await Promise.all([
        sampleChromeCpu(pid),
        readMetrics(client),
        evaluate(client, '(window.__sustain?.samples?.length ?? 0) > 0'),
      ]);
      const atS = +((Date.now() - startedAtMs) / 1000).toFixed(1);
      if (playing && firstPlayheadAtS === null) {
        firstPlayheadAtS = atS;
      }
      cpuSamples.push({
        playing,
        atS,
        cpuSeconds: tree.totalSeconds,
        processCount: tree.processCount,
        byType: tree.byType,
        taskDuration: metrics.TaskDuration,
        scriptDuration: metrics.ScriptDuration,
        heapMB: metrics.JSHeapUsedSize === null ? null : +(metrics.JSHeapUsedSize / 1e6).toFixed(1),
      });
    };

    await takeCpuSample();
    const cpuTimer = setInterval(() => {
      takeCpuSample().catch((error) => cpuErrors.push(error.message));
    }, CPU_SAMPLE_MS);

    try {
      const result = await watch(client);
      await takeCpuSample();
      return {
        ...result,
        cpu: {
          cores: machineCores,
          idle: idleCpu && { seconds: +idleCpu.totalSeconds.toFixed(2), windowS: idleSeconds },
          firstPlayheadAtS,
          samples: cpuSamples,
          errors: cpuErrors,
        },
      };
    } finally {
      clearInterval(cpuTimer);
    }

    async function watch(page) {
      await sleep(SETTLE_MS);

      // Before arming, so the probe's gesture wait resolves on `hasBeenActive` and never reaches the
      // listener that an unattended run has nobody to satisfy.
      console.log(`user activation granted: ${await clickPage(page)}`);

      const armed = await evaluate(
        page,
        `window.__sustainStream = ${JSON.stringify(stream)};
         window.__sustainMinutes = ${minutes};
         ${readFileSync(PROBE, 'utf-8')}`,
      );
      console.log(armed);

      const deadline = Date.now() + minutes * 60 * 1000 + OVERHEAD_MS;
      for (;;) {
        await sleep(POLL_MS);
        const state = await evaluate(
          page,
          `JSON.stringify({
             state: window.__sustain.state,
             err: window.__sustain.err,
             samples: window.__sustain.samples.length,
             peers: window.__sustain.peersAtStart,
             last: window.__sustain.samples[window.__sustain.samples.length - 1] || null,
           })`,
        );
        const seen = JSON.parse(state);
        const recent = cpuSamples[cpuSamples.length - 1];
        const cores = coresBetween(cpuSamples[cpuSamples.length - 2], recent);
        console.log(
          `  ${seen.state.padEnd(14)} samples=${String(seen.samples).padStart(4)}` +
            `  ct=${seen.last?.ct ?? '-'}  buffered=${seen.last?.buffEnd ?? '-'}  peers=${seen.last?.peers ?? '-'}` +
            `  cpu=${cores === null ? '-' : cores.toFixed(2)}c  heap=${recent?.heapMB ?? '-'}MB`,
        );
        if (seen.state === 'done') {
          return JSON.parse(await evaluate(page, 'JSON.stringify(window.__sustain)'));
        }
        if (seen.state === 'error') {
          throw new Error(`probe failed: ${seen.err}`);
        }
        if (Date.now() > deadline) {
          throw new Error(`probe never finished, last state '${seen.state}'`);
        }
      }
    }
  },
  { idleMs: IDLE_WINDOW_MS },
);

console.table(summary.summary);
console.log(`\nCPU, on a ${summary.cpu.cores}-core machine. Startup and steady state are separated`);
console.log('because a browser node dials 160 bootnodes before it plays a frame.\n');
console.table(summarizeCpu(summary.cpu));
if (summary.cpu.errors.length > 0) {
  console.log(`\n⚠️ ${summary.cpu.errors.length} CPU samples failed: ${summary.cpu.errors[0]}`);
}
if (outPath) {
  writeFileSync(outPath, JSON.stringify(summary, null, 1));
  console.log(`\nraw samples written to ${outPath}`);
}
