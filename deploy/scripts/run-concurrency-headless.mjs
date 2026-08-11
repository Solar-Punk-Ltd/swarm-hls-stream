/**
 * Runs `in-browser-concurrency-sweep.js` unattended, the way `run-sustain-headless.mjs` does for the
 * sustain probe.
 *
 * The sweep already refuses to guess: it validates the plan, keeps every fetch as its own row, and
 * computes no throughput at all, because every in-browser throughput figure retracted before
 * 2026-08-11 was retracted for the arithmetic applied afterwards rather than for a mistimed fetch.
 * This driver adds nothing to that contract. It supplies the plan, waits, and saves the rows.
 *
 * ⭐ THE CANARIES SHOULD BE SOMEBODY ELSE'S CONTENT. The sweep discards a round whose canary misses,
 * treating that as node sickness. While the canary was made of our own uploads it could not separate
 * a sick node from missing content, and our corpus turned out to be decaying, so rounds were being
 * discarded for the wrong reason. Pass canaries from a stream that is known to be read.
 *
 * ⛔ ONE weeb-3 node per machine. See `cdp.mjs`.
 *
 * Usage:
 *   node deploy/scripts/run-concurrency-headless.mjs <plan.json> <out.tsv>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { clickPage, evaluate, sleep, withPage } from './cdp.mjs';

const WEEB3 = 'https://lat-murmeldjur.github.io/weeb-3/';
const SWEEP = fileURLToPath(new URL('./in-browser-concurrency-sweep.js', import.meta.url));

const SETTLE_MS = 4000;
const POLL_MS = 15000;
const PEER_FLOOR = 150;
const PEER_WAIT_ATTEMPTS = 60;
/** A sweep this size runs in minutes; the ceiling exists so a wedged node ends the process. */
const RUN_DEADLINE_MS = 45 * 60 * 1000;

const [, , planPath, outPath] = process.argv;
if (!planPath || !outPath) {
  throw new Error('usage: run-concurrency-headless.mjs <plan.json> <out.tsv>');
}
const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

async function waitForPeers(client) {
  for (let attempt = 0; attempt < PEER_WAIT_ATTEMPTS; attempt++) {
    const connected = Number(
      await evaluate(client, `(document.body.innerText.match(/Connected:\\s*(\\d+)/) || [])[1] || 0`),
    );
    if (connected >= PEER_FLOOR) {
      return connected;
    }
    await sleep(2000);
  }
  throw new Error(`node never reached ${PEER_FLOOR} peers, so no arm here would mean anything`);
}

await withPage(WEEB3, async (client) => {
  await sleep(SETTLE_MS);
  await clickPage(client);
  console.log(`peers ${await waitForPeers(client)}`);

  await evaluate(
    client,
    `Object.assign(window, {
      __concRefs: ${JSON.stringify(plan.refs)},
      __concCanaries: ${JSON.stringify(plan.canaries)},
      __concArms: ${JSON.stringify(plan.arms)},
      __concRounds: ${plan.rounds},
      __concBlock: ${plan.block},
    }), 'plan set'`,
  );

  // The committed harness, not a copy of it, so the sitting and the repository cannot disagree about
  // what was measured.
  await evaluate(client, `(() => { ${readFileSync(SWEEP, 'utf-8')} })(), 'sweep armed'`);

  const deadline = Date.now() + RUN_DEADLINE_MS;
  for (;;) {
    await sleep(POLL_MS);
    const state = await evaluate(client, `window.__conc && window.__conc.state`);
    const progress = await evaluate(client, `JSON.stringify(window.__conc.progress())`);
    console.log(`  ${String(state).padEnd(10)} ${progress}`);
    if (state !== 'running') {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`sweep still running after ${RUN_DEADLINE_MS / 60000} minutes, abandoning`);
    }
  }

  const tsv = await evaluate(client, `window.__conc.tsv()`);
  writeFileSync(outPath, String(tsv));
  const degraded = await evaluate(client, `JSON.stringify(window.__conc.degradedRounds)`);
  console.log(`\nrows written to ${outPath}`);
  console.log(`degraded rounds: ${degraded}`);
  console.log(`\nnow run: node deploy/scripts/concurrency-analysis.mjs ${outPath}`);
});
