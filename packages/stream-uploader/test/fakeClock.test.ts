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
