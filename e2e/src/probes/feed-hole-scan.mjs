/**
 * Whether a manifest feed ever has a slot that stays unserved, which is the only trigger for LAT-#71.
 *
 * `ManifestFetcher.handleFollowupFetch` pins its index, asks for the next slot, and on a 404 polls
 * that same slot again without advancing. So a slot that is briefly missing costs a delay and the
 * viewer recovers, while a slot that is missing **forever** parks the viewer there for good: the
 * fetcher keeps serving the last manifest, which parses fine, so the parse-error path that would
 * re-anchor the reader is never reached.
 *
 * That makes the whole question empirical and narrow. **A transient hole is not the bug.** This walks
 * every slot a completed broadcast wrote and separates the two: a slot that failed once and answered
 * on a later pass is a delay, a slot that never answers is the trigger.
 *
 * Runs against a feed the deployment already wrote, so it costs no broadcast and no postage.
 *
 *   APP_OWNER=... APP_RAW_TOPIC=... node e2e/src/probes/feed-hole-scan.mjs
 *
 * With no STREAM_OWNER given it takes the newest VOD entry from the app catalog, which is the feed
 * the most recent run wrote.
 */
import { FeedIndex, Identifier, Topic } from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';

const READ_URL = process.env.READ_URL ?? 'http://127.0.0.1:10077';
const APP_OWNER = process.env.APP_OWNER;
const APP_RAW_TOPIC = process.env.APP_RAW_TOPIC;
const STREAM_OWNER = process.env.STREAM_OWNER;
const STREAM_RAW_TOPIC = process.env.STREAM_RAW_TOPIC;
const PASSES = Number(process.env.PASSES ?? 3);
const REQUEST_TIMEOUT_MS = 30_000;

function slotUrl(owner, topic, index) {
  const identifier = new Identifier(
    Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), FeedIndex.fromBigInt(BigInt(index)).toUint8Array())),
  );
  return `${READ_URL}/soc/${owner}/${identifier.toString()}`;
}

async function timed(url) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await response.arrayBuffer();
    return { ms: Date.now() - startedAt, status: response.status, headers: response.headers };
  } catch {
    return { ms: Date.now() - startedAt, status: 0, headers: new Headers() };
  }
}

/** The newest finished broadcast in the catalog, which is the feed the last run wrote. */
async function newestVodEntry() {
  const topic = Topic.fromString(APP_RAW_TOPIC);
  const response = await fetch(`${READ_URL}/feeds/${APP_OWNER}/${topic.toString()}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const entries = await response.json();
  const finished = entries.filter((e) => e.state === 'vod' && typeof e.index === 'number');
  return finished.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)).at(-1);
}

const entry =
  STREAM_OWNER === undefined
    ? await newestVodEntry()
    : { owner: STREAM_OWNER, topic: STREAM_RAW_TOPIC, index: null, title: '(given)' };
if (!entry) {
  console.log('no finished broadcast in the catalog to scan');
  process.exit(1);
}

const topic = Topic.fromString(entry.topic);
const head = await timed(`${READ_URL}/feeds/${entry.owner}/${topic.toString()}`);
const rawIndex = head.headers.get('swarm-feed-index');
const lastSlot = entry.index ?? (rawIndex ? Number.parseInt(rawIndex.trim(), 16) : null);
if (lastSlot === null) {
  console.log('could not establish how many slots this feed has');
  process.exit(1);
}

console.log(`stream ${entry.topic} owner ${entry.owner}`);
console.log(`scanning slots 0..${lastSlot} (${lastSlot + 1} slots), ${PASSES} passes over whatever fails\n`);

let outstanding = Array.from({ length: lastSlot + 1 }, (_, i) => i);
const recoveredOnPass = new Map();
const timings = [];

for (let pass = 1; pass <= PASSES && outstanding.length > 0; pass++) {
  const stillMissing = [];
  for (const slot of outstanding) {
    const read = await timed(slotUrl(entry.owner, topic, slot));
    if (pass === 1) {
      timings.push(read.ms);
    }
    if (read.status === 200) {
      if (pass > 1) {
        recoveredOnPass.set(slot, pass);
      }
      continue;
    }
    stillMissing.push(slot);
  }
  console.log(`pass ${pass}: asked ${outstanding.length}, ${outstanding.length - stillMissing.length} answered`);
  outstanding = stillMissing;
}

const sorted = [...timings].sort((a, b) => a - b);
console.log(
  `\nfirst pass timing: min ${sorted[0]}ms median ${sorted[Math.floor(sorted.length / 2)]}ms max ${sorted.at(-1)}ms`,
);
console.log(`transient holes, missing once then answered: ${recoveredOnPass.size}`);
console.log(`PERMANENT holes, never answered in ${PASSES} passes: ${outstanding.length}`);
if (outstanding.length > 0) {
  console.log(`  slots: ${outstanding.slice(0, 40).join(' ')}${outstanding.length > 40 ? ' …' : ''}`);
  console.log('\nLAT-#71 is reachable on this deployment: a viewer that reaches one of these parks there.');
} else {
  console.log('\nNo permanent hole, so nothing here can park a viewer. The trigger stays unreproduced.');
}
