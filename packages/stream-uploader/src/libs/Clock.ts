export interface Timer {
  cancel(): void;
}

export interface TimerOptions {
  /**
   * When true the timer must not, on its own, keep the process alive. Use it for deadlines that only
   * matter while other work is in flight, since there is nothing to time out once the process is
   * otherwise idle.
   */
  unref?: boolean;
}

/**
 * The time-dependent operations the orchestrator needs, injected so a test can step time instead of
 * waiting for it. `now` is a monotonic reading for measuring durations, not a wall-clock date, so it
 * is immune to a clock adjustment moving backwards.
 */
export interface Clock {
  now(): number;
  setTimer(handler: () => void, delayMs: number, options?: TimerOptions): Timer;
}

export const systemClock: Clock = {
  now: () => performance.now(),

  setTimer(handler, delayMs, options = {}) {
    const id = setTimeout(handler, delayMs);
    if (options.unref) {
      id.unref();
    }
    return { cancel: () => clearTimeout(id) };
  },
};
