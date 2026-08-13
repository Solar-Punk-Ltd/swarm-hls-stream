/** Segment bytes come from the viewer's chosen bee gateway over HTTP. The shipping path. */
export const FETCH_BACKEND_GATEWAY = 'gateway';

/** Segment bytes come from a Swarm node running inside this tab. Experimental, see phase A2. */
export const FETCH_BACKEND_WEEB3 = 'weeb3';

export type FetchBackend = typeof FETCH_BACKEND_GATEWAY | typeof FETCH_BACKEND_WEEB3;

/**
 * Which source this build fetches segment bytes from.
 *
 * ## What the weeb-3 setting does and does not move
 *
 * Only the **segment bytes**. The catalog, the feed and every manifest still travel through the
 * viewer's gateway, because phase A exists to answer one question: what a viewer gets when the media
 * comes from a node in their own tab and nothing else about the player changes. Moving the manifest
 * as well would put two changes in one arm.
 *
 * ⛔ This is why the backend is not `attachStream`. weeb-3 ships a complete HLS path of its own, and
 * using it would measure weeb-3's player rather than ours, which is the mistake that made #44's
 * headline unusable.
 */
export function selectedFetchBackend(): FetchBackend {
  // ⛔ Spelled out rather than read through a named constant, for the reason `gatewayTestHandle.ts`
  // records: Vite only substitutes `import.meta.env.VITE_x` written as a static member access, and an
  // index by variable is left as a runtime lookup against an object the build never defines.
  return import.meta.env.VITE_BROWSER_FETCH_BACKEND === FETCH_BACKEND_WEEB3
    ? FETCH_BACKEND_WEEB3
    : FETCH_BACKEND_GATEWAY;
}

const BYTES_ROUTE = '/bytes/';

/**
 * A Swarm reference is 32 bytes, or 64 when the upload was encrypted, and nothing else is one.
 *
 * Checked here rather than left to the node because the reference goes straight into a wasm call,
 * where a malformed one fails without naming itself or the url it came from.
 */
const SWARM_REFERENCE = /^(?:[0-9a-f]{64}|[0-9a-f]{128})$/i;

/**
 * The bare Swarm reference a fragment url carries, or `null` if it carries none.
 *
 * Every segment line the uploader publishes has been a bare reference since 2026-08-13, and this
 * client's own `buildUri` puts the viewer's gateway in front of it. So a fragment always arrives as
 * `<gateway>/bytes/<ref>` and the host half is exactly the part an in-tab node makes irrelevant.
 */
export function segmentRefFromUrl(url: string): string | null {
  const path = url.split(/[?#]/, 1)[0];
  const route = path.lastIndexOf(BYTES_ROUTE);
  if (route < 0) {
    return null;
  }

  const ref = path.slice(route + BYTES_ROUTE.length);
  return SWARM_REFERENCE.test(ref) ? ref : null;
}
