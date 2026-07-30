import { NextFunction, Request, RequestHandler, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

import { Logger } from '../../libs/Logger.js';

const logger = Logger.getInstance();

/**
 * Short tokens are guessable and this gate is the only thing between an anonymous caller and an
 * endpoint that spends postage stamp money per request. Long enough that guessing is not the cheapest
 * attack, short enough to paste. Generate one with `openssl rand -hex 32`.
 */
export const MIN_AUTH_TOKEN_LENGTH = 32;

/**
 * RFC 7235's `token68`, the credential grammar a bearer token has to fit.
 *
 * Enforced at construction because the alternative is a service that starts and then rejects
 * everyone. A header value arrives latin1-decoded, so a token containing anything above U+00FF can
 * never be presented, and the operator sees only the same opaque 401 every caller gets.
 */
const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*$/;

/** `Bearer` is case-insensitive and RFC 7235 allows one or more spaces before the credential. */
const BEARER_SCHEME = /^bearer +/i;

function presentedToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) {
    return null;
  }

  const scheme = BEARER_SCHEME.exec(header);
  return scheme === null ? null : header.slice(scheme[0].length);
}

/**
 * Compared in constant time over the bytes as they arrived.
 *
 * `latin1` on both sides, because Node decodes header bytes as latin1 and re-encoding that as UTF-8
 * would compare a mangled copy against the original. `===` is not used at all: it returns as soon as
 * two bytes differ, so the time it takes leaks how much of the token a caller already has. The length
 * check is unavoidable and leaks only the length.
 */
function matches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'latin1');
  const b = Buffer.from(expected, 'latin1');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Bearer-token gate for the control and ingest routes.
 *
 * Mounted on the router rather than inside each handler, so a route added to that router later is
 * covered without whoever adds it remembering. It covers the prefix it is mounted on and nothing
 * else: `/health` is outside it deliberately, and the engine webhook routes under `/engines` carry
 * their own credential or, for SRS, none at all. See SEC-1 and S1.2.
 *
 * The rejection carries nothing back about what was wrong or what was asked for.
 */
export function createAuthMiddleware(expectedToken: string): RequestHandler {
  if (expectedToken.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new Error(`API_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters`);
  }
  if (!TOKEN68.test(expectedToken)) {
    throw new Error(
      'API_AUTH_TOKEN must contain only unreserved characters (A-Z a-z 0-9 - . _ ~ + /), ' +
        'because anything else cannot survive an HTTP header and would lock every caller out',
    );
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = presentedToken(req);

    if (presented === null || !matches(presented, expectedToken)) {
      // originalUrl, not path: express strips the mount prefix, so `req.path` here reads `/start`
      // rather than `/stream/start` and the line names a route that does not exist.
      logger.warn(`[Auth] Rejected unauthenticated ${req.method} ${req.originalUrl} from ${req.ip}`);
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  };
}
