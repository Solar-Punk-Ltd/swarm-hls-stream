import { PUBLISH_KEY_PARAM } from './publishKey.js';

/**
 * Query parameter carrying the SRS webhook credential.
 *
 * A query parameter rather than a header because SRS offers no other channel: its `http_hooks`
 * directives take a bare URL, with no HMAC over the body and no way to add a header. So the secret
 * travels in the URL, and everything that handles URLs has to know that.
 */
export const SRS_WEBHOOK_TOKEN_PARAM = 'token';

/**
 * Every query parameter this service treats as a secret. Both arrive in URLs because the systems that
 * send them offer no other channel, so redaction is not a nicety here: a URL reaching a log is the
 * ordinary case rather than the unlucky one.
 */
const SECRET_PARAMS: readonly string[] = [SRS_WEBHOOK_TOKEN_PARAM, PUBLISH_KEY_PARAM];

const REDACTED_VALUE = 'REDACTED';

/**
 * The parameter name as `req.query` sees it, so a redactor and a gate agree on which parameter carries
 * a credential. Express percent-decodes names before they reach `req.query`, and a `+` in a query
 * component means a space, so `%74oken` and `token` are one parameter to the gate. Matching the raw
 * text instead let a caller authenticate with a spelling the redactor did not recognise.
 */
function decodedParamName(rawName: string): string {
  try {
    return decodeURIComponent(stripUrlWhitespace(rawName).replace(/\+/g, ' '));
  } catch {
    return rawName;
  }
}

/**
 * ASCII tab, newline and carriage return, which the WHATWG URL parser removes from its input before
 * parsing anything.
 *
 * That makes `?k\tey=` the parameter `key` to `new URL(...).searchParams`, so it authenticates, while
 * a matcher that does not strip them sees `k\tey` and leaves the value in the log. The invariant
 * below is that this must redact at least every URL the check accepts, and it silently stopped
 * holding when the redactor was generalised from the SRS token to the publish key: the token's gate
 * is `req.query`, which Express fills without any such stripping, so the old narrower matcher was
 * correct for the only secret it guarded.
 */
function stripUrlWhitespace(value: string): string {
  return value.replace(/[\t\n\r]/g, '');
}

function isSecretParam(rawName: string): boolean {
  const name = decodedParamName(rawName).toLowerCase();
  return SECRET_PARAMS.includes(name);
}

/**
 * Whether a parameter's *value* is itself a URL carrying a credential.
 *
 * OME takes an entire publish URL as an SRT `streamid`, so `?streamid=srt://host/app/stream?key=...`
 * is one top-level parameter whose value contains the secret. A redactor that only matches top-level
 * names leaves that whole value intact, and `parseAppStream` supports exactly that shape and names
 * the URL in all three of its failure paths, which a broadcaster reaches by mistyping their stream.
 *
 * Matched on the decoded value so the percent-encoded spelling, which is the one that actually works
 * against OME, is caught too.
 */
function carriesNestedSecret(rawValue: string): boolean {
  let decoded = rawValue;
  try {
    decoded = decodeURIComponent(rawValue.replace(/\+/g, ' '));
  } catch {
    // An undecodable value is screened as it arrived, which can only over-redact.
  }
  const haystack = stripUrlWhitespace(decoded).toLowerCase();
  return SECRET_PARAMS.some((param) => haystack.includes(`${param}=`));
}

/**
 * The same URL with every credential replaced, for anything that writes a URL somewhere it outlives
 * the request. These secrets are in URLs by necessity, so every log line, error message and metric
 * label carrying a URL is a place they leak.
 *
 * The invariant: this must redact at least every URL the corresponding check accepts. It is
 * deliberately wider, matching names case-insensitively where `req.query` is case-sensitive, because
 * over-redacting a parameter that could never carry a credential costs nothing.
 *
 * It does not redact a secret placed outside the query string, in a path segment for example. A
 * webhook shaped that way is rejected, so reaching that state means presenting a credential you
 * already hold. A publish key there is not a key at all, since both engines were measured delivering
 * it as a query parameter.
 */
export function redactUrlSecrets(url: string): string {
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
      if (isSecretParam(rawName)) {
        return `${rawName}=${REDACTED_VALUE}`;
      }
      // A value that is itself a URL carrying a credential, which is how OME's SRT `streamid` arrives.
      // Redacted whole rather than parsed apart, because what remains after removing the secret is a
      // stream name the log already prints elsewhere, and a partial parse is one more place to be
      // wrong about where a credential can hide.
      return carriesNestedSecret(pair.slice(equals + 1)) ? `${rawName}=${REDACTED_VALUE}` : pair;
    })
    .join('&');

  return `${url.slice(0, queryStart)}?${redacted}${fragment}`;
}
