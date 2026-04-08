import { NextFunction, Request, Response } from 'express';

import { Logger } from '../../libs/Logger.js';

const logger = Logger.getInstance();

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });

  next();
}
