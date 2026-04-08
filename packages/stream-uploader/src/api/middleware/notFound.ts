import { Request, Response } from 'express';

import { ApiErrorResponse } from './errorHandler.js';

export function notFound(_req: Request, res: Response): void {
  const response: ApiErrorResponse = {
    ok: false,
    error: 'Not found',
    statusCode: 404,
  };

  res.status(404).json(response);
}
