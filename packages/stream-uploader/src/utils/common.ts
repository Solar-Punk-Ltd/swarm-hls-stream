import { BeeResponseError } from '@ethersphere/bee-js';
import { BEE_ANSWER_LIMIT } from '@swarm-hls-stream/shared';

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

/** What a cut answer ends with, so a reader can tell one from an answer bee ended there itself. */
const ANSWER_CUT_MARKER = '...';

/**
 * Bee's words cut to what a log line carries, marked where they were cut.
 *
 * ⛔ **The bound belongs to the line and is declared with it**, in `rungBatchRefused`'s own package,
 * and this is the only place that applies it. There were two constants named `BEE_ANSWER_LIMIT` until
 * 2026-09-05, 200 here and 300 in the composer, and this one ran first: the composer's bound never
 * fired, the marker never reached a line, and an answer that had been cut read as bee's whole answer.
 * Which words bee names a full postage batch with is the one thing the answer is carried for, so a
 * cut that says nothing about itself is the worst shape available.
 */
function withinAnswerLimit(answer: string): string {
  return answer.length > BEE_ANSWER_LIMIT ? `${answer.slice(0, BEE_ANSWER_LIMIT)}${ANSWER_CUT_MARKER}` : answer;
}

/**
 * Bee's own words for a failure, rather than the HTTP client's, bounded by {@link BEE_ANSWER_LIMIT}.
 *
 * ⛔⛔⛔ **`error.message` on a bee failure is axios's sentence, not bee's.** bee-js builds its
 * `BeeResponseError` with the client's message and puts the response body in a separate field
 * nothing was reading, so a line meant to record what bee answered was recording "Request failed
 * with status code 402", which is a restatement of the status beside it. The whole point of carrying
 * the answer is that which family bee names a full postage batch with is not written down anywhere
 * in this repo, and a sitting that reports the client's words leaves that question exactly as open as
 * it found it.
 *
 * Never throws: every caller is reporting some other failure and a throw here would replace it.
 */
export function beeAnswer(error: unknown): string {
  return withinAnswerLimit(unboundedBeeAnswer(error));
}

/**
 * Bee's answer at whatever length it arrived.
 *
 * Bee answers a refusal as JSON with its own `message`, so that is preferred, then a body that is
 * already a string, then the client's sentence as the last resort.
 */
function unboundedBeeAnswer(error: unknown): string {
  const body = error instanceof BeeResponseError ? error.responseBody : undefined;

  if (typeof body === 'string' && body.trim() !== '') {
    return body;
  }

  if (typeof body === 'object' && body !== null) {
    const { message } = body as { message?: unknown };
    if (typeof message === 'string' && message.trim() !== '') {
      return message;
    }
    try {
      return JSON.stringify(body);
    } catch {
      return getErrorMessage(error);
    }
  }

  return getErrorMessage(error);
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
