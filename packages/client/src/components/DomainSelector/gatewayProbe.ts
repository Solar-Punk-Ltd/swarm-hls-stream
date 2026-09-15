/**
 * What the Bee node picker does with an address before it lets a viewer switch to it.
 *
 * The picker used to save whatever was typed and close. A viewer who mistyped a port, or whose node
 * refused this site's origin, then saw a browse page with nothing on it and no way to tell which of
 * those had happened. Everything here is pure or takes an injected fetcher, because this package runs
 * vitest without a DOM and a rule left inside the component is a rule nothing covers.
 */
import { FetchTimeoutError, fetchWithTimeout } from '@/utils/fetchWithTimeout';

/**
 * Long enough for a cold local node, short enough that a wrong port does not feel like a hang.
 *
 * Exported so the test asserts the window the picker actually uses. Asserting only that it is above
 * zero passes for ten minutes, which is a picker held open rather than a bounded wait.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Bee answers this on its API port with `{"status":"ok",...}` in every version this project has
 * targeted, and the deployed nginx `/bee/` proxy forwards it unchanged, so one path covers the
 * default gateway and a viewer's own node alike.
 */
export const BEE_PROBE_PATH = '/health';

/** Both a viewer's typing and a saved address, since every caller joins with a path of its own. */
function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * What a viewer typed, as a base URL a Bee API path can be appended to, or an empty string.
 *
 * A bare `host:port` gets `http://`, because that is how an address is copied out of Swarm Desktop or
 * a terminal. A path-only value such as `/bee` is kept as it is, since that is what a deployed build
 * defaults to.
 *
 * Named apart from `normalizeGatewayUrl` in `e2e/src/browser/gatewaySweep.ts`, which strips the
 * trailing slash and nothing else. Two functions under one name doing different work is the trap.
 */
export function beeBaseUrlFromTypedAddress(input: string): string {
  const trimmed = withoutTrailingSlash(input.trim());
  if (!trimmed || trimmed.startsWith('/') || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

/**
 * Hosts a browser treats as trustworthy whatever the scheme, so a plain `http` node on one of them
 * is not blocked from an `https` page.
 *
 * Chrome and Firefox both exempt loopback, which is why the common case of a node on the viewer's
 * own machine works and only a node on another machine fails. Written out rather than inferred,
 * because the exemption belongs to the browser and this list is a claim about what it does.
 */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.startsWith('127.') || hostname === '[::1]'
  );
}

/**
 * Whether the browser will refuse this address before any request leaves the page.
 *
 * An `https` page may not load a plain `http` subresource, so a node typed as `192.168.1.20:1633`
 * from the deployed site is blocked as mixed content. The `fetch` rejects with the same `TypeError`
 * a closed port and a CORS refusal produce, which is why this has to be decided before the request
 * rather than read off the failure.
 *
 * Exported because it is the one failure this module can name exactly rather than guess at.
 */
export function isBlockedAsMixedContent(gatewayUrl: string, pageProtocol: string): boolean {
  if (pageProtocol !== 'https:') {
    return false;
  }
  try {
    const candidate = new URL(gatewayUrl);
    return candidate.protocol === 'http:' && !isLoopbackHost(candidate.hostname);
  } catch {
    // A path-only address such as the deployed `/bee` default, which is served by this page's own
    // origin and carries its scheme with it.
    return false;
  }
}

type GatewayProbeOutcome =
  | { kind: 'ok' }
  | { kind: 'rejected'; status: number }
  /** An `http` node named from an `https` page, which the browser refuses before anything is sent. */
  | { kind: 'mixed-content' }
  /**
   * Something answered 2xx and it was not Bee's health document. A web server with a single-page
   * fallback route answers any path with its index page and a 200, which is the case a status-only
   * check waves through.
   */
  | { kind: 'not-bee' }
  | { kind: 'timed-out' }
  /** No answer at all: connection refused, wrong port, DNS miss, or the node blocked this site. */
  | { kind: 'unreachable' };

interface GatewayProbeOptions {
  /** Injected only by tests. Production always uses the bounded fetcher. */
  fetcher?: typeof fetchWithTimeout;
  /**
   * The scheme this page is served over. Injected only by tests, and read lazily in production
   * because this package runs vitest with no DOM, where touching `window` at module load is a
   * `ReferenceError`.
   */
  pageProtocol?: string;
}

/** Empty off a browser, where nothing is being loaded into a page and nothing can be blocked. */
function currentPageProtocol(): string {
  return typeof window === 'undefined' ? '' : window.location.protocol;
}

