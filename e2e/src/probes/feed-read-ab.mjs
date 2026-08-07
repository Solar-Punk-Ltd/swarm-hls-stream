/**
 * Which way of following a live feed actually keeps up, and is asking for an index before it exists
 * what breaks the others?
 *
 * WHY THIS EXISTS. LAT-10's fix reads `/feeds/{owner}/{topic}` instead of computing the address of
 * the slot after the one already held. But a sequential lookup has to find the end somehow, and the
 * only way to know N is the head is to ask for N+1 and be told no. So bee asks early too, and if
 * asking is what poisons, the fix moves the poisoning one level down and changes nothing.
 *
 * THE TEST. One writer, four topics, one gateway, all at once:
 *
 *   head   read only through `/feeds/{owner}/{topic}`. The committed fix.
 *   edge   explicit address, starting level with the writer, so it asks for slots not yet written.
 *          The shipped client.
 *   lag    explicit address, started deliberately behind, so it never asks for a slot that does not
 *          exist. The control that separates asking early from asking by address.
 *   quiet  written and never read until the run ends. The network's own witness.
 *
 * Identical payloads, same tick, same node, same stamp, so anything separating them is the reading.
 *
 * EACH READER RUNS ITS OWN LOOP. A first attempt polled all three inside one `Promise.all`, which
 * made every tick as slow as the slowest reader. `/feeds/` answers in 1.9s against 42ms for an
 * explicit address, so the shared tick ran at half the write rate, both walkers fell a slot behind
 * per tick, and `edge` asked for a slot that did not exist zero times in 150 polls. The two walkers
 * returned identical figures to two decimals, which is what a coupled rig looks like from outside.
 *
 * RUN IT FROM `e2e`, which is the only workspace package that still declares `cafe-utility`. This is
 * plain ESM rather than TypeScript, so it cannot import the shared module the bench and the player
 * now follow feeds through, and it resolves its dependencies from wherever it is started:
 *
 *   docker run --rm --network host -w /repo/e2e -e STAMP=... swarm-hls-bench:latest \
 *     node src/probes/feed-read-ab.mjs
 */
import { Bee, FeedIndex, Identifier, PrivateKey, Topic } from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';
import { randomBytes } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';

const WRITE_URL = process.env.WRITE_URL ?? 'http://127.0.0.1:10075';
const READ_URL = process.env.READ_URL ?? 'http://127.0.0.1:10077';
const STAMP = process.env.STAMP;
const DURATION_S = Number(process.env.DURATION_S ?? 600);
const WRITE_INTERVAL_MS = Number(process.env.WRITE_INTERVAL_MS ?? 1000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 8000);
const OUT = process.env.OUT ?? '/repo/feed-read-ab.jsonl';

/** How far behind the control reader starts, in slots, so it only ever asks for written slots. */
const LAG_SLOTS = Number(process.env.LAG_SLOTS ?? 20);

/**
 * Wall-clock seconds dropped from the summary at the start of the run.
 *
 * The first writes have to land and every reader has to find its first index, and none of that is
 * steady state. Also covers the control reader waiting for the writer to get `LAG_SLOTS` ahead.
 */
const WARMUP_S = Number(process.env.WARMUP_S ?? 30);

if (!STAMP) {
  throw new Error('STAMP is required');
}

const signer = new PrivateKey(randomBytes(32));
const owner = signer.publicKey().address().toHex();
const runTag = process.env.RUN_TAG ?? String(Date.now());

const TOPICS = {
  head: Topic.fromString(`lat10-head-${runTag}`),
  edge: Topic.fromString(`lat10-edge-${runTag}`),
  chunk: Topic.fromString(`lat10-chunk-${runTag}`),
  lag: Topic.fromString(`lat10-lag-${runTag}`),
  quiet: Topic.fromString(`lat10-quiet-${runTag}`),
};

/**
 * The same explicit-address read as `edge`, issued through bee-js instead of by hand.
 *
 * Worth its own arm because the two are not the same request. The client builds
 * `/soc/{owner}/{identifier}`, and bee-js computes the chunk address and asks for
 * `/chunks/{address}`. Both retrieve one chunk and the difference should be cosmetic, but this
 * session has already turned on a distinction that fine, and the bench is about to be rewritten
 * onto whichever of them is available to it without a new dependency.
 */
const readBee = new Bee(READ_URL);

/** Roughly a windowed manifest, so the chunk is a realistic size rather than a few bytes. */
const PAYLOAD = new TextEncoder().encode('#EXTM3U\n'.padEnd(220, 'x'));

