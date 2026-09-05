import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StopWaiting, waitFor } from '../src/harness/wait.js';

/**
 * ⛔⛔⛔ Why a wait has to survive a read that failed.
 *
 * Every drain and outage suite puts a remote read inside its condition, `docker logs` over ssh or a
 * curl of a service port, and polls for up to four minutes. Before this, one dropped connection or
 * one partial answer aborted the wait with the raw transport error, so a paid broadcast went red
 * naming the product for a hiccup in how the harness was looking at it.
 *
 * ⛔ And why one throw must still get through. `waitForAnnouncement` in `bench/run.ts` reads whether
 * the publisher process is alive, and a publisher that died on its own arguments is knowable two
 * seconds in. Polling that out spends the whole ceiling on an ingest that can never arrive and then
 * reports a timeout against the uploader. That is what {@link StopWaiting} is for.
 *
 * ⚠️ Nothing here asserts on elapsed wall time. The conditions decide when a wait ends, so a loaded
 * machine changes how long these take and never what they conclude.
 */

/** A tight budget, because every case below is decided by its condition rather than by the clock. */
const TIMEOUT_MS = 40;
const INTERVAL_MS = 1;

/** Long enough that a recovering read is never raced by the deadline on a loaded machine. */
const PATIENT_TIMEOUT_MS = 30_000;

const opts = (over: { timeoutMs?: number; label?: string; clock?: FakeClock } = {}) => ({
  timeoutMs: over.timeoutMs ?? TIMEOUT_MS,
  intervalMs: INTERVAL_MS,
  label: over.label ?? 'the thing under test happens',
  clock: over.clock,
});

interface FakeClock {
  now: () => number;
  wait: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
}

/**
 * A clock the case drives, so a bound measured in minutes is asserted in no wall time at all.
 *
 * The wait's own interval advances it, and a condition advances it by however long that read is
 * meant to have taken, which is the arithmetic a real poll would have done with none of the drift.
 */
function fakeClock(): FakeClock {
  let atMs = 0;
  const advance = (ms: number) => {
    atMs += ms;
  };
  return {
    now: () => atMs,
    wait: async (ms: number) => advance(ms),
    advance,
  };
}

/**
 * How long one failed remote read takes on the injected clock.
 *
 * An ssh read that hangs and then fails costs seconds rather than milliseconds, and at this length
 * twenty of them in a row are well past the minute the bound waits out before it may refuse.
 */
const FAILED_READ_MS = 3_500;

/** A read that fails quickly, so twenty of them in a row are nowhere near that minute. */
const QUICK_FAILED_READ_MS = 100;

/** Wide enough that nothing below ends on it, so each case is decided by the bound it is about. */
const UNREACHED_TIMEOUT_MS = 3_600_000;

/**
 * Far more failed reads than the bound allows before the condition finally answers.
 *
 * ⚠️ Load-bearing, because a wait with no bound at all would otherwise hang the case rather than
 * fail it. Every case that expects a refusal asserts it arrived long before this recovery.
 */
const EVENTUAL_RECOVERY_POLL = 200;

describe('waitFor', () => {
  it('returns on the first true answer without polling again', async () => {
    let asked = 0;

    await waitFor(async () => {
      asked++;
      return true;
    }, opts());

    assert.equal(asked, 1);
  });

  it('times out with its label when the condition stays false', async () => {
    await assert.rejects(
      waitFor(async () => false, opts({ label: 'four rungs publish' })),
      /four rungs publish/,
    );
  });

  /**
   * ⛔ The finding. A read that threw is not an answer, so the poll carries on and a wait outlives a
   * dropped ssh connection instead of failing the run on one.
   */
  it('treats a throw as not yet and returns once the read recovers', async () => {
    let asked = 0;

    await waitFor(async () => {
      asked++;
      if (asked < 3) {
        throw new Error('ssh_exchange_identification: Connection closed by remote host');
      }
      return true;
    }, opts({ timeoutMs: PATIENT_TIMEOUT_MS }));

    assert.equal(asked, 3);
  });

  /**
   * ⛔ A read that never worked has to stay visible. Every poll throwing means the condition was
   * never evaluated, and a timeout saying only its label would read as a product that did nothing.
   */
  it('names the last error and how many polls threw, so a broken read is not read as a broken product', async () => {
    await assert.rejects(
      waitFor(async () => {
        throw new Error('ssh exited 255');
      }, opts({ label: 'the master drops the drained rung' })),
      (error: Error) => {
        assert.match(error.message, /the master drops the drained rung/);
        assert.match(error.message, /ssh exited 255/);
        assert.match(error.message, /threw on \d+ of \d+ polls/);
        return true;
      },
    );
  });

  it('carries the read that failed as the cause, so the stack survives the timeout', async () => {
    const broken = new Error('curl exited 7');

    await assert.rejects(
      waitFor(async () => {
        throw broken;
      }, opts()),
      (error: Error) => {
        assert.equal(error.cause, broken);
        return true;
      },
    );
  });

  /** ⚠️ An untroubled timeout reads exactly as it always did, so no existing red gains a sentence. */
  it('says nothing about throws when every poll was answered', async () => {
    await assert.rejects(
      waitFor(async () => false, opts()),
      (error: Error) => {
        assert.doesNotMatch(error.message, /threw/);
        return true;
      },
    );
  });

  /**
   * ⛔ The one throw that is a verdict rather than a failed read, given up on immediately so a run
   * that can no longer succeed does not spend its whole ceiling proving it.
   */
  it('gives up at once on a condition that says its wait can no longer succeed', async () => {
    const cannotHappen = new StopWaiting('the publisher exited before anything was ingested');
    let asked = 0;

    await assert.rejects(
      waitFor(async () => {
        asked++;
        throw cannotHappen;
      }, opts({ timeoutMs: PATIENT_TIMEOUT_MS })),
      (error: Error) => {
        assert.equal(error, cannotHappen);
        return true;
      },
    );
    assert.equal(asked, 1);
  });
});

