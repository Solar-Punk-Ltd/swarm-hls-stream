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
 * ⛔ ONE weeb-3 node per machine, still. See `cdp.mjs`.
 *
 * Usage:
 *   node deploy/scripts/run-sustain-headless.mjs <stream> [minutes] [out.json]
 *   node deploy/scripts/run-sustain-headless.mjs abel-1 12 docs/bench/abel-1-headless.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { clickPage, evaluate, sleep, withPage } from './cdp.mjs';

const WEEB3 = 'https://lat-murmeldjur.github.io/weeb-3/';
const PROBE = fileURLToPath(new URL('./in-browser-sustain.js', import.meta.url));

const SETTLE_MS = 4000;
const POLL_MS = 15000;
/** Whatever the run asks for, plus the probe's own peer wait and a margin, before giving up. */
const OVERHEAD_MS = 6 * 60 * 1000;

const [stream, minutesArg, outPath] = process.argv.slice(2);
if (!stream) {
  console.error('usage: run-sustain-headless.mjs <stream> [minutes] [out.json]');
  process.exit(1);
}
const minutes = Number(minutesArg ?? 12);

const summary = await withPage(WEEB3, async (client) => {
  await sleep(SETTLE_MS);

  // Before arming, so the probe's gesture wait resolves on `hasBeenActive` and never reaches the
  // listener that an unattended run has nobody to satisfy.
  console.log(`user activation granted: ${await clickPage(client)}`);

  const armed = await evaluate(
    client,
    `window.__sustainStream = ${JSON.stringify(stream)};
     window.__sustainMinutes = ${minutes};
     ${readFileSync(PROBE, 'utf-8')}`,
  );
  console.log(armed);

  const deadline = Date.now() + minutes * 60 * 1000 + OVERHEAD_MS;
  for (;;) {
    await sleep(POLL_MS);
    const state = await evaluate(
      client,
      `JSON.stringify({
         state: window.__sustain.state,
         err: window.__sustain.err,
         samples: window.__sustain.samples.length,
         peers: window.__sustain.peersAtStart,
         last: window.__sustain.samples[window.__sustain.samples.length - 1] || null,
       })`,
    );
    const seen = JSON.parse(state);
    console.log(
      `  ${seen.state.padEnd(14)} samples=${String(seen.samples).padStart(4)}` +
        `  ct=${seen.last?.ct ?? '-'}  buffered=${seen.last?.buffEnd ?? '-'}  peers=${seen.last?.peers ?? '-'}`,
    );
    if (seen.state === 'done') {
      return JSON.parse(await evaluate(client, 'JSON.stringify(window.__sustain)'));
    }
    if (seen.state === 'error') {
      throw new Error(`probe failed: ${seen.err}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`probe never finished, last state '${seen.state}'`);
    }
  }
});

console.table(summary.summary);
if (outPath) {
  writeFileSync(outPath, JSON.stringify(summary, null, 1));
  console.log(`\nraw samples written to ${outPath}`);
}
