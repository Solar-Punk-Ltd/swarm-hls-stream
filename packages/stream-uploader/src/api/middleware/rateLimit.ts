import { NextFunction, Request, Response } from 'express';

import { ApiError } from './errorHandler.js';

/**
 * A fixed-window request counter.
 *
 * `express-rate-limit` was the first choice and was rejected on its dependency tree rather than on
 * its quality: it is attested and settled at 8.5.2, but it pulls `ip-address` at `^10.2.0`, which
 * resolves to a release published the day before this landed, and it pulls it for IP-based keying
 * that this service does not use. Every limit here is keyed on the stream, not the peer.
 *
 * Fixed window rather than sliding, because the whole map is discarded when the window rolls. That
 * is what bounds the memory: nothing accumulates across windows, so the live key count is at most
 * the number of requests admitted inside one window, and the global limiter mounted ahead of the
 * per-stream one bounds that in turn.
 */
export interface RateLimitOptions {
  windowMs: number;
  /** Requests one key may spend per window. */
  max: number;
  /** What shares a budget. A constant makes the limit global. */
  keyOf(req: Request): string;
  /** Sent to the caller on refusal. Says which limit was hit, so the caller knows what to change. */
  message: string;
}

/** Seconds a refused caller is told to wait. Derived from the window so the two cannot disagree. */
function retryAfterSeconds(windowMs: number, windowEndsAt: number, now: number): string {
  const remainingMs = Math.max(0, Math.min(windowMs, windowEndsAt - now));
  return String(Math.max(1, Math.ceil(remainingMs / 1000)));
}

export function createRateLimiter(options: RateLimitOptions, now: () => number = Date.now) {
  const { windowMs, max, keyOf, message } = options;
  let counts = new Map<string, number>();
  let windowEndsAt = now() + windowMs;

  return function rateLimit(req: Request, _res: Response, next: NextFunction): void {
    const at = now();

    if (at >= windowEndsAt) {
      // Replaced rather than cleared, so a key that was never seen again cannot survive a rollover.
      counts = new Map();
      windowEndsAt = at + windowMs;
    }

    const key = keyOf(req);
    const spent = (counts.get(key) ?? 0) + 1;
    counts.set(key, spent);

    if (spent > max) {
      throw new ApiError(429, message, retryAfterSeconds(windowMs, windowEndsAt, at));
    }

    next();
  };
}
