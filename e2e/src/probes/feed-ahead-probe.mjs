/**
 * Whether a slot the reader is waiting on hides **newer slots that were already retrievable**.
 *
 * ## The question, and why the client's own log cannot answer it
 *
 * `ManifestFetcher` walks a feed by explicit address and stops at the first 404, because a 404 is
 * how a reader that has caught up with the publisher finds out. The uploader-crash run on 2026-08-05
 * showed the cost of that when the 404 means something else: the viewer asked slot **301** one
 * hundred and thirteen times over sixty seconds, was served at last, and then consumed slots 302 to
 * 570 in twelve seconds flat. `docs/bench/crash-at-a-viewer-2026-08-05.md`.
 *
 * That burst has two readings and they call for opposite fixes:
 *
 * - **301 was slow and 302 onward were retrievable the whole time.** The reader was blind, a probe
 *   past the hole recovers about 44 seconds, and task #71 is worth building.
 * - **Nothing was retrievable until t+117 and then everything was.** The reader was correctly
 *   waiting, there was nothing to find, and a probe would cost a request per poll and return nothing.
 *
 * **The client's request log cannot separate them**, because a walk that stops at its first 404 never
 * asks for anything past it. The log has zero requests for 302 during the whole stall. So the reading
 * has to come from an instrument that does ask.
 *
 * ## What this does
 *
 * Follows a live feed sequentially, exactly as the client does, and every time a slot answers 404 it
 * additionally asks for a few slots further on. **Any 200 ahead of a 404 is a hole**, and there is no
 * ambiguity in that direction: a reader at the true head of the feed finds nothing ahead either,
 * because nothing has been written.
 *
 * Reads only, so it costs no broadcast and no postage of its own. It does need something publishing,
 * so run it beside a broadcast, and beside a crash scenario for the case it was written for.
 *
 *   STREAM_OWNER=... STREAM_RAW_TOPIC=... PROBE_SECONDS=180 node e2e/src/probes/feed-ahead-probe.mjs
 *
 * `PROBE_SECONDS` rather than `SECONDS`, which bash owns and resets in any shell the run passes
 * through, so the value read here would be that shell's own age.
 *
 * With no STREAM_OWNER it takes the newest live entry from the app catalog.
 *
 * ## Reading the result
 *
 * Three numbers decide task #71, and the run prints all three:
 *
 * - **holes** is the premise. Zero holes over a crash means #71 has nothing to fix, whatever the
 *   freeze looked like.
 * - **the smallest distance that found one** sizes the probe. A hole always visible at N+1 needs one
 *   extra request, not a ladder.
 * - **ahead-hits while merely caught up** is the false-positive rate, and it sets how many
 *   consecutive unserved polls should pass before a client bothers probing. It should be ~0: a
 *   reader riding the edge is ahead of the publisher, not behind a gap.
 */
import { FeedIndex, Identifier, Topic } from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';

const READ_URL = process.env.READ_URL ?? 'http://127.0.0.1:10077';
const APP_OWNER = process.env.APP_OWNER;
const APP_RAW_TOPIC = process.env.APP_RAW_TOPIC;
const STREAM_OWNER = process.env.STREAM_OWNER;
const STREAM_RAW_TOPIC = process.env.STREAM_RAW_TOPIC;
const SECONDS = Number(process.env.PROBE_SECONDS ?? 180);
const POLL_MS = Number(process.env.POLL_MS ?? 250);
const REQUEST_TIMEOUT_MS = 15_000;

/** How far ahead of a refused slot to look. Doubling, so one run sizes the distance a fix would need. */
const AHEAD = [1, 2, 4, 8, 16, 32];

/** Slots one poll may consume before yielding, matching `MAX_SLOTS_PER_POLL` in the client. */
const MAX_SLOTS_PER_WALK = 16;

const slotUrl = (owner, topic, index) =>
  `${READ_URL}/soc/${owner}/${new Identifier(
    Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), FeedIndex.fromBigInt(BigInt(index)).toUint8Array())),
  ).toString()}`;

