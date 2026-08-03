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
    return decodeURIComponent(rawName.replace(/\+/g, ' '));
  } catch {
    return rawName;
  }
}

function isSecretParam(rawName: string): boolean {
  const name = decodedParamName(rawName).toLowerCase();
  return SECRET_PARAMS.includes(name);
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
      return isSecretParam(rawName) ? `${rawName}=${REDACTED_VALUE}` : pair;
    })
    .join('&');

  return `${url.slice(0, queryStart)}?${redacted}${fragment}`;
}
