import { activeFetchBackend, type FetchBackend, selectFetchBackend } from './fetchBackend';
import { weeb3FetchBackend } from './Weeb3FetchBackend';

/**
 * Where a measurement harness finds the byte-source switch.
 *
 * Prefixed and spelled out for the same reason `GATEWAY_HANDLE` is: this is a global on a page that
 * also runs a Swarm node, and a name like `backend` would collide.
 */
export const FETCH_BACKEND_HANDLE = '__swarmFetchBackendSwitch';

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
}

interface FetchBackendHandleHolder {
  [FETCH_BACKEND_HANDLE]?: FetchBackendSwitch;
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
 */
export function exposeFetchBackendForInstrumentation(): (() => void) | null {
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
    prewarm: () => weeb3FetchBackend.prewarm(),
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
