/**
 * Where a measurement harness finds the gateway switch.
 *
 * Prefixed and spelled out rather than short, for the same reason {@link PLAYER_HANDLE} is: this is a
 * global on a page that also runs a Swarm node, and a name like `gateway` would collide.
 */
export const GATEWAY_HANDLE = '__swarmGatewaySwitch';

export interface GatewaySwitch {
  /** The gateway every fetch is going through right now. */
  current: () => string;
  /** Point every subsequent fetch at another gateway, without remounting anything. */
  select: (url: string) => void;
}

interface GatewayHandleHolder {
  [GATEWAY_HANDLE]?: GatewaySwitch;
}

/**
 * Publish the gateway switch for a measurement harness, and hand back the detach.
 *
 * ## Why this exists
 *
 * Every viewer-side figure this project holds was measured through a **chequebook-funded** light
 * gateway. That is the best case and not the shipping case: a real viewer runs ultra-light, or a
 * light node nobody funded. The one prior attempt to measure the difference read both arms through
 * the bench's `/feeds/` head lookup, which is 50-57% frozen on its own and which a viewer never
 * calls, so it does not survive.
 *
 * ⭐ The redesign that makes the answer trustworthy needs **two warm gateways alternating under one
 * broadcast**, rather than two soaks scored against each other. Two soaks is exactly the
 * between-sitting confound the interleaved GOP arms just caught: one configuration measured at a
 * different hour from the other, with every other difference between those hours inside the result.
 *
 * `setGatewayUrl` is already a real runtime switch. It repoints the fetcher, resets the catalog
 * reader's remembered position and marks every manifest dirty, so the next fetch genuinely goes
 * somewhere else. What was missing is a way to reach it: the only caller is a UI control, and driving
 * a text field through CDP mid-arm is a worse instrument than calling the function.
 *
 * ⛔ **Never gate product behaviour on this.** It is an instrumentation seam, so the only correct use
 * is a harness driving a client that would have behaved identically without it.
 */
export function exposeGatewayForInstrumentation(gatewaySwitch: GatewaySwitch): (() => void) | null {
  // ⛔ Spelled out rather than read through a named constant, and that is not a style choice. Vite
  // only substitutes `import.meta.env.VITE_x` written as a static member access; an index by variable
  // is left as a runtime lookup, the branch survives minification, and the handle ships. That was
  // measured on the player handle, not assumed, and `bundle.test.ts` holds the line for both.
  if (!import.meta.env.VITE_EXPOSE_PLAYER) {
    return null;
  }

  const holder = globalThis as unknown as GatewayHandleHolder;
  holder[GATEWAY_HANDLE] = gatewaySwitch;

  return () => {
    // Compared before deleting, because a remount publishes the new switch before React runs the old
    // one's cleanup, and an unconditional delete would remove the live one and leave a harness holding
    // nothing halfway through an arm.
    if (holder[GATEWAY_HANDLE] === gatewaySwitch) {
      delete holder[GATEWAY_HANDLE];
    }
  };
}
