/**
 * #71: is the in-browser throughput ceiling about SEGMENT SIZE or about how well OUR content is
 * replicated?
 *
 * abel-1 sustained 8.34 Mbps on 4.24 MB segments. Our own 3.5 MB references delivered 0/5 on the
 * same kind of node. Those two facts are perfectly confounded: his is a stream people watch, ours
 * were fixtures uploaded once for a bench. Nothing measured so far can tell the two apart.
 *
 * This alternates his references and ours, ONE AT A TIME, in the same node in the same minutes, so
 * the only thing differing between adjacent fetches is whose content it is.
 *
 * ⛔ SCORED ON BOTH METRICS, SEPARATELY. Throughput and delivery-inside-a-budget invert with size,
 * which is how "bigger fragments are worse" and "bigger fetches are faster per byte" are both true
 * of the same rows. Reporting one without the other is what produced that mess.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { clickPage, evaluate, sleep, withPage } from './cdp.mjs';

/**
 * Where the reference lists live. Both are JSON or newline-delimited hex produced by earlier
 * sittings, so this script takes them rather than re-deriving what a previous run already paid for.
 *
 * Usage: node deploy/scripts/size-vs-replication.mjs <refs-dir> [out.json]
 */
const SCRATCH = process.argv[2];
if (!SCRATCH) {
  throw new Error('usage: size-vs-replication.mjs <dir holding q5-refs.json and refs.txt> [out.json]');
}
const OWNER = '47535bf0835ff9cb1c7c7cb4f44fa514f58e703d';
const TOPIC = 'd1e6072ffe54287de3f43dd74eeb8319e0186259a307b37af9b28aacb9f21a7a';
const BYTES = 'https://lat-murmeldjur.github.io/weeb-3/hls/bytes/';
const FEED = `https://lat-murmeldjur.github.io/weeb-3/feeds/${OWNER}/${TOPIC}`;

const ROUNDS = 2;
const PER_ARM_PER_ROUND = 2;
const BUDGET_MS = 120000;
const PEER_FLOOR = 150;

/** Ours, GOP 4, the largest bucket in the archive and the nearest match to his 4.24 MB. */
const OURS = JSON.parse(readFileSync(`${SCRATCH}/q5-refs.json`, 'utf-8'))['4'];
/** Ours from the latbench recording, which was being read successfully earlier TODAY. 90 KB each,
 *  so this arm answers a DELIVERY question and its throughput is not comparable to the big arms. */
const OURS_FRESH = readFileSync(`${SCRATCH}/refs.txt`, 'utf-8').split('\n').filter(Boolean);
/** A small reference of ours, opening every round: a round whose canary misses is not trusted. */
const CANARY = JSON.parse(readFileSync(`${SCRATCH}/q5-refs.json`, 'utf-8'))['0.25'][0];

const FETCH_ONE = (ref, arm, round) => `(async () => {
  const started = performance.now();
  try {
    const response = await fetch(${JSON.stringify(BYTES + ref)}, { signal: AbortSignal.timeout(${BUDGET_MS}) });
    const body = await response.arrayBuffer();
    return JSON.stringify({ arm: ${JSON.stringify(arm)}, round: ${round}, ref: ${JSON.stringify(ref.slice(0, 12))},
      ms: Math.round(performance.now() - started), bytes: body.byteLength, status: response.status });
  } catch (error) {
    return JSON.stringify({ arm: ${JSON.stringify(arm)}, round: ${round}, ref: ${JSON.stringify(ref.slice(0, 12))},
      ms: Math.round(performance.now() - started), bytes: 0, status: 0, error: String(error.name) });
  }
})()`;

/** His segment references, read off the playlist his feed resolves to. */
async function abelRefs(client) {
  const text = await evaluate(client, `fetch(${JSON.stringify(FEED)}).then((r) => r.text())`);
  const refs = [...String(text).matchAll(/([0-9a-f]{64})/g)].map((m) => m[1]);
  return [...new Set(refs)];
}

const rows = [];
await withPage('https://lat-murmeldjur.github.io/weeb-3/', async (client) => {
  await sleep(4000);
  await clickPage(client);

  for (let i = 0; i < 60; i++) {
    const peers = Number(
      await evaluate(client, `(document.body.innerText.match(/Connected:\\s*(\\d+)/) || [])[1] || 0`),
    );
    if (peers >= PEER_FLOOR) {
      console.log(`peers ${peers}`);
      break;
    }
    await sleep(2000);
  }

  const his = await abelRefs(client);
  console.log(`his references found: ${his.length}`);
  if (his.length < ROUNDS * PER_ARM_PER_ROUND) {
    throw new Error(`only ${his.length} of his references, need ${ROUNDS * PER_ARM_PER_ROUND}`);
  }

  console.log('\n  arm     round        KB      ms     KB/s  status');
  for (let round = 0; round < ROUNDS; round++) {
    const plan = [{ arm: 'canary', ref: CANARY }];
    for (let i = 0; i < PER_ARM_PER_ROUND; i++) {
      const index = round * PER_ARM_PER_ROUND + i;
      // His first in even rounds, ours first in odd, so order is not confounded with whose it is.
      const pair = [
        { arm: 'his', ref: his[index] },
        { arm: 'ours-aug03', ref: OURS[index % OURS.length] },
        { arm: 'ours-today', ref: OURS_FRESH[(index * 37) % OURS_FRESH.length] },
      ];
      plan.push(...(round % 2 === 0 ? pair : pair.reverse()));
    }
    for (const item of plan) {
      const row = JSON.parse(await evaluate(client, FETCH_ONE(item.ref, item.arm, round)));
      rows.push(row);
      const kb = row.bytes / 1024;
      console.log(
        `  ${row.arm.padEnd(7)}${String(row.round).padStart(4)}  ${kb.toFixed(0).padStart(8)}` +
          `${String(row.ms).padStart(8)}  ${(kb / (row.ms / 1000)).toFixed(1).padStart(7)}  ${row.status}${row.error ? ' ' + row.error : ''}`,
      );
    }
  }
});

writeFileSync(process.argv[3] ?? `${SCRATCH}/size-vs-replication-rows.json`, JSON.stringify(rows, null, 1));

const arm = (name) => rows.filter((r) => r.arm === name && r.status === 200 && r.bytes > 0);
console.log('\n  arm     delivered/tried   meanKB   meanKB/s');
for (const name of ['his', 'ours-aug03', 'ours-today', 'canary']) {
  const tried = rows.filter((r) => r.arm === name);
  const done = arm(name);
  if (!tried.length) {
    continue;
  }
  const meanKB = done.reduce((s, r) => s + r.bytes, 0) / (done.length || 1) / 1024;
  const meanRate = done.reduce((s, r) => s + r.bytes / 1024 / (r.ms / 1000), 0) / (done.length || 1);
  console.log(
    `  ${name.padEnd(7)}${String(done.length + '/' + tried.length).padStart(15)}` +
      `${meanKB.toFixed(0).padStart(9)}${meanRate.toFixed(1).padStart(11)}`,
  );
}
