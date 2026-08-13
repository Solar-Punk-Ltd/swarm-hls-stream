import { type Page } from 'playwright-core';

/**
 * Where the client publishes its gateway switch when built with `VITE_EXPOSE_PLAYER`.
 *
 * Mirrored rather than imported: `e2e` does not depend on `client`, and this is the string the
 * browser sees rather than a value either side computes. `packages/client/test/bundle.test.ts` holds
 * the other end and proves it ships in no production build.
 */
const GATEWAY_HANDLE = '__swarmGatewaySwitch';

export interface GatewaySetup {
  /** What the client reports as its gateway once set, which is **not** assumed to be what was asked. */
  gatewayUrl: string | null;
  failure: string | null;
}

/**
 * Point the running viewer at another gateway, and read back what it actually did.
 *
 * ## Why the readback is the whole point
 *
 * ⛔⛔⛔ A switch that silently fails is the worst outcome this sweep has. Both arms then measure the
 * same node, every metric agrees, and the sitting reports **"funding makes no difference to a
 * viewer"** — a wrong finding, and a very believable one, since it is exactly what an optimist
 * expects. There is no signal in the viewer report that would give it away.
 *
 * So the arm is not "we called the setter". The arm is "the client says it is now reading through
 * this host", and an arm whose readback disagrees with its request is excluded rather than counted.
 *
 * `setGatewayUrl` normalises by stripping trailing slashes, so the comparison is against the
 * normalised form rather than the raw string.
 */
export async function selectGateway(page: Page, url: string): Promise<GatewaySetup> {
  return page.evaluate(
    ({ handle, target }: { handle: string; target: string }) => {
      const gatewaySwitch = (globalThis as unknown as Record<string, unknown>)[handle] as
        | { current: () => string; select: (url: string) => void }
        | undefined;

      if (!gatewaySwitch) {
        return {
          gatewayUrl: null,
          failure:
            `no gateway switch at globalThis.${handle}. The client must be built with ` +
            `VITE_EXPOSE_PLAYER for a sweep to move it between gateways.`,
        };
      }

      gatewaySwitch.select(target);
      return { gatewayUrl: gatewaySwitch.current(), failure: null };
    },
    { handle: GATEWAY_HANDLE, target: url },
  );
}

/** The trailing-slash normalisation `setGatewayUrl` applies, so a readback can be compared to a request. */
export function normalizeGatewayUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Why this arm cannot be read against the others, or null when it can.
 *
 * ⛔ An arm that did not land on the gateway it asked for is not a weaker arm, it is an arm of the
 * wrong condition. Counting it would put the funded node's numbers in the unfunded column.
 */
export function gatewayArmIsComparable(setup: GatewaySetup, requested: string): string | null {
  if (setup.failure !== null) {
    return setup.failure;
  }
  if (setup.gatewayUrl === null) {
    return 'the client reported no gateway at all after the switch';
  }
  const landed = normalizeGatewayUrl(setup.gatewayUrl);
  const asked = normalizeGatewayUrl(requested);
  if (landed !== asked) {
    return `asked for ${asked} and the client reports ${landed}, so this arm is the wrong condition`;
  }
  return null;
}

/**
 * The order the arms run in: position-balanced, with as few seams as that allows.
 *
 * A **seam** is two arms of the same condition back to back, which happens at a round boundary when
 * one round ends on the letter the next begins with. In the interleaved GOP sitting of 2026-08-12 a
 * host load spike to 47 landed exactly on such a seam. It did not move the headline that time, but it
 * did move push-sync, and nothing in the design had made that a coincidence.
 *
 * ⛔⛔ **A seam-free order is not available, and a note in this project claimed otherwise.** Zero
 * seams means every round runs in the same direction, `ABABAB`, which puts one condition first in
 * every single round. Any drift within a round then lands on it systematically and reads as the
 * condition. That is the confound counterbalancing exists to remove, and it is the worse of the two.
 *
 * ⭐ So the choice is which balanced order has fewest seams, over four rounds:
 *
 * | order | seams | positions balanced |
 * | --- | ---: | --- |
 * | `ABABABAB`, no counterbalance | 0 | **no** |
 * | `AB/BA/AB/BA`, the naive counterbalance | 3 | yes |
 * | `AB/BA/BA/AB` | 2 | yes |
 * | **`AB/AB/BA/BA`, used here** | **1** | yes |
 *
 * All three balanced orders give each condition the same number of arms, the same number of first
 * positions, and the same sum of positions. This one simply pays the seam once instead of two or
 * three times.
 */
export function counterbalancedOrder<T>(conditions: readonly [T, T], rounds: number): T[] {
  const [a, b] = conditions;
  const order: T[] = [];
  for (let round = 0; round < rounds; round += 1) {
    // Two rounds forward then two reversed, repeating every four.
    const forward = round % 4 < 2;
    order.push(...(forward ? [a, b] : [b, a]));
  }
  return order;
}
