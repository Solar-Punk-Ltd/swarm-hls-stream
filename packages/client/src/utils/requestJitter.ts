/**
 * How wide a random delay may be put in front of a request to the gateway.
 *
 * ## Why any delay at all
 *
 * ⭐ What limits a bee gateway is not how many viewers it serves but **how many ask it for something
 * in the same instant**. Measured 2026-08-08 against one unfunded gateway: 128 viewers arriving in
 * cohorts of 8 held a 57-68ms median with 1.7% of segments over the 267ms budget and drained no
 * buffer at all. The same 128 viewers firing on one tick put 40% of segments over budget and drained
 * 12.8 seconds of buffer. Cohorts of 8 were safe, 32 was unstable, 128 failed every time it was run.
 * See `docs/bench/a-synchronised-audience-is-the-failure-2026-08-08.md`.
 *
 * Firing many requests for one chunk at the same moment does not get them merged, it gets them
 * raced: 47 retrieval operations per distinct chunk synchronised, against 8.4 for eight cohorts.
 *
 * ⛔ Viewers do not normally line up, because each one's timers started whenever it joined. They line
 * up **after a common shock**, when an outage clears or an encoder restarts and every player recovers
 * at once. So the herd forms on the recovery path, when the system is already degraded.
 *
 * ## Why this number
 *
 * ⚠️ **Chosen, not measured.** What was measured is the safe cohort size, not the delay that produces
 * it. 60ms is under a quarter of the 267ms segment budget at the shipping profile, so a segment
 * request that waits the full bound still has three quarters of its budget left. Spread uniformly
 * across it, a hundred-odd viewers land a couple per millisecond, which is the order of the cohort
 * size that held.
 *
 * Raising it buys a wider spread and spends buffer headroom. Lowering it to 0 disables the stagger
 * entirely and restores the previous behaviour exactly.
 */
export const GATEWAY_REQUEST_JITTER_MS = 60;

/**
 * The fraction of a manifest backoff that is randomised, on top of the stagger above.
 *
 * ⛔ A backoff is where alignment is *guaranteed* rather than merely possible. `backoffDelayMs` is a
 * pure function of the failure count, so every viewer that lost the same gateway at the same moment
 * waits the identical 2s, then 4s, then 8s, and arrives back together every time. That is the herd
 * this exists to break, and unlike the stagger it costs nothing: the viewer is already waiting.
 *
 * Proportional rather than absolute because the point of doubling a backoff is that later attempts
 * spread wider, and a fixed 60ms on top of a 30 second wait would not.
 */
export const MANIFEST_BACKOFF_JITTER_FRACTION = 0.25;

/** Cancels a staggered task if it has not run yet. Safe to call after it has. */
export interface StaggeredTask {
  cancel(): void;
}

/**
 * Puts a bounded random delay in front of work that is about to touch the gateway.
 *
 * Injectable rather than a free function because two of the three call sites need to cancel a task
 * that has not fired yet, and because a test that waited out a real stagger would be a test that
 * sleeps.
 */
export class RequestJitter {
  constructor(
    private readonly boundMs: number = GATEWAY_REQUEST_JITTER_MS,
    /** Injected only by tests, so a stagger is asserted rather than sampled. */
    private readonly random: () => number = Math.random,
    /**
     * Injected only by tests, so a stagger is asserted rather than waited out. Returns whatever the
     * canceller needs, kept opaque so the browser's `number` and Node's `Timeout` both fit.
     */
    private readonly schedule: (task: () => void, delayMs: number) => StaggeredTask = defaultSchedule,
  ) {}

  /**
   * A delay in `[0, boundMs)`, or exactly 0 when the bound is 0 or below.
   *
   * Uniform rather than the half-to-full shape the uploader's retry helper uses. That shape exists to
   * keep a *minimum* wait between attempts, where this one only has to decorrelate arrivals, and
   * halving the usable width would cost latency for nothing.
   */
  delayMs(): number {
    if (this.boundMs <= 0) {
      return 0;
    }
    return this.random() * this.boundMs;
  }

  /**
   * `delayMs` with its top `fraction` randomised away, so waits that were computed identically stop
   * ending identically. Returns `delayMs` untouched when the fraction is 0.
   *
   * Never longer than `delayMs`, so jittering a backoff can only bring an attempt forward. A retry
   * schedule that drifted later each time it was jittered would be a different schedule.
   */
  spread(delayMs: number, fraction: number = MANIFEST_BACKOFF_JITTER_FRACTION): number {
    if (fraction <= 0 || delayMs <= 0) {
      return delayMs;
    }
    const widest = delayMs * Math.min(fraction, 1);
    return delayMs - this.random() * widest;
  }

  /**
   * Run `task` after a bounded random delay.
   *
   * ⛔ Runs it **synchronously** when the delay is zero. Deferring a disabled stagger by a tick would
   * make turning it off a behaviour change of its own, and the fragment loader's contract with hls.js
   * is the sort of thing that notices.
   */
  stagger(task: () => void): StaggeredTask {
    const delayMs = this.delayMs();
    if (delayMs <= 0) {
      task();
      return NOT_PENDING;
    }
    return this.schedule(task, delayMs);
  }
}

const NOT_PENDING: StaggeredTask = { cancel: () => {} };

function defaultSchedule(task: () => void, delayMs: number): StaggeredTask {
  const timer = setTimeout(task, delayMs);
  return { cancel: () => clearTimeout(timer) };
}
