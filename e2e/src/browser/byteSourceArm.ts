import { type Page } from 'playwright-core';

import {
  armBytesCameFromItsSource,
  type ByteSource,
  type ByteSourceArm,
  openByteSourceArm,
  type TimedRequest,
} from './fetchBackendSweep.js';

/**
 * Opening a byte-source arm and proving it was the arm it claims, as one thing that cannot be half done.
 *
 * ⛔⛔⛔ The two halves were written inline in `watch.ts`, about 150 lines apart, and nowhere else.
 * `crash.ts` and `buffer-sweep.ts` therefore ran on the gateway whatever `BROWSER_FETCH_BACKEND`
 * said, silently, because an unread variable looks exactly like a variable set to its default. That
 * is the whole reason this file exists rather than a second copy of the pair.
 *
 * ⛔⛔ Keeping them together is the point, not the tidiness. A weeb-3 arm's headline is a **zero**
 * gateway reads, and a client that never loaded the node at all produces the same zero. The proof is
 * what separates them, so it travels with the arm: a driver cannot hold one without holding the other.
 * `armBytesCameFromItsSource` requires the wasm as a witness for the same reason.
 *
 * The env read stays with the caller. Drivers read `BROWSER_FETCH_BACKEND` before launching a browser
 * so a typo costs nothing, which a lazy read inside here would undo.
 */
export interface ByteSourceArmSession {
  /** The arm that opened, or `undefined` when the run is on whatever the build defaults to. */
  readonly arm: ByteSourceArm | undefined;
  /**
   * ⛔ Run before the reading is filed, and let it throw.
   *
   * Judges only from the instant the window opened, because an arm legitimately reads through the
   * gateway while its node boots. A no-op when no arm was requested, so a caller needs no branch.
   */
  proveBytesCameFromIt(requests: readonly TimedRequest[]): void;
}

/**
 * How long the in-tab node gets to boot and settle before a measurement window opens.
 *
 * Generous on purpose. A2 measured the in-tab node's join at 9.4-10.5s and the client gives up on it
 * at 30s, so a boot that fits at all fits inside this with room to spare, and the refusal in
 * `openByteSourceArm` then only fires on an arm that was never going to be comparable.
 *
 * ⛔⛔ Its own variable, `BROWSER_BYTE_SOURCE_SETTLE_SECONDS`, deliberately not `BROWSER_SETTLE_SECONDS`.
 * That one already means two different things: `watch.ts` reads it as this settle and defaults it to
 * 60, while `crash.ts` reads it as the pre-fault baseline and defaults it to 45. Folding a third
 * meaning into it would make one number in one recipe move two unrelated windows. The constant lives
 * here so the three drivers cannot drift to three values, which is the failure `byteSourceArmOrder`
 * records having already happened once.
 *
 * `watch.ts` keeps reading `BROWSER_SETTLE_SECONDS` for this, because that is the knob every recipe in
 * the existing corpus was run with and renaming it would break reproducing them.
 */
export const DEFAULT_BYTE_SOURCE_SETTLE_SECONDS = 60;

/** Nothing was requested, so there is no condition to be wrong about. */
const UNSWITCHED: ByteSourceArmSession = {
  arm: undefined,
  proveBytesCameFromIt: () => undefined,
};

export async function openByteSourceArmSession({
  page,
  source,
  playbackStartedAtMs,
  settleMs,
}: {
  page: Page;
  /** `null` leaves the build's own default in place, which is what an unset variable means. */
  source: ByteSource | null;
  playbackStartedAtMs: number;
  settleMs: number;
}): Promise<ByteSourceArmSession> {
  if (source === null) {
    return UNSWITCHED;
  }

  const arm = await openByteSourceArm({ page, source, playbackStartedAtMs, settleMs });
  console.log(
    `browser: bytes come from ${arm.reported}, window opens ` +
      `${(arm.settledForMs / 1000).toFixed(1)}s after playback started`,
  );

  return {
    arm,
    proveBytesCameFromIt(requests) {
      const notFromIt = armBytesCameFromItsSource(requests, arm.requested, arm.windowStartedAtMs);
      if (notFromIt !== null) {
        throw new Error(`the ${arm.requested} arm is not the condition it claims: ${notFromIt}`);
      }
      console.log(`browser: the ${arm.requested} arm's segment bytes came from where it says they did`);
    },
  };
}
