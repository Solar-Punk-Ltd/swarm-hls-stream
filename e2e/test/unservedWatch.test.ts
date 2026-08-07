import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UnservedSegmentWatch, type UnservedWatchOptions } from '../src/bench/unservedWatch.js';

const OPTIONS: UnservedWatchOptions = { budgetMs: 10_000, recheckMs: 1_000, concurrency: 2 };

/**
 * A clock the test advances, and a wait that advances it.
 *
 * Driven rather than real, for the reason `test-stability-rewrites` records: a timing test that waits
 * out its own budget is slow, and one that asserts against a second copy of its own schedule cannot
 * fail. Here the schedule is the subject, so it has to be the thing the test controls.
 */
function drivenClock() {
  let nowMs = 1_000_000;
  return {
    now: () => nowMs,
    wait: async (ms: number) => {
      nowMs += ms;
    },
  };
}

/** A gateway that refuses `refusals` times for each ref, then serves it. */
function gatewayRefusing(refusals: number) {
  const asked = new Map<string, number>();
  return {
    asked,
    ask: async (ref: string) => {
      const seen = (asked.get(ref) ?? 0) + 1;
      asked.set(ref, seen);
      if (seen <= refusals) {
        throw new Error(`${ref} answered 404`);
      }
    },
  };
}

describe('timing a refused segment off the collection loop', () => {
  it('records how long the gateway went on refusing, from the refusal', async () => {
    const clock = drivenClock();
    const gateway = gatewayRefusing(2);
    const watch = new UnservedSegmentWatch(gateway.ask, OPTIONS, clock.now, clock.wait);

    watch.observe('ref-a');
    await watch.settle();

    assert.equal(watch.resolutions.length, 1);
    // Asked at once, refused, then twice more a second apart. Served at two seconds, not three: the
    // watcher used to sleep before its first ask and charged that sleep to the gateway.
    assert.deepEqual(watch.resolutions[0], { ref: 'ref-a', resolvedAfterMs: 2_000, asks: 3 });
  });

  /**
   * Task #103. The watcher slept `recheckMs` before asking anything, so the smallest number it could
   * ever report was one whole recheck interval, and at the shipped 1000ms that is the same 1 second
   * the report uses as its threshold. Every resolution was overstated by exactly one interval, and a
   * segment that was there all along was indistinguishable from one that took a second to appear.
   */
  it('can report a segment that was there all along, rather than charging it a recheck', async () => {
    const clock = drivenClock();
    const watch = new UnservedSegmentWatch(gatewayRefusing(0).ask, OPTIONS, clock.now, clock.wait);

    watch.observe('ref-there');
    await watch.settle();

    assert.deepEqual(watch.resolutions[0], { ref: 'ref-there', resolvedAfterMs: 0, asks: 1 });
  });

  it('reports a segment the gateway never served as null rather than as a number', async () => {
    const clock = drivenClock();
    const watch = new UnservedSegmentWatch(gatewayRefusing(Infinity).ask, OPTIONS, clock.now, clock.wait);

    watch.observe('ref-lost');
    await watch.settle();

    assert.equal(watch.resolutions[0].resolvedAfterMs, null);
    assert.equal(watch.resolutions[0].asks, 10, 'a 10s budget at 1s rechecks is ten asks');
  });

  // The whole point of the bound is that the load it adds is knowable before the run starts. The
  // whole point of counting what it turned away is that a distribution over what happened to fit,
  // reported as though it covered everything, is the failure this directory exists to avoid.
  it('turns away refusals past its concurrency and counts them rather than dropping them', async () => {
    const clock = drivenClock();
    const watch = new UnservedSegmentWatch(gatewayRefusing(Infinity).ask, OPTIONS, clock.now, clock.wait);

    for (const ref of ['a', 'b', 'c', 'd']) {
      watch.observe(ref);
    }

    assert.equal(watch.unwatched, 2, 'two slots means two watched and two turned away');
    await watch.settle();
    assert.equal(watch.resolutions.length, 2);
  });

  it('frees a slot once a watcher finishes', async () => {
    const clock = drivenClock();
    const watch = new UnservedSegmentWatch(gatewayRefusing(0).ask, OPTIONS, clock.now, clock.wait);

    watch.observe('first');
    await watch.settle();
    watch.observe('second');
    await watch.settle();

    assert.equal(watch.unwatched, 0);
    assert.deepEqual(
      watch.resolutions.map((r) => r.ref),
      ['first', 'second'],
    );
  });

  // The caller is the collection loop. A watcher that could throw into it would turn measuring a run
  // into a way to lose one.
  it('never throws into its caller when the gateway itself is broken', async () => {
    const clock = drivenClock();
    const exploding = async () => {
      throw new Error('connection refused');
    };
    const watch = new UnservedSegmentWatch(exploding, OPTIONS, clock.now, clock.wait);

    assert.doesNotThrow(() => watch.observe('ref-a'));
    await watch.settle();

    assert.equal(watch.resolutions[0].resolvedAfterMs, null);
  });
});
