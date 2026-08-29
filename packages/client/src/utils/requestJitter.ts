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
 * ## ⛔ Why this is 0, having shipped at 60ms and been measured
 *
 * **60ms was measured and it does nothing.** Eight arms at 128 paced viewers put a jittered herd at
 * 8041 and 10826ms of ending lag against an unjittered one at 9437 and 9711, in both rounds, inside
 * the spread an unfunded node shows on identical work. See
 * `docs/bench/jitter-is-not-what-breaks-a-herd-2026-08-08.md`.
 *
 * ⭐⭐ **The reason is that the cohort finding above is about chunk diversity, not arrival instant, and
 * jitter buys no chunk diversity.** Viewers at sixteen playback positions want sixteen different
 * chunks, so the gateway has something to spread the work across. Viewers moved a few tens of
 * milliseconds are still at one playback position wanting one chunk. A whole segment duration of
 * jitter is where the two start to converge, and even that disagreed between rounds.
 *
 * So a client cannot jitter its way out of a live herd at any bound it can afford to add to the live
 * edge. What does mitigate one is the gateway's cache, which takes network contacts to one fetch per
 * distinct chunk for 128 viewers, and pooling viewers so that fetch is shared. Neither is a client
 * change.
 *
 * The mechanism, its configurability and its tests all stay, because an operator with evidence for a
 * regime this was not measured in can turn it on. 0 runs every staggered task synchronously, which is
 * exactly what happened before any of this existed rather than approximately.
 */
export const GATEWAY_REQUEST_JITTER_MS = 0;

/**
 * The fraction of a manifest backoff that is randomised, on top of the stagger above.
 *
 * ⛔ A backoff is where alignment is *guaranteed* rather than merely possible. `backoffDelayMs` is a
 * pure function of the failure count, so every viewer that lost the same gateway at the same moment
 * waits the identical 2s, then 4s, then 8s, and arrives back together every time. That is the herd
 * this exists to break, and unlike the stagger it costs nothing: the viewer is already waiting.
 *
 * Proportional rather than absolute because the point of doubling a backoff is that later attempts
 * spread wider, and a fixed 60ms on top of a multi-second wait would not.
 *
 * ⚠️ **This stays on where the stagger above was turned off, and the difference is scale.** A quarter
 * of a 2 to 8 second backoff is 0.5 to 2 seconds of separation, which is the order that was measured
 * to work, where 60ms is the order that was measured not to. ⬅ **Not itself measured**, and kept as
 * standard practice for a retry storm rather than as a result of this project's.
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
