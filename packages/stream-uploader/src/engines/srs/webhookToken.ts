import { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

/**
 * Query parameter carrying the SRS webhook credential.
 *
 * A query parameter rather than a header because SRS offers no other channel: its `http_hooks`
 * directives take a bare URL, with no HMAC over the body and no way to add a header. So the secret
 * travels in the URL, and everything that handles URLs has to know that. See `redactWebhookToken`.
 */
export const SRS_WEBHOOK_TOKEN_PARAM = 'token';

/**
 * Minimum length, matching the API token's. Short enough to guess is short enough to guess whichever
 * endpoint it guards, and this one reaches the same stamp-spending path.
 */
export const MIN_SRS_WEBHOOK_TOKEN_LENGTH = 32;

/**
 * The characters a token may use. Restricted to those that survive a URL without escaping, so an
 * operator cannot configure a secret that SRS then sends in a form the uploader will not match.
 */
const URL_SAFE_TOKEN = /^[A-Za-z0-9\-._~]+$/;

export function assertUsableWebhookToken(token: string): void {
  if (token.length < MIN_SRS_WEBHOOK_TOKEN_LENGTH) {
    throw new Error(`SRS_WEBHOOK_TOKEN must be at least ${MIN_SRS_WEBHOOK_TOKEN_LENGTH} characters`);
  }
  if (!URL_SAFE_TOKEN.test(token)) {
    throw new Error(
      'SRS_WEBHOOK_TOKEN must contain only unreserved URL characters (A-Z a-z 0-9 - . _ ~), ' +
        'because anything else changes shape in a URL and would reject every webhook',
    );
  }
}

/**
 * Whether the request carries the configured webhook token.
 *
 * Constant-time, for the same reason the API gate is: a comparison that returns on the first
 * differing byte leaks how much of the secret the caller already has. An empty configured token
 * rejects rather than disabling the check, which is the SEC-3 lesson: the empty string is a value
 * anyone can supply.
 */
export function hasValidWebhookToken(req: Request, expectedToken: string): boolean {
  if (!expectedToken) {
    return false;
  }

  const presented = req.query[SRS_WEBHOOK_TOKEN_PARAM];
  if (typeof presented !== 'string') {
    return false;
  }

  const a = Buffer.from(presented, 'latin1');
  const b = Buffer.from(expectedToken, 'latin1');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The same URL with the token replaced, for anything that writes a URL somewhere it outlives the
 * request. The secret is in the URL by necessity, so every log line, error message and metric label
 * carrying a URL is a place it leaks.
 */
export function redactWebhookToken(url: string): string {
  return url.replace(
    new RegExp(`([?&]${SRS_WEBHOOK_TOKEN_PARAM}=)[^&]*`, 'gi'),
    (_match, prefix: string) => `${prefix}REDACTED`,
  );
}
