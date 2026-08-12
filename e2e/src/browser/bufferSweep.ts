import { type Page } from 'playwright-core';

/**
 * Where the player publishes itself when built with `VITE_EXPOSE_PLAYER`.
 *
 * Mirrored rather than imported: `e2e` does not depend on `client`, and this is the string the
 * browser sees rather than a value either side computes. `packages/client/test/bundle.test.ts` holds
 * the other end.
 */
const PLAYER_HANDLE = '__swarmHlsPlayer';

/**
 * The ratio `LIVE_MAX_LATENCY_DURATION_S` keeps to the target it follows.
 *
 * ⛔ Applied on every arm rather than left alone. hls.js validates `liveMaxLatencyDuration >
 * liveSyncDuration` **at construction only**, so cutting the target at runtime does not throw, it
 * silently widens the ratio. `playerConfig.ts` records what that costs: above 2x the catch-up range
 * and the seek range stop meeting, and a viewer sat between 22 and 30 seconds behind with neither
 * running.
 */
const MAX_LATENCY_RATIO = 2;

export interface ArmSetup {
  /** What the player reports as its own target once set, which is not assumed to be `targetS`. */
  targetLatencyS: number | null;
  maxLatencyS: number | null;
  /** `#EXT-X-TARGETDURATION` as the player parsed it. Caps the stall penalty, and it ratchets. */
  targetDurationS: number | null;
  stallCountAtStart: number | null;
  failure: string | null;
}

/**
 * Point the player at a new buffer target, and read back what it actually took.
 *
 * ⭐ Uses `hls.targetLatency = x` rather than writing `config.liveSyncDuration` directly, because the
 * setter also does `stallCount = 0`. The stall penalty rides on the player instance, so without that
 * reset a stall in one arm follows the viewer into the next and every later arm reads high.
 *
 * ⛔ Reads the values back instead of trusting the write. The getter composes the target from config,
 * the playlist and the stall count, so what a viewer is actually held at is not the number handed in,
 * and an arm that failed to take is a silently useless arm.
 */
export async function setArm(page: Page, targetS: number): Promise<ArmSetup> {
  return page.evaluate(
    ({ handle, target, ratio }: { handle: string; target: number; ratio: number }) => {
      const player = (globalThis as unknown as Record<string, unknown>)[handle] as
        | {
            targetLatency: number | null;
            config: { liveSyncDuration?: number; liveMaxLatencyDuration?: number };
            latencyController?: { stallCount?: number };
            levels?: { details?: { targetduration?: number } }[];
            currentLevel?: number;
          }
        | undefined;

      if (!player) {
        return {
          targetLatencyS: null,
          maxLatencyS: null,
          targetDurationS: null,
          stallCountAtStart: null,
          failure:
            `no player at globalThis.${handle}. The client must be built with VITE_EXPOSE_PLAYER ` +
            'set, and the page must have mounted a player before an arm is set.',
        };
      }

      player.config.liveMaxLatencyDuration = target * ratio;
      // Last, because the setter is what clears the stall penalty and the line above must not land
      // between that reset and the start of the arm.
      player.targetLatency = target;

      const level = player.levels?.[player.currentLevel ?? 0];
      return {
        targetLatencyS: player.targetLatency,
        maxLatencyS: player.config.liveMaxLatencyDuration ?? null,
        targetDurationS: level?.details?.targetduration ?? null,
        stallCountAtStart: player.latencyController?.stallCount ?? null,
        failure: null,
      };
    },
    { handle: PLAYER_HANDLE, target: targetS, ratio: MAX_LATENCY_RATIO },
  );
}

/**
 * Whether an arm is worth counting, decided before its numbers are read.
 *
 * ⛔ The stall penalty is capped at `#EXT-X-TARGETDURATION`, and `ManifestManager` keeps that as a
 * running maximum of `ceil()` that never falls. So one force-closed segment raises the ceiling for
 * the rest of the broadcast, and an arm measured before that happened is not comparable with one
 * measured after. Recorded per arm rather than assumed constant across the sitting.
 */
export function armIsComparable(arm: ArmSetup, firstTargetDurationS: number | null): string | null {
  if (arm.failure) {
    return arm.failure;
  }
  if (arm.targetLatencyS === null) {
    return 'the player reported no target latency, so nothing says the arm took';
  }
  if (arm.stallCountAtStart !== 0 && arm.stallCountAtStart !== null) {
    return `arm started with stallCount ${arm.stallCountAtStart}, so it carries the previous arm's penalty`;
  }
  if (firstTargetDurationS !== null && arm.targetDurationS !== null && arm.targetDurationS !== firstTargetDurationS) {
    return (
      `#EXT-X-TARGETDURATION moved from ${firstTargetDurationS} to ${arm.targetDurationS}, so the stall ` +
      'penalty ceiling is not the one earlier arms were measured under'
    );
  }
  return null;
}

/**
 * Per-arm contributions from a series of session totals.
 *
 * ⛔ `summarize` reads `rebufferCount`, `rebufferMs`, `fatalErrors` and `droppedFrames` through
 * `totalAcrossRestarts`, which takes the peak of a **monotonic session counter**. That is right for a
 * whole watch and wrong for one arm of a sweep: each arm would report everything its predecessors
 * accumulated, an arm that caused nothing would report the running total, and the column the sweep is
 * scored on would read flat whatever the buffer did.
 *
 * ⚠️ `stalledSamples` needs none of this. It counts samples inside the arm, which is why the two sat
 * side by side in one table looking like the same kind of number.
 *
 * A total that goes **down** is a player restart resetting its counter, so the drop is not negative
 * work: the arm contributed whatever it reached from zero.
 */
export function perArmFromSessionTotals(totals: readonly number[]): number[] {
  let previous = 0;
  return totals.map((total) => {
    // Against the previous reading rather than the running peak: after a restart the counter's own
    // baseline is what later arms are measured from, and carrying the old peak would credit every
    // arm after a restart with nothing until it climbed back past it.
    const contribution = total >= previous ? total - previous : total;
    previous = total;
    return contribution;
  });
}
