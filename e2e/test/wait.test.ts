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

const opts = (over: { timeoutMs?: number; label?: string } = {}) => ({
  timeoutMs: over.timeoutMs ?? TIMEOUT_MS,
  intervalMs: INTERVAL_MS,
  label: over.label ?? 'the thing under test happens',
});

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
