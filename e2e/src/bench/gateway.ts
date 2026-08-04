/**
 * The viewer side of the measurement, fetched **from the bench machine directly** rather than over
 * ssh.
 *
 * That is not a convenience, it is the requirement that makes the whole thing work. The publisher
 * runs here, so capture is stamped by this machine's clock; if the fetch were stamped by the
 * deployment host's, every total would carry the skew between two machines, which is routinely larger
 * than the seconds Sprint 5 is trying to detect. Fetching here keeps both ends on one clock, and it
 * is also the path a real viewer takes: the client makes exactly these two requests against exactly
 * this gateway.
 *
 * The rest of the harness reads the gateway through `host.localJson`, over ssh to `localhost`. That
 * is right for asserting *what* the gateway serves and wrong for measuring *when*, which is why this
 * does not reuse it.
 */

import { FeedIndex, Identifier, Topic } from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';

const FEED_TIMEOUT_MS = 15_000;
const SEGMENT_TIMEOUT_MS = 30_000;

/**
 * A feed slot the publisher has not written yet, which is what a caught-up viewer sees on nearly
 * every poll. Ordinary, so a walking follower stays where it is and asks again rather than failing.
 */
const SLOT_NOT_WRITTEN_YET = 404;

/** A response with the bench-clock instant it finished arriving. */
export interface TimedFetch<T> {
  body: T;
  /** Bench clock, taken once the whole body is in hand rather than at the headers. */
  atMs: number;
}

export class GatewayUnreachableError extends Error {
  constructor(url: string, cause: string) {
    super(
      `the bench cannot reach the viewer gateway at ${url}: ${cause}. Latency has to be measured from ` +
        'the machine that publishes, so this must be reachable from here rather than only from the ' +
        'deployment host. Open the port, or forward it with `ssh -L`, and set BENCH_GATEWAY_URL.',
    );
    this.name = 'GatewayUnreachableError';
  }
}

/** A Swarm reference is a content address: 32 bytes as hex, or 64 when the payload is encrypted. */
const SWARM_REFERENCE_RE = /^(?:[0-9a-f]{64}|[0-9a-f]{128})$/;

/**
 * The Swarm reference a manifest entry points at, or null when the entry does not carry one.
 *
 * The uploader writes absolute URIs built from its own bee url, so an entry is
 * `http://<host>:<port>/bytes/<ref>`. Only the last path element is portable, and it is what the
 * client keeps too: it re-hosts every segment against the gateway the viewer is configured with
 * rather than the one the uploader happened to name.
 *
 * The shape is checked rather than trusted. Taking the last path element of anything means a URI with
 * no path yields a host and port, which then reads as a reference all the way to a request for
 * `/bytes/host:1633` — a 404 an operator would spend the run blaming the gateway for. A reference is
 * a fixed-width content address, so a wrong one can be refused here by looking at it.
 */
export function segmentRefFromUri(uri: string): string | null {
  const withoutQuery = uri.split(/[?#]/)[0];
  const candidate = withoutQuery.split('/').filter(Boolean).at(-1);
  return candidate !== undefined && SWARM_REFERENCE_RE.test(candidate) ? candidate : null;
}

/**
 * A gateway that answered, with a status the caller did not want.
 *
 * Carries the status as a field rather than only in the message, because one of them means something
 * different from the rest and a caller has to be able to tell without parsing prose.
 */
export class GatewayStatusError extends Error {
  readonly status: number;

  constructor(url: string, status: number) {
    super(`${url} answered ${status}`);
    this.name = 'GatewayStatusError';
    this.status = status;
  }
}

async function timedFetch(url: string, timeoutMs: number): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new GatewayStatusError(url, response.status);
  }
  return response;
}

/**
 * Whether a failed feed read is the feed not existing yet, rather than something being wrong.
 *
 * A Swarm feed answers 404 until its first update is written, and the uploader writes that only once
 * the first segment has closed and been uploaded. The bench begins polling as soon as the publisher
 * is up, so the first read of any run can land inside that window. Measured on 2026-08-03: four of
 * five 1080p runs at a one-second GOP died here, on four different feed topics, while the same
 * settings had run clean an hour earlier. Nothing was wrong with the deployment, and reporting those
 * runs as the profile being unstable would have been reporting the instrument.
 *
 * Once the feed has answered at all, a later 404 is a disappearance rather than a wait, and stays
 * fatal. Polling through every 404 instead would turn a feed that vanished mid-run into a short run
 * nobody notices.
 */
export function isFeedPendingFirstWrite(error: unknown, feedSeenBefore: boolean): boolean {
  return !feedSeenBefore && error instanceof GatewayStatusError && error.status === 404;
}

