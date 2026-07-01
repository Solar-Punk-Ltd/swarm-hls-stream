import { BeeResponseError } from '@ethersphere/bee-js';

import { ErrorHandler } from '../libs/ErrorHandler.js';
import { Logger } from '../libs/Logger.js';

const logger = Logger.getInstance();
const errorHandler = ErrorHandler.getInstance();

export function sleep(delay: number) {
  return new Promise(resolve => {
    setTimeout(resolve, delay);
  });
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

export async function retryAwaitableAsync<T>(
  fn: () => Promise<T>,
  retries: number = 10,
  delay: number = 350,
): Promise<T> {
  return new Promise((resolve, reject) => {
    fn()
      .then(resolve)
      .catch(error => {
        if (retries > 0 && isRetryableError(error)) {
          logger.info(`Retrying... Attempts left: ${retries}. Error: ${error.message}`);
          setTimeout(() => {
            retryAwaitableAsync(fn, retries - 1, delay)
              .then(resolve)
              .catch(reject);
          }, delay);
        } else {
          errorHandler.handleError(error, 'Utils.retryAwaitableAsync');
          reject(error);
        }
      });
  });
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
      const delay = jitteredDelayMs(backoffDelayMs(attempt, baseDelayMs, capDelayMs));
      const message = error instanceof Error ? error.message : String(error);
      logger.info(`Retrying in ~${Math.round(delay)}ms (attempt ${attempt + 1}). Error: ${message}`);
      await sleep(delay);
    }
  }
}
