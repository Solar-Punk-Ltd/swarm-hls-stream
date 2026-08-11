/**
 * The player used to call `hls.recoverMediaError()` on every fatal media error with no window, no
 * escalation and no ending. Recovery re-appends the media that failed, so a broadcast a decoder cannot
 * accept turned into a black player refetching fragments for as long as the tab stayed open.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  MEDIA_ERROR_RECOVERY_WINDOW_MS,
  nextMediaErrorAction,
  NO_MEDIA_ERRORS_YET,
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
});
