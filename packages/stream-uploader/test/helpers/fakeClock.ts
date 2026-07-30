import { Clock, Timer, TimerOptions } from '../../src/libs/Clock.js';

interface ScheduledTimer {
  dueAt: number;
  handler: () => void;
  cancelled: boolean;
}

/**
 * A clock whose time only moves when a test moves it, so a sixty second timeout costs no wall time.
 *
 * `advance` fires due timers in due order and keeps going for timers scheduled by those handlers, so
 * a chain of timeouts resolves within one call. Handlers run synchronously: a handler that returns a
 * promise is not awaited here, which matches how `setTimeout` behaves.
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
      },
    };
  }

  public advance(byMs: number): void {
    const target = this.currentMs + byMs;

    for (;;) {
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
    }

    this.currentMs = target;
  }

  /** Timers still waiting to fire, for asserting that something was scheduled or cancelled. */
  public pendingCount(): number {
    return this.scheduled.filter((entry) => !entry.cancelled).length;
  }
}
