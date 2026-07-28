import { BeeResponseError } from '@ethersphere/bee-js';

import { Logger } from '../libs/Logger.js';

const logger = Logger.getInstance();

export function sleep(delay: number) {
  return new Promise(resolve => {
    setTimeout(resolve, delay);
  });
}

/**
 * Log-safe message for any thrown value. Non-Error throws (a raw string, a rejected plain object)
 * keep their content instead of collapsing to a placeholder that hides what actually failed.
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      const sleepMs = Math.min(jitteredDelayMs(backoffDelayMs(attempt, baseDelayMs, capDelayMs)), deadline - Date.now());
      const message = getErrorMessage(error);
      logger.info(`Retrying in ~${Math.round(sleepMs)}ms (attempt ${attempt + 1}). Error: ${message}`);
      await sleep(sleepMs);
    }
  }
}
