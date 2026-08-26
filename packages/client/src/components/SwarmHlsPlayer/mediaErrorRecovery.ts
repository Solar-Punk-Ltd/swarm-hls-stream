/**
 * How many times in a row a fatal media error is worth trying to recover from, and what to try next.
 *
 * hls.js exposes `recoverMediaError()` and documents an escalation around it, because calling it
 * unconditionally on every fatal media error is an unbounded loop: the recovery re-appends the same
 * media that failed, which fails again, which recovers again. Each turn of that loop refetches
 * fragments, so a broadcast whose opening media a decoder cannot accept becomes a viewer sitting on a
 * black player pulling media forever.
 *
 * Kept as a pure function of an explicit clock reading so the escalation can be tested at all. The
 * player component has no test: `packages/client` runs vitest with `environment: 'node'` and no jsdom,
 * so the decision has to leave the component to be covered.
 */

/** hls.js's own figure. A second failure sooner than this is the same failure, not a new one. */
export const MEDIA_ERROR_RECOVERY_WINDOW_MS = 3000;

/**
 * What to do about a fatal media error.
 *
 * `restart` is deliberately the last rung rather than `destroy`. The player already treats genuinely
 * unrecoverable errors by restarting, and for a live stream that is the better ending: the publisher
 * may fix what it is sending, and a viewer who is handed a dead player never finds out.
 */
export type MediaErrorAction = 'recover' | 'swap-codec-and-recover' | 'restart';

export interface MediaErrorRecoveryState {
  /** When the last recovery was attempted, or null if none has been. */
  lastRecoverAtMs: number | null;
  hasSwappedCodec: boolean;
}

export const NO_MEDIA_ERRORS_YET: MediaErrorRecoveryState = {
  lastRecoverAtMs: null,
  hasSwappedCodec: false,
};

export interface MediaErrorDecision {
  action: MediaErrorAction;
  state: MediaErrorRecoveryState;
}

/**
 * Decides the next rung and returns the state to carry into the following error.
 *
 * An error arriving after the window has passed is treated as a fresh problem, which resets the ladder
 * to the bottom rung. That is the difference between a stream that hiccups once an hour and one that
 * cannot play at all, and only the second should ever reach `restart`.
 *
 * @param nowMs A reading from a **monotonic** clock, so `performance.now()` and not `Date.now()`. The
 *   whole ladder is a subtraction of two readings, and a clock that steps breaks it in both
 *   directions: forward and an escalation already under way is forgotten, so a stream that cannot
 *   play is recovered forever, which is the unbounded loop this module exists to end; backward and
 *   every error reads as a repeat, so a stream that would have recovered is restarted instead. An
 *   NTP correction moves `Date.now()` under a viewer mid-session. `FeedHealthTracker` takes its clock
 *   for the same reason.
 */
export function nextMediaErrorAction(
  state: MediaErrorRecoveryState,
  nowMs: number,
  windowMs: number = MEDIA_ERROR_RECOVERY_WINDOW_MS,
): MediaErrorDecision {
  const isRepeat = state.lastRecoverAtMs !== null && nowMs - state.lastRecoverAtMs < windowMs;

  if (!isRepeat) {
    return { action: 'recover', state: { lastRecoverAtMs: nowMs, hasSwappedCodec: false } };
  }
  if (!state.hasSwappedCodec) {
    return { action: 'swap-codec-and-recover', state: { lastRecoverAtMs: nowMs, hasSwappedCodec: true } };
  }
  // Both rungs tried inside one window. Restarting drops the whole pipeline, so the ladder starts
  // again from the bottom rather than leaving the viewer one error away from a permanent restart loop.
  return { action: 'restart', state: NO_MEDIA_ERRORS_YET };
}

/** The hls.js surface a recovery uses, kept minimal so the escalation above stays testable too. */
export interface MediaErrorRecoverer {
  swapAudioCodec(): void;
  recoverMediaError(): void;
  startLoad(startPosition?: number): void;
}

/**
 * Runs a `recover` or `swap-codec-and-recover` rung and makes sure loading resumes, even at playhead
 * zero.
 *
 * hls.js's `recoverMediaError` detaches the media, re-attaches it, and restarts loading only when the
 * playhead is past zero: `if (time) this.startLoad(time)` (1.6.15). The player runs with
 * `autoStartLoad` off so it can set `startLevel` before the first load, so a re-attach does not
 * autostart either. A fatal media error before the first frame, such as an incompatible-codec error
 * raised at manifest parse, therefore leaves the player stopped for good with the recovery ladder's
 * higher rungs unreachable. Starting the load by hand in exactly that case fills the gap and does not
 * disturb the past-zero path, which `recoverMediaError` already restarts itself.
 *
 * @param currentTimeSeconds The playhead read *before* recovery, since `recoverMediaError` detaches
 *   the media and the reading is lost after it.
 */
export function recoverFromMediaError(hls: MediaErrorRecoverer, currentTimeSeconds: number, swapCodec: boolean): void {
  if (swapCodec) {
    hls.swapAudioCodec();
  }
  hls.recoverMediaError();
  if (!currentTimeSeconds) {
    hls.startLoad();
  }
}
