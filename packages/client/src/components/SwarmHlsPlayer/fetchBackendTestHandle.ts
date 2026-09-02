import { activeFetchBackend, type FetchBackend, isSwarmReference, selectFetchBackend } from './fetchBackend';
import { weeb3FetchBackend } from './Weeb3FetchBackend';

/**
 * Where a measurement harness finds the byte-source switch.
 *
 * Prefixed and spelled out for the same reason `GATEWAY_HANDLE` is: this is a global on a page that
 * also runs a Swarm node, and a name like `backend` would collide.
 */
export const FETCH_BACKEND_HANDLE = '__swarmFetchBackendSwitch';

/** What one retrieval cost, which is everything about it except the bytes. */
export interface RetrievalMeasurement {
  /** The payload's size once the Swarm span came off, so it is what a gateway would have served. */
  byteLength: number;
  /** Wall time from the call to the answer, on the page's own monotonic clock. */
  elapsedMs: number;
}

export interface FetchBackendSwitch {
  /** Where segment bytes are coming from right now. */
  current: () => FetchBackend;
  /** Point subsequent fragments elsewhere. Throws on a value it does not recognise. */
  select: (backend: FetchBackend | null) => void;
  /**
   * Boot the in-tab node without switching to it, so an arm does not pay the join inside its own
   * measurement.
   *
   * ⛔ weeb-3 costs 4.5 MB of wasm and several seconds of dialling before its first byte. A2 measured
   * that as a 9.4 to 10.5 second first retrieval against 3.2 to 4.0 warm. An arm that switches and
   * immediately starts scoring is measuring the join, and the join happens once per tab.
   */
  prewarm: () => Promise<void>;
  /**
   * One retrieval through the product path, measured, without handing the bytes across the bridge.
   *
   * Every other in-tab reading this project has is taken through hls.js, which chooses its own
   * fragments and its own moments, so the player's decisions are in every number. A harness that names
   * the reference gets one retrieval on its own terms.
   *
   * ⛔ **The bytes stay in the page.** A segment is most of a megabyte, and CDP serialising one into
   * the harness would put the bridge in the duration this exists to report.
   *
   * ⛔ Boots the node if it is not up, so the FIRST call can carry the whole join. {@link prewarm} is
   * what a harness uses to keep that out of a measured one.
   *
   * ⛔ A retrieval the node refused rejects with the node's own error. Answering with zero bytes would
   * put a segment nobody served into an arm's byte count.
   */
  retrieveBytes: (ref: string) => Promise<RetrievalMeasurement>;
}

/**
 * The part of the in-tab node this handle drives.
 *
 * Narrowed to the two calls it makes so a test can supply a backend over a stubbed wasm module and
 * still exercise the product's own retrieval, span stripping included.
 */
type InTabNode = Pick<typeof weeb3FetchBackend, 'prewarm' | 'retrieveBytes'>;

interface FetchBackendHandleHolder {
  [FETCH_BACKEND_HANDLE]?: FetchBackendSwitch;
}

async function measureRetrieval(node: InTabNode, ref: string): Promise<RetrievalMeasurement> {
  if (!isSwarmReference(ref)) {
    throw new Error(`not a Swarm reference, so there is no chunk to ask the node for: ${JSON.stringify(ref)}`);
  }

  const startedAtMs = performance.now();
  const bytes = await node.retrieveBytes(ref);

  return { byteLength: bytes.byteLength, elapsedMs: performance.now() - startedAtMs };
}

/**
 * Publish the byte-source switch for a measurement harness, and hand back the detach.
 *
 * ## Why this exists
 *
 * A2 compared weeb-3 against the gateway by **rebuilding and redeploying the client between arms**,
 * because `VITE_BROWSER_FETCH_BACKEND` is a build-time flag. That puts two differences into one
 * comparison, the backend and the build, and it makes a counterbalanced sitting impractical: an
 * `AB/AB/BA/BA` order inside one broadcast would need eight rebuilds, each of which is also a fresh
 * client and a cold start.
 *
 * ⭐ This is the same seam `gatewayTestHandle` opened for gateways, and the #93 arms were run on it.
 *
 * ⛔⛔ **An arm is seeded, not switched.** By the time this handle exists the app has mounted, and by
 * then the viewer has already resolved the catalog, fetched a manifest and pulled segments through
 * whatever the build defaults to. A harness that wants a whole arm on one backend has to set it
 * before the page scripts run, the way `seedGateway` writes localStorage in an init script, and use
 * this only to move between arms afterwards.
 *
 * ⛔ **Never gate product behaviour on this.** It is an instrumentation seam, so the only correct use
 * is a harness driving a client that would have behaved identically without it.
 *
 * The node is a parameter so a test can hand in a backend over a stubbed wasm module. The app calls
 * this with nothing, which is the one node the tab gets.
 */
export function exposeFetchBackendForInstrumentation(node: InTabNode = weeb3FetchBackend): (() => void) | null {
  // ⛔ Spelled out rather than read through a named constant, and that is not a style choice. Vite only
  // substitutes `import.meta.env.VITE_x` written as a static member access; an index by variable is
  // left as a runtime lookup, the branch survives minification, and the handle ships. That was
  // measured on the player handle, not assumed, and `bundle.test.ts` holds the line for all three.
  if (!import.meta.env.VITE_EXPOSE_PLAYER) {
    return null;
  }

  const holder = globalThis as unknown as FetchBackendHandleHolder;
  const published: FetchBackendSwitch = {
    current: activeFetchBackend,
    select: selectFetchBackend,
    prewarm: () => node.prewarm(),
    retrieveBytes: (ref: string) => measureRetrieval(node, ref),
  };
  holder[FETCH_BACKEND_HANDLE] = published;

  return () => {
    // Compared before deleting, because a remount publishes the new switch before React runs the old
    // one's cleanup, and an unconditional delete would remove the live one and leave a harness holding
    // nothing halfway through an arm.
    if (holder[FETCH_BACKEND_HANDLE] === published) {
      delete holder[FETCH_BACKEND_HANDLE];
    }
  };
}
