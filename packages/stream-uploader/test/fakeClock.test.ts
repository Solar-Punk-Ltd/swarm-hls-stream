import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { systemClock } from '../src/libs/Clock.js';

import { FakeClock } from './helpers/fakeClock.js';

describe('FakeClock', () => {
  it('fires due timers in due order, not in scheduling order', async () => {
    const clock = new FakeClock();
    const fired: string[] = [];

    clock.setTimer(() => fired.push('late'), 300);
    clock.setTimer(() => fired.push('early'), 100);
    clock.setTimer(() => fired.push('middle'), 200);
    await clock.advance(500);

    assert.deepEqual(fired, ['early', 'middle', 'late']);
  });

  it('fires a timer scheduled by another timer within the same step', async () => {
    const clock = new FakeClock();
    const fired: string[] = [];

    clock.setTimer(() => {
      fired.push('first');
      clock.setTimer(() => fired.push('chained'), 10);
    }, 10);
    await clock.advance(100);

    assert.deepEqual(fired, ['first', 'chained']);
  });

  it('does not fire a cancelled timer and stops counting it as pending', async () => {
    const clock = new FakeClock();
    let fired = false;

    const timer = clock.setTimer(() => {
      fired = true;
    }, 50);
    assert.equal(clock.pendingCount(), 1);
    timer.cancel();
    assert.equal(clock.pendingCount(), 0);
    await clock.advance(500);

    assert.equal(fired, false, 'a cancelled timer must not fire however far time is advanced');
  });

  it('fires exactly at the delay, not one tick later', async () => {
    const clock = new FakeClock();
    let fired = false;

    clock.setTimer(() => {
      fired = true;
    }, 50);
    await clock.advance(49);
    assert.equal(fired, false, 'one short of the delay must not fire');
    await clock.advance(1);

    assert.equal(fired, true, 'landing exactly on the delay must fire');
  });

  it('reports time from the same domain the real clock uses', () => {
    // performance.now is milliseconds since process start, so it is far below an epoch timestamp.
    // A systemClock that read Date.now instead would defeat the monotonicity its docstring promises.
    assert.ok(systemClock.now() < Date.now() / 2, 'now() must be a monotonic reading, not a wall-clock date');
  });
});

/**
 * `systemClock`'s own timer, which nothing established anything about.
 *
 * Three mutants lived on the `unref` guard: `if (true)`, `if (false)` and an emptied block each
 * passed all 730 tests, so the flag was free to mean nothing in either direction. Its one caller is
 * the drain deadline in `StreamOrchestrator`, whose comment is that a pending drain is not a reason
 * to keep the process alive, so a flag that stopped being honoured is an uploader that will not exit
 * until a deadline it no longer needs expires.
 *
 * `setTimeout` is stubbed rather than the timing observed, because "did this process stay alive"
 * cannot be asserted from inside the process that would be staying alive.
 */
describe('systemClock timers', () => {
  interface StubbedTimers {
    unrefCalls: number;
    clearedHandles: unknown[];
  }

  const withStubbedTimers = (run: () => void): StubbedTimers => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const stubbed: StubbedTimers = { unrefCalls: 0, clearedHandles: [] };
    const handle = {
      unref: () => {
        stubbed.unrefCalls++;
        return handle;
      },
    };

    globalThis.setTimeout = (() => handle) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((given: unknown) => {
      stubbed.clearedHandles.push(given);
    }) as unknown as typeof globalThis.clearTimeout;
    try {
      run();
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
    return stubbed;
  };

  it('unrefs a timer that asked not to hold the process open', () => {
    const stubbed = withStubbedTimers(() => {
      systemClock.setTimer(() => {}, 10, { unref: true });
    });

    assert.equal(
      stubbed.unrefCalls,
      1,
      'a timer asked to unref did not, so a drain deadline would hold the process open',
    );
  });

  // The other direction, and the reason one assertion is not enough: a guard stuck open passes the
  // test above and silently unrefs every timer, which drops deadlines that were meant to hold.
  it('leaves a timer that said nothing about it holding the process open', () => {
    const stubbed = withStubbedTimers(() => {
      systemClock.setTimer(() => {}, 10);
    });

    assert.equal(stubbed.unrefCalls, 0, 'a timer that never asked to unref was unreffed anyway');
  });

  it('treats unref false as not asking', () => {
    const stubbed = withStubbedTimers(() => {
      systemClock.setTimer(() => {}, 10, { unref: false });
    });

    assert.equal(stubbed.unrefCalls, 0);
  });

  // Asserts the handle rather than the call count, since clearing something is not the same as
  // clearing the timer that was made.
  it('cancels the handle it was given, rather than one it made up', () => {
    let made: unknown;
    const stubbed = withStubbedTimers(() => {
      made = globalThis.setTimeout(() => {}, 0);
      systemClock.setTimer(() => {}, 10).cancel();
    });

    assert.deepEqual(stubbed.clearedHandles, [made], 'cancel did not clear the handle setTimeout returned');
  });
});