/**
 * How long every feed poll may go on failing before the run is called dead rather than slow.
 *
 * Sized against the effect it must not mistake itself for. LAT-10 freezes the feed for 30 to 45s on a
 * roughly 63 second cycle, so anything near one cycle would report the finding as a broken gateway.
 * Three minutes clears more than two full cycles, which is long enough that a feed still silent
 * afterwards is not slow, it is gone.
 */
export const FEED_BLACKOUT_LIMIT_MS = 180_000;

/**
 * Whether a run of failing feed polls has gone on long enough to mean the gateway is gone.
 *
 * A failed feed poll used to end the run outright, and that was wrong in both directions. It threw
 * away every sample already collected, each of which cost a real broadcast and real postage. And the
 * thing that triggered it was the effect under study: LAT-10 *is* feed polls being slow, so a poll
 * slow enough to exceed the timeout is the strongest sample of it there is, and it was the one sample
 * certain to destroy the run carrying it. A 34-minute run died exactly this way on 2026-08-04 with 30
 * minutes of good samples already in hand.
 *
 * So a failed poll is now recorded as a poll that found nothing, which is what `feedPolls` is for.
 * The limit is what stops that from swinging too far the other way: a gateway that is simply down
 * would otherwise be reported as a feed frozen for the entire broadcast, and that is a wrong answer
 * in the shape of a finding.
 */
export function isFeedBlackout(msSinceLastSuccessfulPoll: number): boolean {
  return msSinceLastSuccessfulPoll >= FEED_BLACKOUT_LIMIT_MS;
}

/**
 * Which feed update the gateway resolved this read to, from its `Swarm-Feed-Index` header.
 *
 * The header is hexadecimal and zero-padded, which is worth stating because every index under
 * sixteen reads as a plausible decimal and the two only diverge later: `0000000000000022` is 34.
 *
 * Null rather than an error when the header is absent or unreadable. It is a diagnostic column, and
 * a run that threw here would trade every latency figure it had for it.
 */
export function resolvedFeedIndex(headers: Headers): number | null {
  const raw = headers.get('swarm-feed-index');
  if (raw === null || !/^[0-9a-fA-F]+$/.test(raw.trim())) {
    return null;
  }
  return Number.parseInt(raw.trim(), 16);
}

/** One read of the feed, and when it finished arriving here. */
export type FeedRead = TimedFetch<string> & { resolvedIndex: number | null };

/** The feed head, resolved by the node. What the player does once, on mount. */
export async function fetchFeedManifest(gatewayUrl: string, owner: string, topicHex: string): Promise<FeedRead> {
  const response = await timedFetch(`${gatewayUrl}/feeds/${owner}/${topicHex}`, FEED_TIMEOUT_MS);
  const resolvedIndex = resolvedFeedIndex(response.headers);
  const body = await response.text();
  return { body, atMs: Date.now(), resolvedIndex };
}

/**
 * How the bench follows the feed.
 *
 * `walk` is what the shipped player does and is the default. `head` is what this bench used to do on
 * every poll, kept because the instrument's own contribution should be measurable rather than argued
 * about.
 */
export type FeedReaderMode = 'walk' | 'head';

export const DEFAULT_FEED_READER: FeedReaderMode = 'walk';

export function parseFeedReaderMode(raw: string | undefined): FeedReaderMode {
  if (raw === undefined || raw === '') {
    return DEFAULT_FEED_READER;
  }
  if (raw !== 'walk' && raw !== 'head') {
    throw new Error(`BENCH_FEED_READER must be 'walk' or 'head', got '${raw}'`);
  }
  return raw;
}

/**
 * The address of one feed slot, which is what the player asks for and therefore what this must ask
 * for too.
 *
 * Hand-built rather than taken from bee-js, because `makeFeedReader().downloadPayload()` is for feeds
 * whose update holds a swarm reference: it fetches the slot and then dereferences the payload with a
 * second `GET /bytes/<ref>`. Our uploader writes the manifest text straight into the slot, so that
 * second request is both wrong and an extra round trip inside the thing being timed.
 */
function feedSlotUrl(gatewayUrl: string, owner: string, topicHex: string, index: FeedIndex): string {
  const identifier = new Identifier(
    Binary.keccak256(Binary.concatBytes(new Topic(topicHex).toUint8Array(), index.toUint8Array())),
  );
  return `${gatewayUrl}/soc/${owner}/${identifier.toString()}`;
}

