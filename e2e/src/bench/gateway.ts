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

const FEED_TIMEOUT_MS = 15_000;
const SEGMENT_TIMEOUT_MS = 30_000;

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

/** The manifest a viewer's player would load, and when it finished arriving here. */
export async function fetchFeedManifest(
  gatewayUrl: string,
  owner: string,
  topicHex: string,
): Promise<TimedFetch<string>> {
  const response = await timedFetch(`${gatewayUrl}/feeds/${owner}/${topicHex}`, FEED_TIMEOUT_MS);
  const body = await response.text();
  return { body, atMs: Date.now() };
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
 * Fail now, with an actionable message, rather than after the publish has spent postage.
 *
 * Uses bee's own `/health`, so a reachable port serving something else is refused as well as a
 * closed one.
 */
export async function requireGatewayReachable(gatewayUrl: string): Promise<void> {
  let body: string;
  try {
    const response = await timedFetch(`${gatewayUrl}/health`, FEED_TIMEOUT_MS);
    body = await response.text();
  } catch (error) {
    throw new GatewayUnreachableError(gatewayUrl, (error as Error).message);
  }
  if (!body.includes('status')) {
    throw new GatewayUnreachableError(
      gatewayUrl,
      `/health answered something that is not a bee node: ${body.slice(0, 80)}`,
    );
  }
}
