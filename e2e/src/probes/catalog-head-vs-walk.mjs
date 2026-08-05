/**
 * Head lookup against slot walk, on the REAL app catalog feed rather than a synthetic one.
 *
 * This is the prediction from `docs/reviews/catalog-off-the-head-lookup.md` put to the deployment:
 * the catalog poll should fall from seconds to milliseconds. It measures the read pattern rather than
 * the shipped client, so it needs no deploy, and it is the same round-robin shape as every other
 * probe here because this environment drifts between sittings.
 */
import { FeedIndex, Identifier, Topic } from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';

const READ_URL = process.env.READ_URL ?? 'http://127.0.0.1:10077';
const OWNER = process.env.APP_OWNER;
const RAW_TOPIC = process.env.APP_RAW_TOPIC;
const ROUNDS = Number(process.env.ROUNDS ?? 15);

const topic = Topic.fromString(RAW_TOPIC);

function slotUrl(index) {
  const identifier = new Identifier(
    Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), FeedIndex.fromBigInt(BigInt(index)).toUint8Array())),
  );
  return `${READ_URL}/soc/${OWNER}/${identifier.toString()}`;
}

async function timed(url) {
  const startedAt = Date.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  await response.arrayBuffer();
  return { ms: Date.now() - startedAt, status: response.status, headers: response.headers };
}

function stats(v) {
  const s = [...v].sort((a, b) => a - b);
  return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
}

const headUrl = `${READ_URL}/feeds/${OWNER}/${topic.toString()}`;
const first = await timed(headUrl);
const raw = first.headers.get('swarm-feed-index');
const head = raw ? Number.parseInt(raw.trim(), 16) : null;
console.log(`catalog feed ${topic.toString()} owner ${OWNER}`);
console.log(`head resolved to slot ${head} (header ${raw}) in ${first.ms}ms\n`);
if (head === null) {
  console.log('no feed index header, cannot walk');
  process.exit(1);
}

const headMs = [];
const walkHitMs = [];
const walkMissMs = [];
for (let round = 0; round < ROUNDS; round++) {
  headMs.push((await timed(headUrl)).ms);
  walkHitMs.push((await timed(slotUrl(head))).ms);
  try {
    walkMissMs.push((await timed(slotUrl(head + 1))).ms);
  } catch {
    walkMissMs.push(30000);
  }
}

console.log(['arm'.padEnd(26), 'min'.padStart(8), 'median'.padStart(8), 'max'.padStart(8)].join(' '));
for (const [name, v] of [
  ['head lookup (today)', headMs],
  ['walk, slot present', walkHitMs],
  ['walk, slot absent', walkMissMs],
]) {
  const s = stats(v);
  console.log(
    [name.padEnd(26), `${s.min}ms`.padStart(8), `${s.median}ms`.padStart(8), `${s.max}ms`.padStart(8)].join(' '),
  );
}
