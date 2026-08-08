import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  GATEWAY_REQUEST_JITTER_MS,
  MANIFEST_BACKOFF_JITTER_FRACTION,
  RequestJitter,
  type StaggeredTask,
} from '../src/utils/requestJitter';

/**
 * Records what was scheduled instead of scheduling it, so a stagger is asserted rather than waited
 * out. Nothing runs until `fire` is called, which is how a test can observe the gap.
 */
function recordingSchedule() {
  const scheduled: { task: () => void; delayMs: number; cancelled: boolean }[] = [];
  const schedule = (task: () => void, delayMs: number): StaggeredTask => {
    const entry = { task, delayMs, cancelled: false };
    scheduled.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  };
  return {
    scheduled,
    schedule,
    fire: (at = 0) => scheduled[at].task(),
  };
}

describe('RequestJitter picking a delay', () => {
  it('returns zero for a zero bound, so the stagger can be turned off completely', () => {
    assert.equal(new RequestJitter(0, () => 0.99).delayMs(), 0);
  });

  it('returns zero for a negative bound rather than a delay that runs backwards', () => {
    assert.equal(new RequestJitter(-50, () => 0.99).delayMs(), 0);
  });

  it('spans the whole bound, from nothing to just under it', () => {
    assert.equal(new RequestJitter(60, () => 0).delayMs(), 0);
    assert.equal(new RequestJitter(60, () => 0.5).delayMs(), 30);
  });

  /**
   * The property that matters is the ceiling: a delay that could exceed its bound is a delay that
   * could put a fragment past its segment budget on its own.
   */
  it('never reaches the bound, across the whole range of the source', () => {
    const bound = 60;
    for (const r of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 0.9999999]) {
      const delay = new RequestJitter(bound, () => r).delayMs();
      assert.ok(delay >= 0 && delay < bound, `r=${r} gave ${delay}, which is outside [0, ${bound})`);
    }
  });

  /** The shipped source, rather than an injected one, because that is what a viewer runs. */
  it('stays inside its bound on the real random source', () => {
    const jitter = new RequestJitter(GATEWAY_REQUEST_JITTER_MS);
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i++) {
      const delay = jitter.delayMs();
      assert.ok(delay >= 0 && delay < GATEWAY_REQUEST_JITTER_MS, `${delay} is outside the bound`);
      seen.add(delay);
    }
    // The whole point is decorrelation, so a source that kept answering the same thing would defeat
    // it while passing every bound assertion above.
    assert.ok(seen.size > 1_000, `only ${seen.size} distinct delays in 2000 draws, which is not a spread`);
  });
});

describe('RequestJitter spreading a wait that was computed identically everywhere', () => {
  it('leaves the wait alone when the fraction is zero', () => {
    assert.equal(new RequestJitter(60, () => 0.9).spread(2_000, 0), 2_000);
  });

  it('leaves a wait of zero alone, so a viewer with no backoff still has none', () => {
    assert.equal(new RequestJitter(60, () => 0.9).spread(0), 0);
  });

  /**
   * ⛔ Only ever earlier. A jitter that could push an attempt later would be lengthening the retry
   * schedule every time it was applied, which is a different schedule from the one that was chosen.
   */
  it('only ever brings the attempt forward', () => {
    const wait = 8_000;
    for (const r of [0, 0.5, 0.999]) {
      const spread = new RequestJitter(60, () => r).spread(wait);
      assert.ok(spread <= wait, `r=${r} gave ${spread}, which is later than the ${wait} asked for`);
      assert.ok(spread >= wait * (1 - MANIFEST_BACKOFF_JITTER_FRACTION), `r=${r} gave ${spread}, which is too early`);
    }
  });

  it('takes the whole wait off at most, however large the fraction is', () => {
    assert.equal(new RequestJitter(60, () => 1).spread(5_000, 4), 0);
  });

  it('spreads by the fraction it was given', () => {
    // Half of a quarter of 4000 is 500, so the wait comes back 500 short.
    assert.equal(new RequestJitter(60, () => 0.5).spread(4_000, 0.25), 3_500);
  });
});

describe('RequestJitter staggering the work itself', () => {
  it('runs the task synchronously when there is no delay to wait', () => {
    const timer = recordingSchedule();
    let ran = false;

    new RequestJitter(0, () => 0.9, timer.schedule).stagger(() => {
      ran = true;
    });

    assert.equal(ran, true, 'a disabled stagger deferred the task anyway');
    assert.equal(timer.scheduled.length, 0, 'a disabled stagger still reached the timer');
  });

  it('holds the task back when there is, and runs it when the delay is up', () => {
    const timer = recordingSchedule();
    let ran = false;

    new RequestJitter(60, () => 0.5, timer.schedule).stagger(() => {
      ran = true;
    });

    assert.equal(ran, false, 'the task ran without waiting for its stagger');
    assert.equal(timer.scheduled.length, 1);
    assert.equal(timer.scheduled[0].delayMs, 30);

    timer.fire();
    assert.equal(ran, true);
  });

  it('hands back a cancel that stops a task which has not run', () => {
    const timer = recordingSchedule();
    let ran = false;

    const pending = new RequestJitter(60, () => 0.5, timer.schedule).stagger(() => {
      ran = true;
    });
    pending.cancel();

    assert.equal(timer.scheduled[0].cancelled, true, 'cancelling did not reach the timer');
    assert.equal(ran, false);
  });

  it('hands back a cancel that is safe to call on a task that already ran', () => {
    const pending = new RequestJitter(0, () => 0).stagger(() => {});
    assert.doesNotThrow(() => pending.cancel());
  });
});

/**
 * ⛔ Every other test here injects over the bound, the source or the timer, which proves the class
 * does what it is told and nothing about what a viewer runs. The suite would stay green on a shipped
 * bound of zero, and a shipped bound of zero is the whole feature doing nothing.
 *
 * This is the same guard the backoff tests carry for `waitMs`, and for the same reason: a default
 * that quietly returned immediately once put a page of players back on a down gateway at full
 * cadence with everything passing.
 */
describe('the shipped defaults, which nothing else in this file exercises', () => {
  it('staggers by a real, non-zero amount', () => {
    assert.ok(GATEWAY_REQUEST_JITTER_MS > 0, 'the shipped stagger is off, so no request is ever moved');
  });

  it('leaves most of a segment budget intact at the shipping profile', () => {
    // 267ms is an eight-frame GOP at 30fps, the 0.25s profile that ships. A stagger that could eat a
    // large share of it would be spending the budget it is meant to protect.
    assert.ok(GATEWAY_REQUEST_JITTER_MS < 267 / 3, `${GATEWAY_REQUEST_JITTER_MS}ms is a large share of a 267ms budget`);
  });

  it('spreads a backoff by a real fraction', () => {
    assert.ok(MANIFEST_BACKOFF_JITTER_FRACTION > 0, 'aligned backoffs are not spread at all');
    assert.ok(MANIFEST_BACKOFF_JITTER_FRACTION <= 1);
  });

  it('actually waits, on the real timer', async () => {
    const jitter = new RequestJitter(30, () => 1);
    const startedAt = performance.now();
    await new Promise<void>((resolve) => jitter.stagger(resolve));

    // The lower bound carries the same slack as the backoff tests, for the same measured reason:
    // `setTimeout` schedules on libuv's clock and this reads `performance.now()`, and the two
    // disagree by under a millisecond about 1% of the time.
    assert.ok(performance.now() - startedAt >= 30 - 2, 'the shipped stagger returned without waiting');
  });
});
