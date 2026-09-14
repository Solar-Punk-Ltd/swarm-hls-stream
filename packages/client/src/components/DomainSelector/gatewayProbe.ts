/**
 * What the Bee node picker does with an address before it lets a viewer switch to it.
 *
 * The picker used to save whatever was typed and close. A viewer who mistyped a port, or whose node
 * refused this site's origin, then saw a browse page with nothing on it and no idea why. Everything
 * here is pure or takes an injected `fetch`, because `packages/client` runs vitest without jsdom and
 * a rule left inside the component is a rule nothing covers.
 */
/** Long enough for a cold local node, short enough that a wrong port does not feel like a hang. */
export const GATEWAY_PROBE_TIMEOUT_MS = 5_000;

/**
 * Bee answers this on its API port with `{"status":"ok",...}` in every version this project has
 * targeted, and the deployed nginx `/bee/` proxy forwards it unchanged, so it works for the default
 * gateway and a viewer's own node alike.
 */
export const GATEWAY_PROBE_PATH = '/health';

/**
 * Turn what a viewer typed into something the fetcher can prepend to a path.
 *
 * Trailing slashes go, because every caller joins with `${gatewayUrl}/...`. A bare `host:port` gets
 * `http://`, because that is how a non-technical viewer copies an address out of Swarm Desktop or a
 * terminal. A path-only value such as `/bee` is kept as it is, since that is what the default is.
 */
export function normalizeGatewayUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed || trimmed.startsWith('/') || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

export type GatewayProbeOutcome =
  /** The address answered the health check the way Bee does. */
  | { kind: 'ok' }
  /** Something answered with an error status. */
  | { kind: 'rejected'; status: number }
  /**
   * Something answered 2xx and it was not Bee's health document. A web server with a single-page
   * fallback route answers `/health` with its index page and a 200, which is exactly the case a
   * status-only check waved through when this was first tried against the viewer's own origin.
   */
  | { kind: 'not-bee' }
  /** No usable answer at all: connection refused, wrong port, timeout, or the node blocked this site. */
  | { kind: 'unreachable' };

export interface GatewayProbeOptions {
  timeoutMs?: number;
  /** Injected only by tests. Production always uses the global. */
  fetcher?: typeof fetch;
}

/**
 * Ask the address whether a Bee node is behind it. Never throws: every failure is an outcome.
 *
 * The wait is bounded over headers and body together, because `fetch` resolves at the headers and a
 * node that accepts the connection and then goes quiet would otherwise hold the picker open forever.
 * Built from `AbortController` and `setTimeout` rather than `AbortSignal.timeout`, which is newer than
 * the engines this bundle's build target promises to support.
 */
export async function probeGateway(
  gatewayUrl: string,
  options: GatewayProbeOptions = {},
): Promise<GatewayProbeOutcome> {
  const { timeoutMs = GATEWAY_PROBE_TIMEOUT_MS, fetcher = fetch } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${gatewayUrl}${GATEWAY_PROBE_PATH}`, { signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      return { kind: 'rejected', status: response.status };
    }
    return looksLikeBeeHealth(body) ? { kind: 'ok' } : { kind: 'not-bee' };
  } catch {
    // A browser reports a CORS refusal, a closed port and a DNS miss identically: a rejected fetch
    // with no status. The message for this case names all of them, since we cannot tell them apart.
    return { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bee's `/health` body is `{"status":"ok","version":...,"apiVersion":...}` and has been since the API
 * was versioned. Only the shape is checked, not the value: a node reporting `nok` is still a Bee node,
 * and a viewer is better served by pointing at it and seeing the catalog fail than by a message that
 * says it is not there.
 */
function looksLikeBeeHealth(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && typeof (parsed as { status?: unknown }).status === 'string';
  } catch {
    return false;
  }
}

/**
 * What the picker tells a viewer for each outcome. Kept beside the rule so a new outcome cannot ship
 * without its copy. Written for someone who runs a node but does not read network logs.
 */
export function describeProbeOutcome(outcome: GatewayProbeOutcome): string {
  switch (outcome.kind) {
    case 'ok':
      return 'Connected. Streams will now load through this node.';
    case 'rejected':
      return `Something answered at this address with an error (HTTP ${outcome.status}). Check the port: the Bee API is usually 1633.`;
    case 'not-bee':
      return 'Something answered at this address, but it is not a Bee node. Check the port: the Bee API is usually 1633.';
    case 'unreachable':
      return 'Could not reach a Bee node at this address. Make sure the node is running, and that it allows this site: set cors-allowed-origins to "*" in its config and restart it.';
  }
}

/**
 * What the header shows beside the picker, so a viewer can see at a glance whose node is serving them
 * without opening anything. The default is named rather than shown as `/bee`, which means nothing to
 * a viewer; a custom node shows as its host, which is what they typed and will recognise.
 */
export function gatewayLabel(gatewayUrl: string, defaultGatewayUrl: string): string {
  if (gatewayUrl === defaultGatewayUrl) {
    return 'Default gateway';
  }
  try {
    return new URL(gatewayUrl).host;
  } catch {
    return gatewayUrl;
  }
}
