import type Hls from 'hls.js';

/**
 * Where a measurement harness finds the live player.
 *
 * Prefixed and spelled out rather than short, because it is a global on a page that also runs a
 * Swarm node, and a name like `hls` would collide with whatever else claims it.
 */
export const PLAYER_HANDLE = '__swarmHlsPlayer';

interface PlayerHandleHolder {
  [PLAYER_HANDLE]?: Hls;
}

/**
 * Publish the player for a measurement harness, and hand back the detach.
 *
 * ## Why this exists
 *
 * `LIVE_SYNC_DURATION_S` is how far behind live a viewer sits, and it is roughly four fifths of the
 * delay a viewer actually feels. Nothing has ever measured whether the shipped 6 is the right value
 * at the segment length we now publish, and the experiment that would
 * (`docs/bench/stall-penalty-and-the-runtime-sweep-2026-08-12.md`) needs to vary it **between arms of
 * one broadcast**. hls.js supports exactly that through `hls.targetLatency`, which also resets the
 * stall penalty so one arm cannot contaminate the next.
 *
 * What was missing is a way to reach the instance: it lives as a local inside the player's effect,
 * and the QoE overlay only ever reads from it. Rebuilding the client per arm was the alternative,
 * and that means a fresh join and a cold start inside every arm of a measurement about startup
 * behaviour.
 *
 * ⛔ **Never gate product behaviour on this.** It is an instrumentation seam, so the only correct
 * use is a harness reading or driving a player that would have behaved identically without it.
 */
export function exposePlayerForInstrumentation(hls: Hls): (() => void) | null {
  // ⛔ Spelled out rather than read through a named constant, and that is not a style choice. Vite
  // only substitutes `import.meta.env.VITE_x` written as a static member access; an index by
  // variable is left as a runtime lookup, the branch survives minification, and the handle ships.
  // Measured: with the flag behind a constant, `__swarmHlsPlayer` was present in a production
  // bundle. `bundle.test.ts` holds the line.
  if (!import.meta.env.VITE_EXPOSE_PLAYER) {
    return null;
  }

  const holder = globalThis as unknown as PlayerHandleHolder;
  holder[PLAYER_HANDLE] = hls;

  return () => {
    // Compared before deleting, because a remount publishes the new player before React runs the old
    // one's cleanup, and an unconditional delete would remove the live one and leave the harness
    // looking at nothing halfway through an arm.
    if (holder[PLAYER_HANDLE] === hls) {
      delete holder[PLAYER_HANDLE];
    }
  };
}
