import { NextFunction, Request, RequestHandler, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

import { Logger } from '../../libs/Logger.js';

const logger = Logger.getInstance();

const BEARER_PREFIX = 'Bearer ';

/**
 * Short tokens are guessable and this gate is the only thing between an anonymous caller and an
 * endpoint that spends postage stamp money per request. Long enough that guessing is not the cheapest
 * attack, short enough to paste. Generate one with `openssl rand -hex 32`.
 */
export const MIN_AUTH_TOKEN_LENGTH = 32;

function presentedToken(req: Request): string | null {
  const header = req.get('authorization');
  // The scheme is case-insensitive per RFC 7235, so matching it exactly would reject a conforming
  // client. The token after it is not, and is compared byte for byte below.
  if (!header || header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX.toLowerCase()) {
    return null;
  }
  return header.slice(BEARER_PREFIX.length);
}

/**
 * Compared in constant time. `===` returns as soon as two bytes differ, so the time it takes leaks how
 * much of the token a caller already has, and a caller who can measure that can recover it one byte at
 * a time. The length check is unavoidable and leaks only the length.
 */
function matches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Bearer-token gate for the control and ingest routes.
 *
 * Mounted before the routers rather than inside each handler, so a route added later is covered by
 * construction instead of by whoever adds it remembering. The rejection carries nothing back about
 * what was wrong or what was asked for: a caller learns only that they are not authorised.
 */
export function createAuthMiddleware(expectedToken: string): RequestHandler {
  if (expectedToken.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new Error(`API_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters`);
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = presentedToken(req);

    if (presented === null || !matches(presented, expectedToken)) {
      logger.warn(`[Auth] Rejected unauthenticated ${req.method} ${req.path} from ${req.ip}`);
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  };
}
