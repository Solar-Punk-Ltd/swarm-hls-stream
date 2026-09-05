export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  label: string;
  /**
   * Injected so a test drives the polling window instead of waiting it out.
   *
   * Same shape `pollConfiguredStamp` in `host.ts` takes, and for the same reason: the bounds below
   * are measured in minutes and a case that spent them would cost more than it proves.
   */
  clock?: { now: () => number; wait: (ms: number) => Promise<void> };
}

/** The wall clock and a real sleep, which is what every wait outside a unit test runs on. */
const REAL_CLOCK = { now: () => Date.now(), wait: sleep };

/**
 * How many reads in a row have to fail before a wait calls the instrument dead rather than flaky.
 *
 * ⭐ Generous on purpose. The drain and outage waits poll every three seconds, so twenty in a row is
 * a read that has not answered once across a stretch far longer than any hiccup this tolerance was
 * built for. One throw in eighty polls is what it exists for, and that keeps its whole ceiling.
 */
const CONSECUTIVE_THROW_LIMIT = 20;

/**
 * How long a wait puts up with a run of failed reads before the limit above may refuse.
 *
 * ⭐ Generous from the other side. A stack that is still coming up answers nothing for the opening
 * stretch of some waits, and refusing in that window would name a dead instrument for a service that
 * had simply not started yet. Past a minute, a read that has not worked once is not warming up.
 */
const THROW_GRACE_MS = 60_000;

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
 *
 * ⛔⛔ And that tolerance is bounded, by {@link CONSECUTIVE_THROW_LIMIT} throws in a row once
 * {@link THROW_GRACE_MS} has passed since the wait began. Owner ruling of 2026-09-05. Without it a
 * read that never worked at all spends the whole ceiling before anyone hears about it, which on a
 * four minute wait is four minutes of a paid broadcast bought to learn that an ssh target is
 * refusing connections. A poll that answered, true or false, starts the run of throws again.
 */
export async function waitFor(condition: () => Promise<boolean>, opts: WaitOptions): Promise<void> {
  const clock = opts.clock ?? REAL_CLOCK;
  const startedAt = clock.now();
  const deadline = startedAt + opts.timeoutMs;
  let polls = 0;
  let threw = 0;
  let threwInARow = 0;
  let lastError: Error | null = null;

  for (;;) {
    polls++;
    try {
      if (await condition()) {
        return;
      }
      threwInARow = 0;
    } catch (error) {
      if (error instanceof StopWaiting) {
        throw error;
      }
      threw++;
      threwInARow++;
      lastError = error as Error;
    }
    const elapsedMs = clock.now() - startedAt;
    if (threwInARow >= CONSECUTIVE_THROW_LIMIT && elapsedMs >= THROW_GRACE_MS) {
      throw new Error(
        `waitFor gave up ${elapsedMs}ms in, on ${threwInARow} reads in a row that threw rather than ` +
          `answering: ${opts.label}. Nothing has answered since, so this is an instrument that is down ` +
          `rather than a product that did nothing, and the rest of the ${opts.timeoutMs}ms ceiling would ` +
          `only spend it. The last one said: ${lastError?.message}`,
        {
          cause: lastError ?? undefined,
        },
      );
    }
    if (clock.now() >= deadline) {
      throw new Error(
        `waitFor timed out after ${opts.timeoutMs}ms: ${opts.label}${describeThrows(polls, threw, lastError)}`,
        {
          cause: lastError ?? undefined,
        },
      );
    }
    await clock.wait(opts.intervalMs);
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
