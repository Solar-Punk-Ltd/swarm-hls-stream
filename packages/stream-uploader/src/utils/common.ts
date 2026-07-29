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

export function isRetryableError(error: unknown): boolean {
  const status = extractHttpStatus(error);
  if (status === undefined) {
    return true;
  }
  return RETRYABLE_HTTP_STATUSES.has(status);
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
