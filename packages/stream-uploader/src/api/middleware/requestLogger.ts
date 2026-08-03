import { NextFunction, Request, Response } from 'express';

import { Logger } from '../../libs/Logger.js';
import { redactUrlSecrets } from '../../utils/urlSecrets.js';

const logger = Logger.getInstance();

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    // Redacted, because the SRS webhook credential travels in the URL and this line outlives the
    // request. Everything else that writes a URL down has the same obligation.
    logger.info(`[HTTP] ${req.method} ${redactUrlSecrets(req.originalUrl)} ${res.statusCode} ${duration}ms`);
  });

  next();
}
