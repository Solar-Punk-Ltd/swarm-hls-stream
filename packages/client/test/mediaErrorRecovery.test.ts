/**
 * The player used to call `hls.recoverMediaError()` on every fatal media error with no window, no
 * escalation and no ending. Recovery re-appends the media that failed, so a broadcast a decoder cannot
 * accept turned into a black player refetching fragments for as long as the tab stayed open.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  MEDIA_ERROR_RECOVERY_WINDOW_MS,
  MediaErrorRecoverer,
  nextMediaErrorAction,
  NO_MEDIA_ERRORS_YET,
  recoverFromMediaError,
} from '../src/components/SwarmHlsPlayer/mediaErrorRecovery';

const T0 = 1_000_000;

describe('escalating a fatal media error instead of retrying it forever', () => {
  it('recovers the first one without ceremony', () => {
    const { action } = nextMediaErrorAction(NO_MEDIA_ERRORS_YET, T0);

    assert.equal(action, 'recover');
  });

  it('swaps the audio codec when the same failure comes straight back', () => {
    const first = nextMediaErrorAction(NO_MEDIA_ERRORS_YET, T0);
    const second = nextMediaErrorAction(first.state, T0 + 100);

    assert.equal(second.action, 'swap-codec-and-recover');
  });

  it('restarts once both rungs have been tried inside one window', () => {
    const first = nextMediaErrorAction(NO_MEDIA_ERRORS_YET, T0);
    const second = nextMediaErrorAction(first.state, T0 + 100);
    const third = nextMediaErrorAction(second.state, T0 + 200);

    assert.equal(third.action, 'restart', 'the loop this exists to end had no ending at all');
  });

  /**
   * The distinction the window is for. A stream that fails once an hour is not the stream that cannot
   * play, and treating them the same would either restart the healthy one or loop on the broken one.
   */
  it('treats a failure after the window as a fresh problem, not an escalation', () => {
    const first = nextMediaErrorAction(NO_MEDIA_ERRORS_YET, T0);
    const later = nextMediaErrorAction(first.state, T0 + MEDIA_ERROR_RECOVERY_WINDOW_MS + 1);

    assert.equal(later.action, 'recover', 'an hourly hiccup must not accumulate towards a restart');
  });

  it('resets the ladder after a restart, so one more error cannot restart again immediately', () => {
    const first = nextMediaErrorAction(NO_MEDIA_ERRORS_YET, T0);
    const second = nextMediaErrorAction(first.state, T0 + 100);
    const third = nextMediaErrorAction(second.state, T0 + 200);
    const afterRestart = nextMediaErrorAction(third.state, T0 + 300);

    assert.equal(afterRestart.action, 'recover');
  });

  it('leaves the state it was given alone', () => {
    const state = { ...NO_MEDIA_ERRORS_YET };

    nextMediaErrorAction(state, T0);

    assert.deepEqual(state, NO_MEDIA_ERRORS_YET, 'the caller holds this across events and must own it');
  });

  /**
   * ⛔ Why the caller must read a monotonic clock, made executable rather than left in a comment.
   *
   * The whole ladder is a subtraction of two clock readings, so a clock that can jump breaks it in
   * both directions, and the two failures are opposite. `feedState.ts` already documents this for its
   * own deadlines; the player called this one with `Date.now()`, the one non-monotonic clock in the
   * package, which an NTP correction moves under a viewer mid-session.
   */
  describe('a clock that jumps, which is why the caller owes this a monotonic one', () => {
    it('forgets an escalation already in progress when the clock steps forward', () => {
      const first = nextMediaErrorAction(NO_MEDIA_ERRORS_YET, T0);
      const afterStepForward = nextMediaErrorAction(first.state, T0 + MEDIA_ERROR_RECOVERY_WINDOW_MS + 1);

      // Reads as an hourly hiccup, so the ladder never climbs and a stream that cannot play is
      // recovered forever: exactly the unbounded loop this module exists to end.
      assert.equal(afterStepForward.action, 'recover');
    });

    it('escalates to a restart on the very next error when the clock steps backward', () => {
      const first = nextMediaErrorAction(NO_MEDIA_ERRORS_YET, T0);
      const second = nextMediaErrorAction(first.state, T0 - 5_000);
      const third = nextMediaErrorAction(second.state, T0 - 5_000);

      // A negative elapsed time is inside any window, so every error looks like a repeat and a
      // stream that would have recovered is torn down and restarted instead.
      assert.equal(second.action, 'swap-codec-and-recover');
      assert.equal(third.action, 'restart');
    });
  });
});

/**
 * hls.js's recoverMediaError restarts loading only when the playhead is past zero, and the player
 * runs with autoStartLoad off so it can set startLevel before the first load. A fatal media error
 * before the first frame therefore re-attached the media and stopped, leaving the recovery ladder's
 * higher rungs unreachable on a black player.
 */
describe('resuming loading after a media-error recovery', () => {
  class FakeHls implements MediaErrorRecoverer {
    public readonly calls: string[] = [];
    swapAudioCodec(): void {
      this.calls.push('swapAudioCodec');
    }
    recoverMediaError(): void {
      this.calls.push('recoverMediaError');
    }
    startLoad(): void {
      this.calls.push('startLoad');
    }
  }

  it('starts loading by hand when the media error struck at playhead zero', () => {
    const hls = new FakeHls();

    recoverFromMediaError(hls, 0, false);

    assert.deepEqual(hls.calls, ['recoverMediaError', 'startLoad'], 'a zero playhead is left stopped without this');
  });

  it('leaves the restart to hls.js once the playhead has moved, so loading is not started twice', () => {
    const hls = new FakeHls();

    recoverFromMediaError(hls, 5, false);

    assert.deepEqual(hls.calls, ['recoverMediaError'], 'recoverMediaError restarts a past-zero playhead itself');
  });

  it('swaps the audio codec before recovering, and still resumes at playhead zero', () => {
    const hls = new FakeHls();

    recoverFromMediaError(hls, 0, true);

    assert.deepEqual(hls.calls, ['swapAudioCodec', 'recoverMediaError', 'startLoad']);
  });
});
