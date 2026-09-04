export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  label: string;
}

/**
 * A condition saying its wait can no longer succeed, so {@link waitFor} gives up on the spot.
 *
 * ⛔ The one throw {@link waitFor} does not treat as a failed read. `waitForAnnouncement` in
 * `bench/run.ts` reads whether the publisher process is still alive, and a publisher that died on
 * its own arguments is knowable two seconds in: without an immediate give-up the run spends its
 * whole ninety second ceiling waiting for an ingest that can never arrive and then reports a timeout,
 * which names the uploader for an encoder that never started.
 *
 * Anything else a condition throws is a read that failed rather than a verdict, so the distinction
 * lives with whoever throws, which is the only place that knows which of the two it has.
 */
export class StopWaiting extends Error {}

/**
 * Poll `condition` until it returns true or the timeout elapses (then throw with `label`).
 *
 * ⛔⛔ A condition that throws counts as "not yet" and the poll carries on. Every drain and outage
 * suite puts a remote read inside its condition and polls for up to four minutes, so one dropped ssh
 * connection or one partial `docker logs` used to abort the wait with a raw transport error, which
 * reds a paid broadcast as a product failure. {@link StopWaiting} is the exception, for a condition
 * that knows its wait can no longer succeed.
 *
 * ⛔ How many polls threw is in the timeout message beside the last error, so a genuinely broken read
 * is still visible and is told apart from a blip. One throw in eighty polls is a hiccup this
 * tolerance exists for. Eighty in eighty is a condition that was never evaluated, and a timeout that
 * said only its label would read as a product that never did the thing.
 */
export async function waitFor(condition: () => Promise<boolean>, opts: WaitOptions): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  let polls = 0;
  let threw = 0;
  let lastError: Error | null = null;

  for (;;) {
    polls++;
    try {
      if (await condition()) {
        return;
      }
    } catch (error) {
      if (error instanceof StopWaiting) {
        throw error;
      }
      threw++;
      lastError = error as Error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitFor timed out after ${opts.timeoutMs}ms: ${opts.label}${describeThrows(polls, threw, lastError)}`,
        {
          cause: lastError ?? undefined,
        },
      );
    }
    await sleep(opts.intervalMs);
  }
}

/** Nothing at all where every poll was answered, so an untroubled timeout reads exactly as it always did. */
function describeThrows(polls: number, threw: number, lastError: Error | null): string {
  if (threw === 0 || lastError === null) {
    return '';
  }
  return (
    `. The condition threw on ${threw} of ${polls} polls rather than answering, which is a read that ` +
    `failed rather than a product that did nothing. The last one said: ${lastError.message}`
  );
}
