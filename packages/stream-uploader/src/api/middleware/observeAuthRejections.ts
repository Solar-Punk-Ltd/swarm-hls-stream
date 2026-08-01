import { NextFunction, Request, RequestHandler, Response } from 'express';

const HTTP_UNAUTHORIZED = 401;

/**
 * Counts every request a credential gate refused, wherever in the stack the refusal happens.
 *
 * Observed at the response rather than reported by each gate, because the gates do not share a
 * mounting point: `requireAuth` sits on `/stream` and `/metrics`, the SRS gate is mounted twice by
 * its own plugin, and OME signs the request body so its check cannot run until the body is parsed
 * and lives inside the router. That last one is the `on_publish` path, which is precisely the one
 * OBS-15 is about, so a wrapper around the mounted gates would have missed the case it was built for.
 *
 * Mounted ahead of every gate, so the `finish` listener is attached before anything can answer 401.
 * `requestLogger` runs before it and only reads. Every 401 this service emits comes from a credential
 * gate: no route answers 401 for any other reason, and the rejection body is a fixed `Unauthorized`
 * that carries nothing about what was wrong.
 */
export function createAuthRejectionObserver(onRejected: () => void): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      if (res.statusCode === HTTP_UNAUTHORIZED) {
        onRejected();
      }
    });
    next();
  };
}
