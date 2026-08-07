/**
 * What does it cost to ask for a feed slot that does not exist yet?
 *
 * This is the prerequisite for taking the catalog off the head lookup, and it can refute that plan
 * outright. See `docs/reviews/catalog-off-the-head-lookup.md`.
 *
 * The argument for walking a feed instead of resolving its head is that an explicit slot address
 * costs 4ms against 1 to 5 seconds. But a walking reader asks for the slot *after* the one it has,
 * and for a catalog that slot usually does not exist, because broadcasts are rare. A player gets away
 * with this because its next slot almost always does exist, segments being constant.
 *
 * So the question is not what a hit costs. It is what a MISS costs.
 *
 * ## The decision rule, written down before the run
 *
 * - **miss is a few milliseconds**: walking wins outright, and the catalog fix is sound as designed.
 * - **miss is about a second**, matching the hardcoded timeout in bee's feed lookup: walking an idle
 *   catalog is no cheaper than resolving its head, and the plan must change rather than proceed.
 * - **in between**: the answer is quantitative, and the crossover is where the walk stops paying.
 *
 * If both hit and miss come back fast, this run has not proved walking is safe, only that it is
 * cheap. A miss that returns fast but WRONG, for instance a cached empty, would look identical here
 * and is checked separately by asserting the hit still returns the payload it wrote.
 *
 * Usage, on the deployment host, inside the bench container:
 *   STAMP=<batch> node e2e/src/probes/feed-miss-cost.mjs
 */

import { Bee, FeedIndex, Identifier, PrivateKey, Topic } from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const WRITE_URL = process.env.WRITE_URL ?? 'http://127.0.0.1:10075';
const READ_URL = process.env.READ_URL ?? 'http://127.0.0.1:10077';
const STAMP = process.env.STAMP;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 15000);
const ROUNDS = Number(process.env.ROUNDS ?? 30);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 10000);
/** Long enough that the head lookup has real work to do, short enough to write in seconds. */
const SLOTS = Number(process.env.SLOTS ?? 20);
const OUT = process.env.OUT ?? '/repo/feed-miss-cost.json';

if (!STAMP) {
  console.error('STAMP is required');
  process.exit(1);
}

const runTag = randomBytes(4).toString('hex');
const signer = new PrivateKey(randomBytes(32));
const owner = signer.publicKey().address().toHex();
const writeBee = new Bee(WRITE_URL);
const topic = Topic.fromString(`miss-cost-${runTag}`);

const PAYLOAD = new TextEncoder().encode(
  ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXTINF:2.0,', `probe-${runTag}.ts`].join('\n'),
);

function slotUrl(index) {
  const identifier = new Identifier(
    Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), FeedIndex.fromBigInt(BigInt(index)).toUint8Array())),
  );
  return `${READ_URL}/soc/${owner}/${identifier.toString()}`;
}

async function timedGet(url) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = await response.arrayBuffer();
    return { ms: Date.now() - startedAt, status: response.status, bytes: body.byteLength };
  } catch (error) {
    return { ms: Date.now() - startedAt, status: 0, bytes: 0, error: String(error.message ?? error) };
  }
}

function stats(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    n: sorted.length,
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  };
}

async function main() {
  console.log(`writing ${SLOTS} slots to ${topic.toString()} as ${owner}`);
  const writer = writeBee.makeFeedWriter(topic, signer);
  for (let index = 0; index < SLOTS; index++) {
    await writer.uploadPayload(STAMP, PAYLOAD, { index: FeedIndex.fromBigInt(BigInt(index)), deferred: false });
  }

  console.log(`settling ${SETTLE_MS}ms`);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

  const arms = {
    // The slot a walking reader already has. Should be the 4ms path.
    hit: { url: slotUrl(SLOTS - 1), ms: [], statuses: new Set(), bytes: new Set() },
    // The slot a walking reader asks for next, and which an idle catalog never has. The question.
    miss: { url: slotUrl(SLOTS), ms: [], statuses: new Set(), bytes: new Set() },
    // Far past the end, to separate "one past" from "absent" in case they differ.
    farMiss: { url: slotUrl(SLOTS + 5_000), ms: [], statuses: new Set(), bytes: new Set() },
    // What the catalog does today, as the thing to beat.
    head: { url: `${READ_URL}/feeds/${owner}/${topic.toString()}`, ms: [], statuses: new Set(), bytes: new Set() },
  };

  // Round robin rather than arm at a time, because this environment has shown 1.05s of drift between
  // sittings and a blocked design would hand all of it to whichever arm ran last.
  for (let round = 0; round < ROUNDS; round++) {
    for (const arm of Object.values(arms)) {
      const result = await timedGet(arm.url);
      arm.ms.push(result.ms);
      arm.statuses.add(result.status);
      arm.bytes.add(result.bytes);
    }
  }

  const report = {
    measuredAt: new Date().toISOString(),
    owner,
    topic: topic.toString(),
    slots: SLOTS,
    rounds: ROUNDS,
    arms: Object.fromEntries(
      Object.entries(arms).map(([name, arm]) => [
        name,
        { ...stats(arm.ms), statuses: [...arm.statuses], bytes: [...arm.bytes] },
      ]),
    ),
  };

  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n${'arm'.padEnd(10)} ${'median'.padStart(8)} ${'p95'.padStart(8)} ${'max'.padStart(8)}  status`);
  for (const [name, arm] of Object.entries(report.arms)) {
    console.log(
      `${name.padEnd(10)} ${String(arm.median).padStart(6)}ms ${String(arm.p95).padStart(6)}ms ` +
        `${String(arm.max).padStart(6)}ms  ${arm.statuses.join(',')} (${arm.bytes.join(',')} bytes)`,
    );
  }
  console.log(`\nwritten to ${OUT}`);
}

await main();
