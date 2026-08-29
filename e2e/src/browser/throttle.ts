/**
 * Squeezing the tab's bandwidth, which is how a viewer's connection getting worse is reproduced.
 *
 * ## What this is for
 *
 * The whole point of an adaptive ladder is that a viewer whose connection degrades keeps watching at
 * a lower quality rather than stopping. Nothing in this project had ever asked whether that happens.
 * The ABR tests read the uploader's log, which can only say the rungs were published, and the viewer
 * suites watched a player on an unconstrained link, which never has a reason to step down.
 *
 * ## ⛔ Why the bandwidth comes from the ladder rather than from a constant
 *
 * A number picked here would be right for one deployment. The ladder declares what each rung was cut
 * at, so the bandwidth that makes the upper rungs undeliverable is arithmetic on the deployment's own
 * configuration, and a stack that reconfigures its ladder gets a throttle that still means the same
 * thing.
 *
 * ## ⛔ What a throttle cannot be trusted to have done
 *
 * Chromium's network emulation is applied by the browser, and whether it reaches a given transport is
 * the browser's business rather than something this can assert from the outside. An in-tab node
 * carries segment bytes over its own peer connections, so a run must PROVE the player's own bandwidth
 * estimate moved before any conclusion is drawn from what the player did next. See
 * `harness/qualityArm.ts`, where that is the first refusal and comes before every other reading.
 */

import type { CDPSession, Page } from 'playwright-core';

import { type LadderRung } from '../config.js';

/** Bits per byte, for turning a declared kbps into the bytes per second CDP wants. */
const BITS_PER_BYTE = 8;
const BITS_PER_KBIT = 1_000;

/**
 * The latency CDP adds on top of the throughput cap.
 *
 * Zero on purpose. A round trip penalty would degrade the link in a second dimension, and a player
 * that stepped down could then have done so because of either. One variable.
 */
const THROTTLE_LATENCY_MS = 0;

/** What CDP takes to mean "do not cap this direction", which is what the release restores. */
const UNTHROTTLED = -1;

/**
 * The fewest rungs a ladder needs before a step down is a question that can be asked.
 *
 * ⛔ Two, and it is not pedantry. A single-rendition stack has nowhere to step, so a player that
 * stays where it is has behaved perfectly, and a suite run against one would either fail a correct
 * player or pass by asserting nothing.
 */
export const MIN_RUNGS_FOR_A_STEP_DOWN = 2;

/**
 * The bandwidth to squeeze a viewer down to, in kbps, derived from the ladder they are being served.
 *
 * ## The rule
 *
 * The second lowest rung's own bitrate. Every rung above it then asks for more than the link can
 * carry, so a player choosing its own quality has to come down, and the bottom of the ladder stays
 * comfortably deliverable so the picture keeps moving rather than stopping. Both halves matter: V2
 * asserts a step down AND continued playback, and a throttle that starved the lowest rung too would
 * make the second half fail for the harness's reasons.
 *
 * ⚠️ On a two rung ladder this is the top rung's bitrate, which leaves only the bottom one
 * affordable. That is still exactly one step down and still the intended shape.
 */
export function throttleKbpsFor(ladder: readonly LadderRung[]): number {
  if (ladder.length < MIN_RUNGS_FOR_A_STEP_DOWN) {
    throw new Error(
      `a quality switch needs at least ${MIN_RUNGS_FOR_A_STEP_DOWN} rungs to step between and this ` +
        `deployment declares ${ladder.length}. A player with nowhere to go that stays where it is has ` +
        'behaved correctly, so there is no question here to answer.',
    );
  }
  const ascending = [...ladder].sort((a, b) => a.kbps - b.kbps);
  return ascending[1].kbps;
}

/** The rung a player should be able to hold at a given bandwidth, which is the tallest it can afford. */
export function tallestAffordableRung(ladder: readonly LadderRung[], kbps: number): LadderRung | null {
  const affordable = ladder.filter((rung) => rung.kbps <= kbps);
  return affordable.length === 0
    ? null
    : affordable.reduce((tallest, rung) => (rung.height > tallest.height ? rung : tallest));
}

/** Kilobits per second as the bytes per second `Network.emulateNetworkConditions` is specified in. */
export function kbpsAsBytesPerSecond(kbps: number): number {
  return Math.round((kbps * BITS_PER_KBIT) / BITS_PER_BYTE);
}

/**
 * A handle on a squeezed connection, which knows how to let it go again.
 *
 * ⛔ The release is on the handle rather than a free function, so it cannot be called against a
 * session the caller never throttled. A run that released a link it had not squeezed would report a
 * clean recovery from nothing.
 */
export interface ThrottleHandle {
  kbps: number;
  release: () => Promise<void>;
}

/**
 * Cap what the tab can download, and hand back the way to lift it.
 *
 * The upload direction is left alone: a viewer sends nothing, and capping it would only add a way for
 * the run to differ from what it says it did.
 */
export async function squeezeDownload(page: Page, kbps: number): Promise<ThrottleHandle> {
  const session: CDPSession = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: THROTTLE_LATENCY_MS,
    downloadThroughput: kbpsAsBytesPerSecond(kbps),
    uploadThroughput: UNTHROTTLED,
  });

  return {
    kbps,
    release: async (): Promise<void> => {
      await session.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: THROTTLE_LATENCY_MS,
        downloadThroughput: UNTHROTTLED,
        uploadThroughput: UNTHROTTLED,
      });
      await session.detach().catch(() => undefined);
    },
  };
}