/**
 * Follows one feed the way the player does, so that what the bench reports is what a viewer sees.
 *
 * **This is the correction to LAT-10 and it is the whole point of the class.** The bench used to
 * resolve the feed with `GET /feeds/{owner}/{topic}` on every single poll. The player asks for that
 * once, on mount, and then walks explicit slot addresses. The two are not close: measured on
 * 2026-08-04 with a synthetic feed advancing one slot per second, the head lookup was **50 to 57%
 * frozen with responses of 1.0 to 7.0 seconds**, while an explicit-address reader riding the live
 * edge was **0.2% frozen at 46ms** and never fell more than two slots behind. It fails the same way
 * against the node that wrote the chunks and holds them locally, so it is the lookup rather than
 * retrieval. See `e2e/src/probes/feed-read-ab.mjs`.
 *
 * So every frozen-share figure this bench produced before this class measured the lookup, not the
 * viewer, and LAT-10's whole history rests on it.
 *
 * A poll that finds no new slot returns the previous manifest again rather than failing, which is
 * exactly what the player serves its own hls.js in that case, and it is what lets the caller keep
 * counting a repeated `newestRef` as a stall.
 */
export class FeedFollower {
  private index: FeedIndex | null = null;
  private last: FeedRead | null = null;

  constructor(
    private readonly gatewayUrl: string,
    private readonly owner: string,
    private readonly topicHex: string,
    private readonly mode: FeedReaderMode = DEFAULT_FEED_READER,
  ) {}

  async read(): Promise<FeedRead> {
    if (this.mode === 'head' || this.index === null || this.last === null) {
      // The anchor, and the only head lookup a walking follower ever performs. The player takes this
      // same path on mount and on every restart.
      const read = await fetchFeedManifest(this.gatewayUrl, this.owner, this.topicHex);
      this.index = read.resolvedIndex === null ? null : FeedIndex.fromBigInt(BigInt(read.resolvedIndex));
      this.last = read;
      return read;
    }
    return this.readNextSlot(this.index, this.last);
  }

  private async readNextSlot(from: FeedIndex, last: FeedRead): Promise<FeedRead> {
    const target = from.next();
    try {
      const response = await timedFetch(
        feedSlotUrl(this.gatewayUrl, this.owner, this.topicHex, target),
        FEED_TIMEOUT_MS,
      );
      const body = await response.text();
      this.index = target;
      this.last = { body, atMs: Date.now(), resolvedIndex: Number(target.toBigInt()) };
      return this.last;
    } catch (error) {
      // The publisher has not written this slot yet, which is what a caught-up viewer meets on
      // nearly every poll. Anything else is the gateway failing, and it belongs to the caller's
      // blackout handling rather than here.
      if (!(error instanceof GatewayStatusError) || error.status !== SLOT_NOT_WRITTEN_YET) {
        throw error;
      }
      return { ...last, atMs: Date.now() };
    }
  }
}

/**
 * A segment's bytes, and the instant the last of them arrived.
 *
 * `atMs` is taken after the body is fully read, not when the response headers land, because a frame
 * is not playable until its segment is complete. Measuring at the headers would understate every
 * total by the download time, which is the one hop this call is meant to measure.
 */
export async function fetchSegment(gatewayUrl: string, ref: string): Promise<TimedFetch<Buffer>> {
  const response = await timedFetch(`${gatewayUrl}/bytes/${ref}`, SEGMENT_TIMEOUT_MS);
  const body = Buffer.from(await response.arrayBuffer());
  return { body, atMs: Date.now() };
}

/**
 * Whether a `/health` body says this is a gateway, or null when it does.
 *
 * A bee node answers JSON carrying `status`. A public Swarm gateway answers the plain text `OK` and
 * serves the feed API perfectly well, and this used to refuse it as "not a bee node". That was the
 * wrong test for the wrong reason, and it stopped mattering in the abstract on 2026-08-03: LAT-10's
 * only no-cost mitigation is to point viewers at a different gateway, and a bench that can only
 * measure a bee node cannot measure whether the mitigation works.
 *
 * What the guard is actually for is still enforced. A port that is open and serving something else,
 * or a proxy answering nothing for a dead upstream, is refused before the publish spends postage.
 */
export function gatewayHealthProblem(body: string): string | null {
  const answer = body.trim();
  if (answer.includes('status') || /^ok$/i.test(answer)) {
    return null;
  }
  return `/health answered something that is not a gateway: ${answer.slice(0, 80) || '(nothing)'}`;
}

/**
 * Fail now, with an actionable message, rather than after the publish has spent postage.
 *
 * Uses `/health`, so a reachable port serving something else is refused as well as a closed one.
 */
export async function requireGatewayReachable(gatewayUrl: string): Promise<void> {
  let body: string;
  try {
    const response = await timedFetch(`${gatewayUrl}/health`, FEED_TIMEOUT_MS);
    body = await response.text();
  } catch (error) {
    throw new GatewayUnreachableError(gatewayUrl, (error as Error).message);
  }
  const problem = gatewayHealthProblem(body);
  if (problem !== null) {
    throw new GatewayUnreachableError(gatewayUrl, problem);
  }
}
