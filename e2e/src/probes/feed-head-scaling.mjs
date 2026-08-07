/**
 * Does bee's feed head lookup get slower as a feed gets longer?
 *
 * WHY THIS EXISTS. LAT-10 measured `GET /feeds/{owner}/{topic}` against a feed advancing once a
 * second and found it 50 to 57% frozen. The player survives that because it resolves the head once
 * and then walks slot addresses, but the **catalog does not**: `App.tsx` polls `/feeds/` every five
 * seconds through SWR, and every `StreamPreview` thumbnail makes one more, serialised behind a
 * concurrency-1 queue. That is a shipped path on every page load.
 *
 * The catalog's feed is nothing like the one LAT-10 measured, though. It advances when a broadcast
 * starts or stops, so it is idle nearly all the time, and a lookup against an idle feed may well be
 * fast. What it does do is **grow forever**, one slot per lifecycle event, for as long as the
 * deployment lives. So the question that decides whether the catalog needs fixing is not how fast the
 * feed moves, it is whether the lookup costs more the further the head is from zero.
 *
 * THE TEST. Four topics of different lengths, written by one signer to one node under one stamp, then
 * read round-robin in the same tick so that anything separating them is the length rather than the
 * moment. Every topic is idle by the time it is read, which is the catalog's condition.
 *
 *   len 1      one slot, the shortest feed that exists
 *   len 10     a young deployment
 *   len 100    a deployment with some history
 *   len 1000   a deployment with a lot of it
 *
 * Each round also reads the last slot of each topic by explicit address. That is the control: it is
 * one request for a known chunk, so it cannot scale with anything, and any growth it shows is the
 * node or the network rather than the lookup.
 *
 * Costs 1111 chunk writes, which is a rounding error of postage against a depth-22 batch, and no
 * video at all.
 *
 * RUN IT FROM `e2e`, which is the only workspace package that still declares `cafe-utility`:
 *
 *   docker run --rm --network host -w /repo/e2e -e STAMP=... swarm-hls-bench:latest \
 *     node src/probes/feed-head-scaling.mjs
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
const OUT = process.env.OUT ?? '/repo/feed-head-scaling.json';

/** Feed lengths to compare, in slots written. The catalog grows one slot per broadcast lifecycle. */
const LENGTHS = (process.env.LENGTHS ?? '1,10,100,1000').split(',').map(Number);

if (!STAMP) {
  console.error('STAMP is required');
  process.exit(1);
}

const runTag = randomBytes(4).toString('hex');
const signer = new PrivateKey(randomBytes(32));
const owner = signer.publicKey().address().toHex();
const writeBee = new Bee(WRITE_URL);

/** Same shape as a manifest slot, so payload size is not a difference between this and production. */
const PAYLOAD = new TextEncoder().encode(
  ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXTINF:2.0,', `probe-${runTag}.ts`].join('\n'),
);

function slotUrl(topic, index) {
  const identifier = new Identifier(
    Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), FeedIndex.fromBigInt(BigInt(index)).toUint8Array())),
  );
  return `${READ_URL}/soc/${owner}/${identifier.toString()}`;
}

async function timedGet(url) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await response.arrayBuffer();
    return { ms: Date.now() - startedAt, status: response.status };
  } catch (error) {
    return { ms: Date.now() - startedAt, status: 0, error: String(error.message ?? error) };
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
    mean: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

async function writeFeed(topic, slots) {
  const writer = writeBee.makeFeedWriter(topic, signer);
  for (let index = 0; index < slots; index++) {
    await writer.uploadPayload(STAMP, PAYLOAD, { index: FeedIndex.fromBigInt(BigInt(index)), deferred: false });
  }
}

async function main() {
  const feeds = LENGTHS.map((slots) => ({
    slots,
    topic: Topic.fromString(`headscale-${slots}-${runTag}`),
  }));

  console.log(`owner ${owner}, run ${runTag}`);
  for (const feed of feeds) {
    const startedAt = Date.now();
    await writeFeed(feed.topic, feed.slots);
    console.log(`wrote ${feed.slots} slot(s) to ${feed.topic.toString().slice(0, 12)} in ${Date.now() - startedAt}ms`);
  }

  // Every feed is idle from here on, which is the catalog's condition. The settle also keeps the last
  // write of the last feed from being the freshest thing in any cache when the first read lands.
  console.log(`settling ${SETTLE_MS}ms so every feed is read at rest...`);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

  const samples = feeds.map((feed) => ({ ...feed, head: [], slot: [], failures: 0 }));

  for (let round = 0; round < ROUNDS; round++) {
    for (const feed of samples) {
      const head = await timedGet(`${READ_URL}/feeds/${owner}/${feed.topic.toString()}`);
      const slot = await timedGet(slotUrl(feed.topic, feed.slots - 1));
      if (head.status !== 200 || slot.status !== 200) {
        feed.failures += 1;
      }
      feed.head.push(head.ms);
      feed.slot.push(slot.ms);
    }
    if ((round + 1) % 10 === 0) {
      console.log(`round ${round + 1}/${ROUNDS}`);
    }
  }

  const report = samples.map((feed) => ({
    slots: feed.slots,
    topic: feed.topic.toString(),
    failures: feed.failures,
    head: stats(feed.head),
    slot: stats(feed.slot),
    /** The first read of each, kept apart because a cold lookup is the one a page load actually makes. */
    firstHeadMs: feed.head[0],
    firstSlotMs: feed.slot[0],
  }));

  writeFileSync(OUT, `${JSON.stringify({ runTag, owner, readUrl: READ_URL, rounds: ROUNDS, report }, null, 2)}\n`);

  console.log('\nslots | head median |  head p95 | head max | slot median | first head');
  console.log('-----:|------------:|----------:|---------:|------------:|-----------:');
  for (const row of report) {
    console.log(
      `${String(row.slots).padStart(5)} | ${String(row.head.median).padStart(9)}ms | ` +
        `${String(row.head.p95).padStart(7)}ms | ${String(row.head.max).padStart(6)}ms | ` +
        `${String(row.slot.median).padStart(9)}ms | ${String(row.firstHeadMs).padStart(8)}ms`,
    );
  }
  console.log(`\nwritten to ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
