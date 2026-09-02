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
 *
 * ## ⛔⛔⛔ A PAGE SESSION HAS NOT REACHED THE NODE SINCE weeb-3 0.0.341001
 *
 * The node now runs entirely inside a SharedWorker, whose sockets belong to the worker target and
 * not to the page. Applied on the page's own session alone, this capped nothing the node does: the
 * arm 3 probe of 2026-09-02 pulled 1.2 MB in 0.3 s under a cap whose physical floor is 3.3 s. So
 * {@link squeezeDownload} takes the worker-target watch as well and the parameter is **required**,
 * because an omitted one would look exactly like the page-only cap that produced that run. See
 * `workerTargets.ts` for the attachment and `capProof.ts` for the refusal that proves it landed.
 */

import type { CDPSession, Page } from 'playwright-core';

import { type LadderRung } from '../config.js';

import { type WorkerTargetWatch } from './workerTargets.js';

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
 * The bandwidth to squeeze a viewer down to, in kbps, derived from THE RUNG THEY ARE ACTUALLY ON.
 *
 * ## The rule
 *
 * The bitrate of the next rung below the one being played. The rung they are on no longer fits, so a
 * player choosing its own quality has to come down, and the rungs further down stay within reach, so
 * the picture keeps moving. Both halves matter: V2 asserts a step down AND continued playback, and a
 * cap that starved everything would fail the second half for the harness's reasons.
 *
 * ⚠️ The next rung itself is NOT left affordable, whatever an earlier version of this said. hls.js
 * takes a rung only under 95% of the bandwidth it measures (`ABR_BANDWIDTH_FACTOR`, shared package),
 * so a cap equal to a rung's bitrate rules that rung out too and the best landing rung is the one
 * below it. Measured 2026-09-02 at a 2800 kbps cap: 360p landed, 480p on the climb, 720p never.
 *
 * ⛔⛔ **Null where they are already on the bottom rung, and that is not a failure of the product.**
 * Live on 2026-08-30 the gateway profile put its viewer on 360p before anything was capped, which
 * matches what this project already knew: an in-tab viewer rides 1080p and a gateway viewer rides
 * 360p on the SAME broadcast. A cap derived from the ladder in the abstract left 360p affordable, the
 * player correctly stayed, and V2 reported "a ladder nobody descends". The question cannot be put to
 * a viewer with nowhere to go, and the honest answer is to say so rather than to fail them.
 *
 * ⚠️ The first version of this took the second lowest rung's bitrate regardless of what was playing.
 * That is right only when the viewer starts at the top, which is the in-tab profile and not the other.
 */
export function throttleKbpsBelow(ladder: readonly LadderRung[], ridingHeight: number): number | null {
  const riding = ladder.find((rung) => rung.height === ridingHeight);
  if (riding === undefined) {
    throw new Error(
      `the player is riding a ${ridingHeight}p rung and this ladder declares ` +
        `${ladder.map((rung) => `${rung.name}@${rung.height}`).join(' ')}. A cap derived by guessing which ` +
        'rung that is would be a cap nobody chose.',
    );
  }
  const below = ladder.filter((rung) => rung.kbps < riding.kbps);
  return below.length === 0 ? null : Math.max(...below.map((rung) => rung.kbps));
}

/**
 * Why this viewer cannot be asked the quality-switch question, or null.
 *
 * ⛔ Its own predicate so the driver can refuse before it spends the squeeze window, and so the
 * reason reaching a suite is a sentence rather than a null bandwidth.
 */
export function nowhereToStepRefusal(ladder: readonly LadderRung[], ridingHeight: number): string | null {
  if (ladder.length < MIN_RUNGS_FOR_A_STEP_DOWN) {
    return (
      `a quality switch needs at least ${MIN_RUNGS_FOR_A_STEP_DOWN} rungs to step between and this ` +
      `deployment declares ${ladder.length}. A player with nowhere to go that stays where it is has ` +
      'behaved correctly, so there is no question here to answer'
    );
  }
  if (throttleKbpsBelow(ladder, ridingHeight) === null) {
    return (
      `this viewer settled on ${ridingHeight}p, which is the bottom of the ladder, so there is no rung ` +
      'for them to step down to and no bandwidth that would make one appear. A gateway viewer rides the ' +
      'bottom rung on the same broadcast an in-tab viewer rides the top of, so this is a property of the ' +
      'byte source rather than of the client'
    );
  }
  return null;
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
 * Cap what the tab can download, page and worker targets alike, and hand back the way to lift it.
 *
 * The upload direction is left alone: a viewer sends nothing, and capping it would only add a way for
 * the run to differ from what it says it did.
 *
 * @param workers The worker-target watch, or null for a page with no in-tab node in it at all.
 *   ⛔⛔ **Required and never defaulted.** The node lives in a SharedWorker, so a cap that reaches
 *   only the page reaches nothing it does, and an optional parameter that a driver forgot would be
 *   indistinguishable from the page-only cap that voided the arm 3 probe of 2026-09-02. Passing null
 *   is a statement, not a shortcut, and the cap proof in `capProof.ts` is what tests either way.
 */
export async function squeezeDownload(
  page: Page,
  kbps: number,
  workers: WorkerTargetWatch | null,
): Promise<ThrottleHandle> {
  const bytesPerSecond = kbpsAsBytesPerSecond(kbps);
  const session: CDPSession = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: THROTTLE_LATENCY_MS,
    downloadThroughput: bytesPerSecond,
    uploadThroughput: UNTHROTTLED,
  });
  // After the page, so a worker attached while the page cap was being applied still gets it: the
  // watch holds the active cap and applies it to every session that attaches from here on.
  await workers?.squeeze(bytesPerSecond);

  return {
    kbps,
    release: async (): Promise<void> => {
      await workers?.release();
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
