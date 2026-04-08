import { NextFunction, Request, Response } from 'express';

import { Logger } from '../../libs/Logger.js';

const logger = Logger.getInstance();

export interface ApiErrorResponse {
  ok: false;
  error: string;
  statusCode: number;
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly retryAfter?: string,
  ) {
    super(message);
  }
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

  logger.error(`[API] Unhandled error: ${err.message}`);

  const response: ApiErrorResponse = {
    ok: false,
    error: 'Internal server error',
    statusCode: 500,
  };

  res.status(500).json(response);
}
