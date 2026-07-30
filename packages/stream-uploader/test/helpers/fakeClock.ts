import { Clock, Timer, TimerOptions } from '../../src/libs/Clock.js';

interface ScheduledTimer {
  dueAt: number;
  handler: () => void;
  cancelled: boolean;
}

const RUNAWAY_TIMER_LIMIT = 10_000;

/**
 * A clock whose time only moves when a test moves it, so a sixty second timeout costs no wall time.
 *
 * `advance` fires due timers in due order and keeps going for timers scheduled by those handlers, so a
 * chain of timeouts resolves within one call. It yields a macrotask between handlers, which is why it is
 * async: a real timer handler runs in its own macrotask after microtasks have drained, so firing several
 * synchronously in a row would give an ordering `setTimeout` never produces, and an assertion placed
 * after `advance` would run before any asynchronous work a handler started.
 *
 * Two things it deliberately does not model. `unref` is accepted and ignored, since nothing here holds
 * the event loop open, so a test on this clock cannot detect an `unref` regression. And a handler that
 * throws will reject `advance`, where a real one becomes an `uncaughtException` and leaves later timers
 * to run.
 */
export class FakeClock implements Clock {
  private currentMs = 0;
  private scheduled: ScheduledTimer[] = [];

  public now(): number {
    return this.currentMs;
  }

  public setTimer(handler: () => void, delayMs: number, _options?: TimerOptions): Timer {
    const entry: ScheduledTimer = { dueAt: this.currentMs + delayMs, handler, cancelled: false };
    this.scheduled = [...this.scheduled, entry];
    return {
      cancel: () => {
        entry.cancelled = true;
        this.scheduled = this.scheduled.filter((scheduled) => scheduled !== entry);
      },
    };
  }

  public async advance(byMs: number): Promise<void> {
    const target = this.currentMs + byMs;

    for (let fired = 0; ; fired++) {
      if (fired > RUNAWAY_TIMER_LIMIT) {
        throw new Error(`FakeClock.advance fired ${RUNAWAY_TIMER_LIMIT} timers without reaching ${target}ms`);
      }

      const due = this.scheduled
        .filter((entry) => !entry.cancelled && entry.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt);

      const next = due[0];
      if (!next) {
        break;
      }

      this.currentMs = next.dueAt;
      next.cancelled = true;
      this.scheduled = this.scheduled.filter((entry) => entry !== next);
      next.handler();
      await new Promise((resolve) => setImmediate(resolve));
    }

    this.currentMs = target;
  }

  /** Timers still waiting to fire, for asserting that something was scheduled or cancelled. */
  public pendingCount(): number {
    return this.scheduled.filter((entry) => !entry.cancelled).length;
  }
}
