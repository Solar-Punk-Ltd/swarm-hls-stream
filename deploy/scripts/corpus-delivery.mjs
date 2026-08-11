/**
 * Does a reference come back, and how fast, as a function of WHICH CORPUS it belongs to?
 *
 * #71 asked whether the in-browser ceiling was segment size or replication and answered replication:
 * a 225 KB reference of ours missed 0/5 in the same minutes a 4.2 MB reference of his delivered
 * 10/10. Size cannot produce that. What separates the arms is which upload a reference belongs to and
 * how recently anything read it.
 *
 * So the instrument outlived its first question, and this is its general form: any number of named
 * corpora, fetched ONE AT A TIME with the arm order rotated between rounds, so adjacent fetches
 * differ only in which corpus they came from and no arm keeps a favourable position.
 *
 * ⛔ SCORED ON BOTH METRICS, SEPARATELY. Throughput and delivery-inside-a-budget invert with size,
 * which is how "bigger fragments are worse" and "bigger fetches are faster per byte" are both true of
 * the same rows. Reporting one without the other is what produced that mess.
 *
 * ⭐ THE CONTROL IS SOMEBODY ELSE'S CONTENT, DELIBERATELY. The fragment sittings used a canary made
 * of our own uploads, so a failed canary could not tell a sick node from missing content, and the
 * rule that discarded the round destroyed the evidence that would have separated them. A control has
 * to be made of material the experiment is not questioning.
 *
 * Usage: node deploy/scripts/corpus-delivery.mjs <plan.json> [out.json]
 *
 * plan.json:
 *   {
 *     "rounds": 3,
 *     "perArmPerRound": 2,
 *     "control": "his",
 *     "arms": [
 *       { "name": "his",        "feed": { "owner": "47535bf0...", "topic": "d1e6072f..." } },
 *       { "name": "ours-live",  "feed": { "owner": "8d8a30ff...", "topic": "7fd811aa..." } },
 *       { "name": "ours-aug03", "refs": ["3f2a...", "9c11..."] }
 *     ]
 *   }
 *
 * An arm carries either a `feed` to harvest its references from or an explicit `refs` list.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { clickPage, evaluate, sleep, withPage } from './cdp.mjs';

const NODE = 'https://lat-murmeldjur.github.io/weeb-3/';
const BYTES = `${NODE}hls/bytes/`;

const BUDGET_MS = 120000;
const PEER_FLOOR = 150;
const PEER_WAIT_ATTEMPTS = 60;
/** Coprime with any short reference list, so a round does not replay the same few references. */
const REF_STRIDE = 37;

const planPath = process.argv[2];
if (!planPath) {
  throw new Error('usage: corpus-delivery.mjs <plan.json> [out.json]');
}
const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
const rounds = plan.rounds ?? 3;
const perArmPerRound = plan.perArmPerRound ?? 2;

/**
 * @typedef {{ arm: string, round: number, ref: string, ms: number, bytes: number, status: number,
 *             error?: string }} FetchRow
 */

const fetchOne = (ref, arm, round) => `(async () => {
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

/** Segment references as the playlist a feed resolves to lists them, through the node's own route. */
async function refsFromFeed(client, { owner, topic }) {
  const url = `${NODE}feeds/${owner}/${topic}`;
  const text = await evaluate(client, `fetch(${JSON.stringify(url)}).then((r) => r.text())`);
  return [...new Set([...String(text).matchAll(/([0-9a-f]{64})/g)].map((m) => m[1]))];
}

async function waitForPeers(client) {
  for (let attempt = 0; attempt < PEER_WAIT_ATTEMPTS; attempt++) {
    const peers = Number(
      await evaluate(client, `(document.body.innerText.match(/Connected:\\s*(\\d+)/) || [])[1] || 0`),
    );
    if (peers >= PEER_FLOOR) {
      return peers;
    }
    await sleep(2000);
  }
  throw new Error(`node never reached ${PEER_FLOOR} peers, so nothing measured here would mean anything`);
}

/** @type {FetchRow[]} */
const rows = [];
await withPage(NODE, async (client) => {
  await sleep(4000);
  await clickPage(client);
  console.log(`peers ${await waitForPeers(client)}`);

  /** @type {Map<string, string[]>} */
  const armRefs = new Map();
  for (const arm of plan.arms) {
    const refs = arm.feed ? await refsFromFeed(client, arm.feed) : arm.refs;
    if (!refs?.length) {
      throw new Error(`arm ${arm.name} resolved no references`);
    }
    armRefs.set(arm.name, refs);
    console.log(`  ${arm.name.padEnd(16)} ${refs.length} references`);
  }

  console.log('\n  arm                round        KB      ms     KB/s  status');
  for (let round = 0; round < rounds; round++) {
    // Rotated rather than reversed: with more than two arms, reversing only ever swaps the ends and
    // leaves the middle arm permanently mid-round.
    const order = plan.arms.map((_, i) => plan.arms[(i + round) % plan.arms.length]);
    for (let slot = 0; slot < perArmPerRound; slot++) {
      const index = round * perArmPerRound + slot;
      for (const arm of order) {
        const refs = armRefs.get(arm.name);
        const ref = refs[(index * REF_STRIDE) % refs.length];
        const row = JSON.parse(await evaluate(client, fetchOne(ref, arm.name, round)));
        rows.push(row);
        const kb = row.bytes / 1024;
        console.log(
          `  ${row.arm.padEnd(18)}${String(row.round).padStart(3)}  ${kb.toFixed(0).padStart(8)}` +
            `${String(row.ms).padStart(8)}  ${(kb / (row.ms / 1000)).toFixed(1).padStart(7)}  ` +
            `${row.status}${row.error ? ' ' + row.error : ''}`,
        );
      }
    }
  }
});

writeFileSync(process.argv[3] ?? 'corpus-delivery-rows.json', JSON.stringify(rows, null, 1));

const delivered = (name) => rows.filter((r) => r.arm === name && r.status === 200 && r.bytes > 0);
console.log('\n  arm               delivered/tried   meanKB   meanKB/s');
for (const arm of plan.arms) {
  const tried = rows.filter((r) => r.arm === arm.name);
  const done = delivered(arm.name);
  const meanKB = done.reduce((s, r) => s + r.bytes, 0) / (done.length || 1) / 1024;
  const meanRate = done.reduce((s, r) => s + r.bytes / 1024 / (r.ms / 1000), 0) / (done.length || 1);
  console.log(
    `  ${arm.name.padEnd(18)}${String(done.length + '/' + tried.length).padStart(13)}` +
      `${meanKB.toFixed(0).padStart(9)}${meanRate.toFixed(1).padStart(11)}`,
  );
}

if (plan.control) {
  const control = delivered(plan.control).length;
  const tried = rows.filter((r) => r.arm === plan.control).length;
  console.log(
    control * 2 >= tried
      ? `\n  control ${plan.control}: ${control}/${tried}, the node was answering`
      : `\n  ⛔ CONTROL ${plan.control} DELIVERED ${control}/${tried}. The node was not answering, so no arm here means anything.`,
  );
}