/**
 * Ask an address whether a Bee node is behind it. Never throws: every failure is an outcome.
 *
 * The window is `fetchWithTimeout`'s, which covers headers and body together. A node that accepts the
 * connection and answers nothing is therefore a `timed-out` rather than a picker held open, and it
 * reaches a viewer as its own message: that node exists and is slow, which is a different next step
 * from one that cannot be reached at all.
 */
export async function probeGateway(
  gatewayUrl: string,
  { fetcher = fetchWithTimeout, pageProtocol = currentPageProtocol() }: GatewayProbeOptions = {},
): Promise<GatewayProbeOutcome> {
  // Asked before the fetch, because this is the one failure that is knowable without one and the
  // only one whose cause survives: once the browser has refused it, what reaches this code is
  // indistinguishable from a closed port.
  if (isBlockedAsMixedContent(gatewayUrl, pageProtocol)) {
    return { kind: 'mixed-content' };
  }

  try {
    const response = await fetcher(`${gatewayUrl}${BEE_PROBE_PATH}`, { timeoutMs: PROBE_TIMEOUT_MS });
    if (!response.ok) {
      return { kind: 'rejected', status: response.status };
    }
    return looksLikeBeeHealth(response.text) ? { kind: 'ok' } : { kind: 'not-bee' };
  } catch (error) {
    // A browser reports a CORS refusal, a closed port and a DNS miss identically, as a rejected fetch
    // with no status, so everything that is not the bounded wait running out lands in one outcome.
    return error instanceof FetchTimeoutError ? { kind: 'timed-out' } : { kind: 'unreachable' };
  }
}

/**
 * Bee's `/health` body is `{"status":"ok","version":...,"apiVersion":...}` and has been since the API
 * was versioned. Only the shape is read, not the value: a node reporting `nok` is still a Bee node,
 * and a viewer is better served by pointing at it than by being told it is not there.
 */
function looksLikeBeeHealth(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && typeof (parsed as { status?: unknown }).status === 'string';
  } catch {
    return false;
  }
}

/** Both answers a wrong port produces need the same next step, so the sentence is written once. */
const CHECK_THE_PORT = 'Check the port: the Bee API is usually 1633.';

/** Success is not described. The picker closes on it, so a sentence for it is one no viewer reads. */
type GatewayProbeFailure = Exclude<GatewayProbeOutcome, { kind: 'ok' }>;

/**
 * What the picker tells a viewer about each way this can fail, kept beside the rule so a new failure
 * cannot ship without its copy. The declared return type is what enforces that: a switch that misses
 * a case returns undefined on it and stops compiling. Written for someone who runs a node and does
 * not read network logs.
 */
export function describeProbeFailure(failure: GatewayProbeFailure): string {
  switch (failure.kind) {
    case 'rejected':
      return `Something answered at this address with an error (HTTP ${failure.status}). ${CHECK_THE_PORT}`;
    case 'not-bee':
      return `Something answered at this address, but it is not a Bee node. ${CHECK_THE_PORT}`;
    case 'mixed-content':
      return 'This site is served over https, and a browser refuses to load anything over plain http from it, so the request never leaves this page. Give the node an https address, or open this site over http.';
    case 'timed-out':
      return 'The node accepted the connection and then stopped answering. Check that it has finished starting up, then try again.';
    case 'unreachable':
      return 'Could not reach a Bee node at this address. Check that the node is running, and that it allows this site: set cors-allowed-origins to "*" in its config and restart it.';
  }
}

/**
 * Whether a viewer is already on the gateway the build ships with, which is what decides whether a way
 * back to it is worth offering.
 *
 * Compared without trailing slashes, because a saved address has been through `setGatewayUrl`, which
 * strips them, while the build's own value comes from an environment variable that may carry one. A
 * strict comparison would offer a viewer a way back to where they already are.
 */
export function isDefaultGateway(gatewayUrl: string, defaultGatewayUrl: string): boolean {
  return withoutTrailingSlash(gatewayUrl) === withoutTrailingSlash(defaultGatewayUrl);
}

/**
 * What the header shows beside the picker, so a viewer can see whose node is serving them without
 * opening anything. The default is named rather than shown, because a deployed build's default is
 * `/bee` or an environment value the viewer has never seen. Their own node shows as its host, which
 * is what they typed and will recognise.
 */
export function gatewayLabel(gatewayUrl: string, defaultGatewayUrl: string): string {
  if (isDefaultGateway(gatewayUrl, defaultGatewayUrl)) {
    return 'Default gateway';
  }
  try {
    return new URL(gatewayUrl).host;
  } catch {
    return gatewayUrl;
  }
}