const writeBee = new Bee(WRITE_URL);
const writers = Object.fromEntries(
  Object.entries(TOPICS).map(([name, topic]) => [name, writeBee.makeFeedWriter(topic, signer)]),
);

/** The highest index written to every topic. -1 until the first write lands. */
let written = -1;
let writeFailures = 0;
let startedAt = 0;

const samples = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The address a speculative walk computes, which is what the shipped client asks for. */
function socUrl(topic, index) {
  const identifier = new Identifier(
    Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), FeedIndex.fromBigInt(BigInt(index)).toUint8Array())),
  );
  return `${READ_URL}/soc/${owner}/${identifier.toString()}`;
}

async function timedGet(url) {
  const at = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const indexHeader = res.headers.get('swarm-feed-index');
    return {
      at,
      ms: Date.now() - at,
      status: res.status,
      index: indexHeader ? Number.parseInt(indexHeader, 16) : null,
    };
  } catch {
    return { at, ms: Date.now() - at, status: 0, index: null };
  }
}

function record(sample) {
  samples.push(sample);
  appendFileSync(OUT, `${JSON.stringify(sample)}\n`);
}

async function writeLoop(deadline) {
  while (Date.now() < deadline) {
    const tickAt = Date.now();
    const index = written + 1;
    try {
      await Promise.all(Object.values(writers).map((w) => w.uploadPayload(STAMP, PAYLOAD, { index, deferred: false })));
      written = index;
    } catch (error) {
      writeFailures += 1;
      console.error(`write ${index} failed: ${error.message}`);
    }
    await sleep(Math.max(0, WRITE_INTERVAL_MS - (Date.now() - tickAt)));
  }
}

/** Follows the feed by asking the node to resolve latest, which is what the committed fix does. */
async function headLoop(deadline) {
  while (Date.now() < deadline) {
    const tickAt = Date.now();
    const writtenAtAsk = written;
    const read = await timedGet(`${READ_URL}/feeds/${owner}/${TOPICS.head.toString()}`);
    record({
      reader: 'head',
      atMs: read.at,
      elapsedS: Math.round((read.at - startedAt) / 100) / 10,
      written: writtenAtAsk,
      at: read.index,
      target: null,
      existed: null,
      status: read.status,
      ms: read.ms,
    });
    await sleep(Math.max(0, POLL_INTERVAL_MS - (Date.now() - tickAt)));
  }
}

/** One explicit-index read through bee-js, which asks for `/chunks/{address}` rather than `/soc/`. */
async function chunkGet(topic, index) {
  const at = Date.now();
  try {
    const reader = readBee.makeFeedReader(topic, owner);
    await reader.downloadPayload({ index: FeedIndex.fromBigInt(BigInt(index)) });
    return { at, ms: Date.now() - at, status: 200, index: null };
  } catch {
    return { at, ms: Date.now() - at, status: 404, index: null };
  }
}

/** Follows the feed one computed address at a time, which is what the shipped client does. */
async function walkLoop(name, topic, startAt, deadline, get = (t, i) => timedGet(socUrl(t, i))) {
  let at = startAt;
  while (Date.now() < deadline) {
    const tickAt = Date.now();
    const target = at + 1;
    /** Whether the writer had already written this slot when it was asked for. */
    const existed = written >= target;
    const writtenAtAsk = written;
    const read = await get(topic, target);
    if (read.status === 200) {
      at = target;
    }
    record({
      reader: name,
      atMs: read.at,
      elapsedS: Math.round((read.at - startedAt) / 100) / 10,
      written: writtenAtAsk,
      at,
      target,
      existed,
      status: read.status,
      ms: read.ms,
    });
    await sleep(Math.max(0, POLL_INTERVAL_MS - (Date.now() - tickAt)));
  }
}

async function main() {
  console.log(`owner ${owner}`);
  console.log(`writing ${WRITE_URL}, reading ${READ_URL}`);
  for (const [name, topic] of Object.entries(TOPICS)) {
    console.log(`  ${name.padEnd(5)} ${topic.toString()}`);
  }
  console.log(`${DURATION_S}s, write every ${WRITE_INTERVAL_MS}ms, poll every ${POLL_INTERVAL_MS}ms`);
  console.log(`control reader starts ${LAG_SLOTS} slots behind, first ${WARMUP_S}s dropped\n`);
  writeFileSync(OUT, '');

  startedAt = Date.now();
  const deadline = startedAt + DURATION_S * 1000;
  const running = [writeLoop(deadline)];

  // Neither walker can start before the writer, or it spends the run catching up instead of doing
  // the thing it is here to do.
  while (written < LAG_SLOTS && Date.now() < deadline) {
    await sleep(100);
  }
  running.push(headLoop(deadline));
  running.push(walkLoop('edge', TOPICS.edge, written, deadline));
  running.push(walkLoop('chunk', TOPICS.chunk, written, deadline, chunkGet));
  running.push(walkLoop('lag', TOPICS.lag, written - LAG_SLOTS, deadline));

  await Promise.all(running);

  // The witness, read once, only now. A current head here says every chunk was retrievable all
  // along and that reading is what broke the others.
  const quiet = await timedGet(`${READ_URL}/feeds/${owner}/${TOPICS.quiet.toString()}`);
  report(quiet);
}