async function read(url) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await response.arrayBuffer();
    return { ms: Date.now() - startedAt, status: response.status, headers: response.headers };
  } catch {
    return { ms: Date.now() - startedAt, status: 0, headers: new Headers() };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function newestLiveEntry() {
  const topic = Topic.fromString(APP_RAW_TOPIC);
  const response = await fetch(`${READ_URL}/feeds/${APP_OWNER}/${topic.toString()}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const entries = await response.json();
  return entries
    .filter((entry) => entry.state === 'live')
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    .at(-1);
}

const entry =
  STREAM_OWNER === undefined
    ? await newestLiveEntry()
    : { owner: STREAM_OWNER, topic: STREAM_RAW_TOPIC, title: '(given)' };
if (!entry) {
  console.log('no live broadcast in the catalog to follow');
  process.exit(1);
}

const topic = Topic.fromString(entry.topic);
const head = await read(`${READ_URL}/feeds/${entry.owner}/${topic.toString()}`);
const rawIndex = head.headers.get('swarm-feed-index');
if (head.status !== 200 || !rawIndex) {
  console.log(`could not resolve the head of ${entry.topic} (status ${head.status})`);
  process.exit(1);
}

let index = Number.parseInt(rawIndex.trim(), 16);
console.log(`following ${entry.topic} owner ${entry.owner} from slot ${index}, for ${SECONDS}s\n`);

const startedAt = Date.now();
const deadline = startedAt + SECONDS * 1_000;
const since = () => ((Date.now() - startedAt) / 1_000).toFixed(1);

/** One occasion where a slot was refused, and what the slots past it said at that moment. */
const refusals = [];
let polls = 0;
let slotsRead = 0;
let unservedRun = 0;

while (Date.now() < deadline) {
  polls++;

  // Walks to the publisher's head, exactly as `ManifestFetcher` does since `ce87d3a`, rather than
  // taking one slot per poll.
  //
  // ⚠️ **The one-slot-per-poll version of this measured nothing.** It read 3.34 slots a second
  // against a publisher writing 3.75, so it lost ground continuously and was never at the live edge.
  // Every 404 it did meet was a moment it had briefly caught up, which is why its longest stall was
  // three polls on a run where the uploader was killed for fifteen seconds. An instrument that
  // cannot reach the edge cannot see what happens there, and this is the same defect the client was
  // fixed for in task #84.
  let target = index + 1;
  let answer = await read(slotUrl(entry.owner, topic, target));
  for (let consumed = 0; answer.status === 200 && consumed < MAX_SLOTS_PER_WALK; consumed++) {
    index = target;
    slotsRead++;
    unservedRun = 0;
    target = index + 1;
    answer = await read(slotUrl(entry.owner, topic, target));
  }

  if (answer.status === 200) {
    await sleep(POLL_MS);
    continue;
  }

  unservedRun++;
  const ahead = [];
  for (const distance of AHEAD) {
    const probe = await read(slotUrl(entry.owner, topic, target + distance));
    ahead.push({ distance, status: probe.status, ms: probe.ms });
  }

  const served = ahead.filter((probe) => probe.status === 200);
  refusals.push({
    atS: Number(since()),
    slot: target,
    unservedRun,
    aheadServed: served.map((probe) => probe.distance),
    ahead,
  });

  if (served.length > 0) {
    console.log(
      `t+${since()}s  slot ${target} refused on poll ${unservedRun} of its run, ` +
        `but ${served.length} of ${AHEAD.length} probes ahead were SERVED: +${served.map((p) => p.distance).join(' +')}`,
    );
  }

  await sleep(POLL_MS);
}

const holes = refusals.filter((refusal) => refusal.aheadServed.length > 0);
const nearest = holes.map((hole) => Math.min(...hole.aheadServed));
const longestRun = refusals.reduce((worst, refusal) => Math.max(worst, refusal.unservedRun), 0);

console.log(`\npolls ${polls}, slots read ${slotsRead}, slots refused ${refusals.length}`);
console.log(`longest run of polls stuck on one slot: ${longestRun}`);
console.log(`\nHOLES, a refused slot with a served slot behind it: ${holes.length}`);

if (holes.length === 0) {
  console.log(
    '\nEvery refusal had nothing behind it either, so the reader was at the head of the feed and\n' +
      'waiting was correct. On this run a probe past the refusal would have found nothing, and\n' +
      'task #71 has no reachable trigger here.',
  );
} else {
  const byRun = holes.filter((hole) => hole.unservedRun > 1).length;
  console.log(`  smallest distance that found one: +${Math.min(...nearest)}`);
  console.log(`  largest of those smallest distances: +${Math.max(...nearest)}`);
  console.log(`  of these, past the first poll of their run: ${byRun}`);
  console.log(`  first at t+${holes[0].atS}s on slot ${holes[0].slot}, last at t+${holes.at(-1).atS}s`);
  console.log(
    `\nA reader that stops at its first 404 was blind to these. A probe at +${Math.max(...nearest)}\n` +
      'would have found every one of them, which is what task #71 needs to size its fix.',
  );
}

console.log(`\nJSON: ${JSON.stringify({ entry: entry.topic, polls, slotsRead, longestRun, refusals }).length} bytes`);
process.stdout.write(
  `\n---JSON---\n${JSON.stringify({ owner: entry.owner, topic: entry.topic, seconds: SECONDS, polls, slotsRead, longestRun, holes: holes.length, refusals }, null, 2)}\n`,
);
