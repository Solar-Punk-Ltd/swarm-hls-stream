import { setTimeout as sleep } from 'node:timers/promises';

const POLL_INTERVAL_MS = 10;

/**
 * Polls until the condition holds, and throws when it never does.
 *
 * Returning quietly on timeout made an expired wait indistinguishable from a satisfied one, so a test
 * could spend a whole deadline on something that was never going to happen and carry on to assert
 * something else. Two did, and those two were ten of this suite's fourteen seconds. Under mutation
 * that is multiplied by the mutant count, which is how ten seconds became fifty minutes.
 *
 * Be generous with `timeoutMs`. A satisfied wait returns at the poll it is satisfied on, so a large
 * deadline costs nothing when the condition holds and is the difference between a suite that survives
 * a loaded machine and one that fails 6 runs in 8.
 */
export async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
  }
  if (!condition()) {
    throw new Error(
      `waited ${Date.now() - startedAt}ms of a ${timeoutMs}ms budget for \`${condition.toString()}\`, ` +
        'which never became true',
    );
  }
}

/**
 * Waits out a window in which something must NOT happen. Distinct from `waitFor` because the two read
 * alike at the call site and behave oppositely: this one is meant to reach its deadline, so it stays
 * short, while a `waitFor` that reaches its deadline is a failure.
 */
export async function waitAndConfirmNothingHappened(stillTrue: () => boolean, windowMs: number): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (stillTrue() && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
  }
}