/** Staleness in slots, and the share of polls that saw nothing new while the writer was ahead. */
function scoreReader(rows) {
  const staleness = [];
  let frozenPolls = 0;
  let previous = null;

  for (const row of rows) {
    if (row.at === null || row.at < 0 || row.written < 0) {
      continue;
    }
    staleness.push(row.written - row.at);
    if (previous !== null && row.at === previous && row.written > row.at) {
      frozenPolls += 1;
    }
    previous = row.at;
  }

  const sorted = [...staleness].sort((a, b) => a - b);
  return {
    polls: staleness.length,
    meanStaleness: staleness.reduce((sum, s) => sum + s, 0) / (staleness.length || 1),
    medianStaleness: sorted[Math.floor(sorted.length / 2)] ?? 0,
    worstStaleness: sorted[sorted.length - 1] ?? 0,
    frozenShare: frozenPolls / (staleness.length || 1),
  };
}

/** Where a set of response times sits, because a remembered negative is fast and flat. */
function timings(times) {
  if (times.length === 0) {
    return 'none';
  }
  const sorted = [...times].sort((a, b) => a - b);
  const mean = Math.round(times.reduce((sum, t) => sum + t, 0) / times.length);
  return `n=${String(times.length).padStart(4)} mean=${String(mean).padStart(5)}ms median=${String(
    sorted[Math.floor(sorted.length / 2)],
  ).padStart(5)}ms min=${sorted[0]}ms max=${sorted[sorted.length - 1]}ms`;
}

function report(quiet) {
  const scored = samples.filter((s) => s.elapsedS >= WARMUP_S);
  const byReader = (name) => scored.filter((s) => s.reader === name);

  console.log(`\nwrote ${written + 1} slots to each topic, ${writeFailures} write failures`);
  console.log(`scored ${scored.length} polls after the first ${WARMUP_S}s\n`);
  console.log('staleness in slots behind the writer:');
  for (const name of ['head', 'edge', 'chunk', 'lag']) {
    const score = scoreReader(byReader(name));
    console.log(
      `  ${name.padEnd(5)} polls=${String(score.polls).padStart(4)}  mean=${score.meanStaleness
        .toFixed(2)
        .padStart(7)}  ` +
        `median=${String(score.medianStaleness).padStart(4)}  worst=${String(score.worstStaleness).padStart(4)}  ` +
        `frozen=${(score.frozenShare * 100).toFixed(1)}%`,
    );
  }

  // The separation that names the mechanism. A slot refused after it was written is the defect, and
  // asking for one before it was written is the ordinary case suspected of causing it.
  console.log('\nexplicit-address reads, split by whether the slot existed when it was asked for:');
  for (const name of ['edge', 'chunk', 'lag']) {
    for (const existed of [true, false]) {
      const rows = byReader(name).filter((s) => s.existed === existed);
      if (rows.length === 0) {
        console.log(`  ${name} ${existed ? 'already written' : 'not yet written'}: no asks`);
        continue;
      }
      const hits = rows.filter((s) => s.status === 200);
      const misses = rows.filter((s) => s.status !== 200);
      console.log(
        `  ${name} ${existed ? 'already written' : 'not yet written'}: ${rows.length} asks, ${hits.length} hit, ${
          misses.length
        } refused`,
      );
      console.log(`    hit    ${timings(hits.map((s) => s.ms))}`);
      console.log(`    refuse ${timings(misses.map((s) => s.ms))}`);
    }
  }
  console.log(
    `\n  head 200 ${timings(
      byReader('head')
        .filter((s) => s.status === 200)
        .map((s) => s.ms),
    )}`,
  );
  console.log(
    `  head not 200 ${timings(
      byReader('head')
        .filter((s) => s.status !== 200)
        .map((s) => s.ms),
    )}`,
  );

  console.log(`\nquiet topic, never read until now: status=${quiet.status} index=${quiet.index} in ${quiet.ms}ms`);
  console.log(`  the writer reached ${written}, so this reader is ${written - (quiet.index ?? 0)} slots behind`);
  console.log(`\nsamples: ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
