import { NextFunction, Request, Response } from 'express';

import { Logger } from '../../libs/Logger.js';

const logger = Logger.getInstance();

export interface ApiErrorResponse {
  ok: false;
  error: string;
  statusCode: number;
}

export class ApiError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly retryAfter?: string) {
    super(message);
  }
}

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;

/**
 * What the caller is told for a request this service could not read. Written here rather than taken
 * from the parser, whose own text quotes the offending body back at whoever sent it.
 */
const CLIENT_ERROR_MESSAGES: Record<number, string> = {
  [HTTP_BAD_REQUEST]: 'Malformed request body',
  [HTTP_PAYLOAD_TOO_LARGE]: 'Request body too large',
  [HTTP_UNSUPPORTED_MEDIA_TYPE]: 'Unsupported content type or encoding',
};

/**
 * Whether a status an error declared is one this service will answer a caller with.
 *
 * Whole numbers only, rather than merely 4xx-shaped ones. `res.status()` throws a `TypeError` for a
 * fractional code, and a throw inside this handler is answered by express's own, which sends the
 * stack trace and the deployment's absolute paths to whoever provoked it.
 *
 * The `typeof` is what lets the comparisons compile against an `unknown`. `Number.isInteger` already
 * refuses everything that is not a number, so removing it changes nothing a test can observe.
 */
function isAnswerableClientStatus(declared: unknown): declared is number {
  return typeof declared === 'number' && Number.isInteger(declared) && declared >= 400 && declared < 500;
}

/**
 * The status a body-parser failure already carries, or `undefined` when the error is ours to own.
 *
 * Read off `expose`, which `http-errors` sets only for statuses that are safe to attribute to the
 * caller, rather than matched on the parser's `type` strings. A malformed or oversized body is the
 * sender's fault and has to be answered as such: as a 500 it was indistinguishable from a service
 * that had broken, and since these parsers run on routes with no gate in front of them, an anonymous
 * caller could drive both the 5xx rate and the ERROR log channel that operators alert on. See SEC-12.
 */
function clientErrorStatus(err: Error): number | undefined {
  const { status, statusCode, expose } = err as Error & {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
  };

  if (expose !== true) {
    return undefined;
  }

  const declared = typeof status === 'number' ? status : statusCode;

  return isAnswerableClientStatus(declared) ? declared : undefined;
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    const response: ApiErrorResponse = {
      ok: false,
      error: err.message,
      statusCode: err.statusCode,
    };

    if (err.retryAfter) {
      res.set('Retry-After', err.retryAfter);
    }

    res.status(err.statusCode).json(response);
    return;
  }

  const clientStatus = clientErrorStatus(err);
  if (clientStatus !== undefined) {
    // Warn and not error. A caller sending a body this service cannot read is not a fault of this
    // service, and logging it at error level is what let an anonymous caller fill the channel.
    logger.warn(`[API] Rejected an unreadable request: ${err.message}`);

    res.status(clientStatus).json({
      ok: false,
      error: CLIENT_ERROR_MESSAGES[clientStatus] ?? 'Bad request',
      statusCode: clientStatus,
    });
    return;
  }

  logger.error(`[API] Unhandled error: ${err.message}`);

  const response: ApiErrorResponse = {
    ok: false,
    error: 'Internal server error',
    statusCode: 500,
  };

  res.status(500).json(response);
}