/**
 * ⛔⛔⛔ Why a wait that survives a failed read still has to stop.
 *
 * The tolerance above has no bound of its own, and a read that never once worked therefore spends
 * the whole ceiling before it says so. Four minutes of a paid broadcast go on an ssh target that is
 * refusing connections, and the run then reports a timeout against the product. The owner ruled on
 * 2026-09-05 that a dead instrument is named in about a minute instead.
 *
 * ⛔ Both halves are needed and neither alone. A run of throws with no minute behind it is a stack
 * still coming up, and a minute with an answer somewhere in it is a read that works.
 *
 * ⚠️ Every case here is on the injected clock, so a bound measured in minutes costs no wall time.
 */
describe('waitFor, once a read has stopped working altogether', () => {
  /** One short of the bound, which is the boundary the generous number is chosen at. */
  it('waits out nineteen failed reads in a row and returns when the twentieth answers', async () => {
    const clock = fakeClock();
    let asked = 0;

    await waitFor(async () => {
      asked++;
      clock.advance(FAILED_READ_MS);
      if (asked > 19) {
        return true;
      }
      throw new Error('ssh_exchange_identification: Connection closed by remote host');
    }, opts({ timeoutMs: UNREACHED_TIMEOUT_MS, clock }));

    assert.equal(asked, 20, 'a run of failed reads one short of the bound has to keep the whole ceiling');
  });

  /** ⛔ The minute is the other half. A stack coming up answers nothing for a while and is not dead. */
  it('keeps waiting on twenty failed reads in a row that took under a minute between them', async () => {
    const clock = fakeClock();
    let asked = 0;

    await waitFor(async () => {
      asked++;
      clock.advance(QUICK_FAILED_READ_MS);
      if (asked > 25) {
        return true;
      }
      throw new Error('connection refused');
    }, opts({ timeoutMs: UNREACHED_TIMEOUT_MS, clock }));

    assert.equal(asked, 26, 'twenty quick failures inside a minute are a stack coming up, not a dead read');
    assert.ok(clock.now() < 60_000, 'this case has to stay inside the minute it is about');
  });

  /** ⛔ The finding. Twenty in a row and a minute gone is an instrument nobody is going to fix by waiting. */
  it('refuses after twenty failed reads in a row once a minute has passed, naming the count and the cause', async () => {
    const clock = fakeClock();
    const broken = new Error('ssh exited 255');
    let asked = 0;

    await assert.rejects(
      waitFor(async () => {
        asked++;
        clock.advance(FAILED_READ_MS);
        if (asked >= EVENTUAL_RECOVERY_POLL) {
          return true;
        }
        throw broken;
      }, opts({ timeoutMs: UNREACHED_TIMEOUT_MS, label: 'the master drops the drained rung', clock })),
      (error: Error) => {
        assert.match(error.message, /the master drops the drained rung/);
        assert.match(error.message, /20 /, 'the refusal has to say how many reads in a row threw');
        assert.match(error.message, /ssh exited 255/);
        assert.equal(error.cause, broken, 'the read that failed has to survive as the cause');
        return true;
      },
    );
    assert.equal(asked, 20, 'the wait polled past the bound it was supposed to refuse at');
  });

  /**
   * ⛔ Consecutive, never a total. A four minute wait over a flaky link drops a connection now and
   * then and answers in between, and counting those together would refuse a read that is working.
   */
  it('starts the count again from a poll that answered, however many threw before it', async () => {
    const clock = fakeClock();
    let asked = 0;

    await waitFor(async () => {
      asked++;
      clock.advance(FAILED_READ_MS);
      if (asked === 20) {
        return false;
      }
      if (asked > 39) {
        return true;
      }
      throw new Error('ssh exited 255');
    }, opts({ timeoutMs: UNREACHED_TIMEOUT_MS, clock }));

    assert.equal(asked, 40, 'nineteen throws either side of one answer is a link that works, not a dead read');
  });
});
