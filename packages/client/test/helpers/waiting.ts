import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Polls until the predicate holds, and fails the test naming `what` when it never does.
 *
 * For what a timer does rather than a walk, such as a finished feed's watch, which asks on its own
 * interval: there is no walk to await, and a tick budget would have to guess how many intervals fit
 * in it. A satisfied wait returns at the poll it is satisfied on, so a generous `timeoutMs` costs
 * nothing when the condition holds.
 */
export async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(1);
  }
  assert.fail(`timed out waiting for ${what}`);
}
