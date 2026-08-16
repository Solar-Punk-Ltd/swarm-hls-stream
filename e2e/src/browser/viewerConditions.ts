import { counterbalancedOrder } from './gatewaySweep.js';

/**
 * Our own client, reading segment bytes from a Swarm node in the tab and its feed, catalog and
 * manifest from a bee gateway.
 *
 * ⛔⛔ **Every in-tab figure this project published before 2026-08-16 is this viewer**, and the
 * split was never authorised. See `docs/bench/abel-gateway-less-live-2026-08-16.md`. The name
 * matches `BROWSER_FETCH_BACKEND=weeb3` so an arm keeps the label the existing corpus files it under.
 */
export const HYBRID_VIEWER = 'weeb3';

/** weeb-3's own published page, which asks a gateway for nothing at all. */
export const NATIVE_VIEWER = 'native';

export type ViewerCondition = typeof HYBRID_VIEWER | typeof NATIVE_VIEWER;

/**
 * The arms of a gateway-less-versus-hybrid sitting, in the order they run.
 *
 * ⛔ The ordering rule lives in `counterbalancedOrder` and is not re-derived here, for the reason
 * `byteSourceArmOrder` says: one constant once held four different values in three scripts.
 *
 * ⚠️ **This contrast moves two things at once**, whose page and player, and whether a gateway serves
 * the manifest. It bounds what going fully gateway-less costs rather than isolating the manifest
 * source, and a write-up built on it has to say so.
 */
export function gatewayLessArmOrder(rounds: number): ViewerCondition[] {
  return counterbalancedOrder([NATIVE_VIEWER, HYBRID_VIEWER] as const, rounds);
}

/**
 * ⛔ Throws rather than falling back. A typo that quietly became the hybrid would run both halves of
 * a paid sitting on one condition and file half of it under the other name, which is the failure
 * this whole line of work exists because of.
 */
export function viewerConditionFromEnv(value: string | undefined): ViewerCondition {
  if (value !== HYBRID_VIEWER && value !== NATIVE_VIEWER) {
    throw new Error(
      `${JSON.stringify(value)} is not a viewer condition, expected ${NATIVE_VIEWER} or ${HYBRID_VIEWER}`,
    );
  }
  return value;
}
