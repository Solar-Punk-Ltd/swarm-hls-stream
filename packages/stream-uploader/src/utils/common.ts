import { BeeResponseError } from '@ethersphere/bee-js';

import { Logger } from '../libs/Logger.js';

const logger = Logger.getInstance();

export function sleep(delay: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

/**
 * Log-safe message for any thrown value. A non-Error throw keeps what it carries, a raw string or
 * an object's own `message`, instead of collapsing to a placeholder that hides what failed.
 *
 * Never throws. `String()` rejects a value with no prototype (`Object.create(null)`), and every
 * caller is a catch block or a rejection handler, where a second throw would replace the error
 * being reported with a confusing one from the logging itself.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null) {
    const { message } = error as { message?: unknown };
    if (typeof message === 'string' && message !== '') {
      return message;
    }
  }

  try {
    return String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

/**
 * Bee's two answers for a feed with nothing to read: 404 the topic was never written to, 503 the
 * topic exists and holds no update yet.
 *
 * Neither is a failure to a reader asking what is at the head, and both have to be told apart from
 * a read that failed, because a caller that treats "I could not tell" as "there is nothing there"
 * publishes over whatever is really in the feed.
 *
 * ⚠️ 503 is also in `RETRYABLE_HTTP_STATUSES`, so a caller wrapping its read in
 * {@link retryUntilDeadlineAsync} has to ask this **inside** the retried function. Asked outside,
 * an empty feed spends the whole retry window before answering a question that was settled on the
 * first attempt.
 *
 * ⛔⛔ **Not for a reader that already knows the feed is non-empty.** This answers "could the feed be
 * empty" for a caller with nothing else to go on. `StreamUploader.readManifestFeedHead` has something
 * else: it runs only for a stream holding a SOC index it wrote itself, so an empty feed is already
 * ruled out and a 503 there is a warming node rather than an answer. That path uses its own
 * `isFeedNeverWritten`, which takes 404 alone. Taking 503 there republished a paid-for recording.
 */
export function isFeedAbsent(error: unknown): boolean {
  return error instanceof BeeResponseError && (error.status === 404 || error.status === 503);
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function extractHttpStatus(error: unknown): number | undefined {
  if (error instanceof BeeResponseError) {
    return error.status;
  }
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

/**
 * The HTTP status of a failure this policy will not retry, and undefined for everything it will.
 *
 * ⛔ **The verdict and the status, from one place.** A caller that reports such a failure needs both,
 * and asking {@link isRetryableError} and then digging the status out again is how the two answers
 * drift apart. A bee node that is merely down throws carrying no status at all, so a reporter reading
 * a status of its own would name a postage batch nothing had refused, which is the exact confusion
 * `rungBatchRefused` exists to remove.
 */
export function nonRetryableStatus(error: unknown): number | undefined {
  const status = extractHttpStatus(error);
  return status !== undefined && !RETRYABLE_HTTP_STATUSES.has(status) ? status : undefined;
}

export function isRetryableError(error: unknown): boolean {
  return nonRetryableStatus(error) === undefined;
}

export function backoffDelayMs(attempt: number, baseDelayMs: number = 350, capDelayMs: number = 2000): number {
  return Math.min(capDelayMs, baseDelayMs * 2 ** attempt);
}

export function jitteredDelayMs(delayMs: number, random: () => number = Math.random): number {
  return delayMs / 2 + random() * (delayMs / 2);
}

export async function retryUntilDeadlineAsync<T>(
  fn: () => Promise<T>,
  deadlineMs: number,
  baseDelayMs: number = 350,
  capDelayMs: number = 2000,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableError(error) || Date.now() >= deadline) {
        throw error;
      }
      const sleepMs = Math.min(
        jitteredDelayMs(backoffDelayMs(attempt, baseDelayMs, capDelayMs)),
        deadline - Date.now(),
      );
      const message = getErrorMessage(error);
      logger.info(`Retrying in ~${Math.round(sleepMs)}ms (attempt ${attempt + 1}). Error: ${message}`);
      await sleep(sleepMs);
    }
  }
}
