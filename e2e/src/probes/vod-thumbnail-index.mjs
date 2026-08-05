/**
 * Whether a VOD catalog entry's published index actually addresses the manifest its thumbnail wants.
 *
 * `StreamPreview` resolves `/feeds/{owner}/{topic}` once per card to find a VOD manifest whose SOC
 * index the catalog entry already carries. Fix 2 in `docs/reviews/catalog-off-the-head-lookup.md`
 * proposes reading that slot by address instead. Two things have to hold for that to be a fix rather
 * than a regression, and only one of them is about speed:
 *
 *   1. **The bytes are the same.** If the head of a finished stream's feed is newer than the index the
 *      catalog recorded, an index-addressed thumbnail shows an older manifest than today's does. That
 *      would refute the change outright, and it is the reason this probe compares payloads rather than
 *      just timing them.
 *   2. The explicit read is faster, which is the point.
 *
 * Reads the real catalog, so it needs no deploy and no broadcast. Round robin per entry, because this
 * environment drifts between sittings and an all-heads-then-all-slots ordering would attribute that
 * drift to the arm.
 */
import { FeedIndex, Identifier, Topic } from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';

const READ_URL = process.env.READ_URL ?? 'http://127.0.0.1:10077';
const APP_OWNER = process.env.APP_OWNER;
const APP_RAW_TOPIC = process.env.APP_RAW_TOPIC;
const MAX_ENTRIES = Number(process.env.MAX_ENTRIES ?? 12);
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
    const body = await response.text();
    return { ms: Date.now() - startedAt, status: response.status, body, headers: response.headers };
  } catch {
    return { ms: Date.now() - startedAt, status: 0, body: '', headers: new Headers() };
  }
}

function stats(v) {
  if (v.length === 0) {
    return { n: 0, min: 0, median: 0, max: 0 };
  }
  const s = [...v].sort((a, b) => a - b);
  return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
}

/** First line of a manifest body, for a readable mismatch report. */
function shape(body) {
  const segments = (body.match(/^#EXTINF/gm) ?? []).length;
  const vod = body.includes('#EXT-X-ENDLIST');
  return `${body.length}B ${segments}seg ${vod ? 'VOD' : 'live'}`;
}

const appTopic = Topic.fromString(APP_RAW_TOPIC);
const catalog = await timed(`${READ_URL}/feeds/${APP_OWNER}/${appTopic.toString()}`);
if (catalog.status !== 200) {
  console.log(`catalog head lookup failed with ${catalog.status}`);
  process.exit(1);
}

const entries = JSON.parse(catalog.body);
const withIndex = entries.filter((e) => typeof e.index === 'number');
console.log(`catalog: ${entries.length} entries, ${withIndex.length} carry an index, sampling ${MAX_ENTRIES}\n`);

const sample = withIndex.slice(-MAX_ENTRIES);
const headMs = [];
const slotMs = [];
let sameBytes = 0;
let mismatched = 0;
let slotMissing = 0;

for (const entry of sample) {
  const topic = Topic.fromString(entry.topic);
  const head = await timed(`${READ_URL}/feeds/${entry.owner}/${topic.toString()}`);
  const slot = await timed(slotUrl(entry.owner, topic, entry.index));

  headMs.push(head.ms);
  slotMs.push(slot.ms);

  const headIndexHeader = head.headers.get('swarm-feed-index');
  const headIndex = headIndexHeader ? Number.parseInt(headIndexHeader.trim(), 16) : null;

  if (slot.status !== 200) {
    slotMissing += 1;
    console.log(
      `MISS  ${entry.topic.slice(0, 8)} state=${entry.state} index=${entry.index} head=${headIndex} slot status ${
        slot.status
      }`,
    );
    continue;
  }
  if (slot.body === head.body) {
    sameBytes += 1;
    console.log(
      `same  ${entry.topic.slice(0, 8)} state=${entry.state} index=${entry.index} head=${headIndex} ${shape(
        slot.body,
      )} head ${head.ms}ms slot ${slot.ms}ms`,
    );
    continue;
  }
  mismatched += 1;
  console.log(
    `DIFF  ${entry.topic.slice(0, 8)} state=${entry.state} index=${entry.index} head=${headIndex} head[${shape(
      head.body,
    )}] slot[${shape(slot.body)}]`,
  );
}

const h = stats(headMs);
const s = stats(slotMs);
console.log(`\n${'arm'.padEnd(26)}${'min'.padStart(8)}${'median'.padStart(9)}${'max'.padStart(9)}`);
console.log(
  `${'head lookup (today)'.padEnd(26)}${`${h.min}ms`.padStart(8)}${`${h.median}ms`.padStart(9)}${`${h.max}ms`.padStart(
    9,
  )}`,
);
console.log(
  `${'slot by published index'.padEnd(26)}${`${s.min}ms`.padStart(8)}${`${s.median}ms`.padStart(
    9,
  )}${`${s.max}ms`.padStart(9)}`,
);
console.log(`\nsame bytes ${sameBytes}, different ${mismatched}, slot missing ${slotMissing}, of ${sample.length}`);
