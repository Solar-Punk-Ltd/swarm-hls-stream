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
 * anyone can supply. That guard is load-bearing rather than defensive: two empty strings encode to
 * two zero-length buffers, which `timingSafeEqual` reports as equal.
 *
 * `utf8`, not `latin1`. The API gate compares as latin1 because Node hands it header bytes already
 * latin1-decoded, so re-encoding recovers them exactly. A query parameter is percent-decoded as
 * UTF-8 instead, and latin1 keeps only the low byte of each code point, so every code point above
 * U+00FF would alias onto an ASCII byte and the check would accept spellings that are not the token.
 */
export function hasValidWebhookToken(req: Request, expectedToken: string): boolean {
  if (!expectedToken) {
    return false;
  }

  const presented = req.query[SRS_WEBHOOK_TOKEN_PARAM];
  if (typeof presented !== 'string') {
    return false;
  }

  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const REDACTED_VALUE = 'REDACTED';

/**
 * The parameter name as `req.query` sees it, so the redactor and the gate agree on which parameter
 * carries the credential. Express percent-decodes names before they reach `req.query`, and a `+` in
 * a query component means a space, so `%74oken` and `token` are one parameter to the gate. Matching
 * the raw text instead let a caller authenticate with a spelling the redactor did not recognise.
 */
function decodedParamName(rawName: string): string {
  try {
    return decodeURIComponent(rawName.replace(/\+/g, ' '));
  } catch {
    return rawName;
  }
}

/**
 * The same URL with the token replaced, for anything that writes a URL somewhere it outlives the
 * request. The secret is in the URL by necessity, so every log line, error message and metric label
 * carrying a URL is a place it leaks.
 *
 * The invariant: this must redact at least every URL the gate accepts. It is deliberately wider,
 * matching the name case-insensitively where `req.query` is case-sensitive, because over-redacting a
 * parameter that could never carry the credential costs nothing.
 *
 * It does not redact a token placed outside the query string, in a path segment for example. Such a
 * request is rejected, so reaching that state means presenting a credential you already hold.
 */
export function redactWebhookToken(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return url;
  }

  const afterQuery = url.slice(queryStart + 1);
  const hashStart = afterQuery.indexOf('#');
  const query = hashStart === -1 ? afterQuery : afterQuery.slice(0, hashStart);
  const fragment = hashStart === -1 ? '' : afterQuery.slice(hashStart);

  const redacted = query
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      if (equals === -1) {
        return pair;
      }
      const rawName = pair.slice(0, equals);
      const isTokenParam = decodedParamName(rawName).toLowerCase() === SRS_WEBHOOK_TOKEN_PARAM;
      return isTokenParam ? `${rawName}=${REDACTED_VALUE}` : pair;
    })
    .join('&');

  return `${url.slice(0, queryStart)}?${redacted}${fragment}`;
}
