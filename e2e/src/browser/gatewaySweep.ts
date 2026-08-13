import { type BrowserContext, type Page } from 'playwright-core';

/**
 * Where the client publishes its gateway switch when built with `VITE_EXPOSE_PLAYER`.
 *
 * Mirrored rather than imported: `e2e` does not depend on `client`, and this is the string the
 * browser sees rather than a value either side computes. `packages/client/test/bundle.test.ts` holds
 * the other end and proves it ships in no production build.
 */
const GATEWAY_HANDLE = '__swarmGatewaySwitch';

/**
 * Where the client persists the gateway a viewer chose, read back on the next load.
 *
 * Mirrored for the same reason as the handle above, and `packages/client/test/appGateway.test.ts`
 * holds the other end. Seeding it is how an arm gets its gateway in place **before** any application
 * code runs, which the runtime switch cannot do.
 */
const GATEWAY_STORAGE_KEY = 'swarm-gateway-url';

/** The two conditions, named once so no caller spells either of them itself. */
export const FUNDED_ARM = 'funded';
export const UNFUNDED_ARM = 'unfunded';
export type GatewayArm = typeof FUNDED_ARM | typeof UNFUNDED_ARM;

export interface GatewaySetup {
  /** What the client reports as its gateway once set, which is **not** assumed to be what was asked. */
  gatewayUrl: string | null;
  failure: string | null;
}

/**
 * Ask the running client which gateway it is using, and optionally move it first.
 *
 * ## Why the readback is the whole point
 *
 * ⛔⛔⛔ A switch that silently fails is the worst outcome this sweep has. Both arms then measure the
 * same node, every metric agrees, and the sitting reports **"funding makes no difference to a
 * viewer"** — a wrong finding, and a very believable one, since it is exactly what an optimist
 * expects. There is no signal in the viewer report that would give it away.
 *
 * So the arm is not "we asked for this gateway". The arm is "the client says it is reading through
 * this host", and an arm whose readback disagrees with its request is excluded rather than counted.
 *
 * @param target The gateway to move to, or null to read without disturbing the running player.
 */
async function askTheClient(page: Page, target: string | null): Promise<GatewaySetup> {
  return page.evaluate(
    ({ handle, moveTo }: { handle: string; moveTo: string | null }) => {
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

      if (moveTo !== null) {
        gatewaySwitch.select(moveTo);
      }
      return { gatewayUrl: gatewaySwitch.current(), failure: null };
    },
    { handle: GATEWAY_HANDLE, moveTo: target },
  );
}

/**
 * Point the running viewer at another gateway, and read back what it actually did.
 *
 * `setGatewayUrl` normalises by stripping trailing slashes, so the comparison is against the
 * normalised form rather than the raw string.
 */
export async function selectGateway(page: Page, url: string): Promise<GatewaySetup> {
  return askTheClient(page, url);
}

/**
 * Which gateway the client is already using, without moving it.
 *
 * ⛔ Reading rather than selecting matters for an arm that was {@link seedGateway}ed: calling the
 * setter resets the catalog reader and marks every manifest dirty, which is right for a mid-stream
 * switch and is a disturbance an arm that arrived on the correct node should not pay.
 */
export async function readGateway(page: Page): Promise<GatewaySetup> {
  return askTheClient(page, null);
}

/**
 * Put an arm on its gateway before the client has run a single line, by seeding what it loads from.
 *
 * ## Why an arm is seeded rather than switched
 *
 * ⛔⛔ The runtime switch cannot exist until the app has mounted, and by then the viewer has already
 * resolved the catalog feed, fetched a manifest and started pulling segments **through whichever
 * gateway the build defaults to** — which is the funded one. An unfunded arm that switched after
 * playback started would have bought its whole join from the funded node and then measured the rest,
 * and joining is the expensive part. The contrast would be diluted by exactly the phase where the
 * difference is expected to be largest.
 *
 * An init script runs before page scripts on every navigation, so `loadGatewayUrl()` picks this up in
 * the client's very first render and the arm is the arm from its first request.
 *
 * ⭐ Seeding is not trusted either. {@link readGateway} still reads back what the client says, so a
 * key that drifts here fails the arm rather than quietly returning it to the default.
 */
export async function seedGateway(context: BrowserContext, url: string): Promise<void> {
  await context.addInitScript(
    ({ key, value }: { key: string; value: string }) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        // No localStorage in this context. The readback is what turns that into a failed arm.
      }
    },
    { key: GATEWAY_STORAGE_KEY, value: normalizeGatewayUrl(url) },
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

/** Only the url is read, so any request record a run collected can be handed straight in. */
export interface FetchedUrl {
  url: string;
}

/** How many times each host that is neither the arm gateway nor the page origin was fetched from. */
export function foreignHosts(
  requests: readonly FetchedUrl[],
  gatewayUrl: string,
  clientUrl: string,
): { host: string; count: number }[] {
  const hostOf = (url: string): string => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  };
  const ours = new Set([hostOf(normalizeGatewayUrl(gatewayUrl)), hostOf(clientUrl), '']);

  const counts = new Map<string, number>();
  for (const request of requests) {
    const host = hostOf(request.url);
    if (!ours.has(host)) {
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
  }
  return [...counts].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count);
}

/**
 * Why this arm cannot be read against the others, judged on where its bytes CAME FROM, or null.
 *
 * ## ⛔⛔⛔ Why this exists as well as the readback
 *
 * {@link gatewayArmIsComparable} asks the client which gateway it is using, and on 2026-08-13 both
 * arms of a paid smoke answered honestly and correctly while **fetching every one of their 253 video
 * segments from the same node**. The feed and SOC lookups followed the viewer's gateway; the segments
 * came from a cached playlist built against the previous one. Both arms were one condition, every
 * metric agreed, and nothing in the viewer-facing output would have given it away.
 *
 * ⭐⭐⭐ **A readback proves what the app BELIEVES. The request log is what the network DID.** The log
 * was already being recorded and nothing was reading it.
 *
 * Zero tolerance, deliberately. After the manifest cache fix there is no legitimate reason for an arm
 * to fetch from any host but its own gateway and the page it was served from, so a threshold here
 * would only be a number for somebody in a hurry to raise. A refusal names the hosts and the counts.
 */
export function armWasServedByItsGateway(
  requests: readonly FetchedUrl[],
  gatewayUrl: string,
  clientUrl: string,
): string | null {
  const strangers = foreignHosts(requests, gatewayUrl, clientUrl);
  if (strangers.length === 0) {
    return null;
  }
  const named = strangers.map(({ host, count }) => `${count} from ${host}`).join(', ');
  return (
    `this arm asked for ${normalizeGatewayUrl(gatewayUrl)} and fetched ${named}, so its bytes did ` +
    `not all come from the gateway it claims`
  );
}

/**
 * The arms of a funded-versus-unfunded sitting, in the order they run.
 *
 * ⛔ The shell driver runs the arms and does not compute this. A second implementation of an ordering
 * rule is how the burn rate came to hold four different values in three scripts, and this rule is
 * one I have already got wrong once from a slogan rather than from its arithmetic. `browser:arm-order`
 * prints what this returns, and the driver reads it.
 */
export function gatewayArmOrder(rounds: number): GatewayArm[] {
  return counterbalancedOrder([FUNDED_ARM, UNFUNDED_ARM] as const, rounds);
}
