import { Request } from 'express';

/**
 * Every ceiling the API applies to an inbound request, in one place, because they are chosen against
 * each other rather than individually.
 *
 * The defaults are sized for real ingest and not for the tests: a broadcaster sends roughly one
 * segment every two seconds per stream, so 30 a minute is the working rate and `perStreamMax` is
 * several times that to leave a reconnect burst room. Tests drive a configured rate of their own
 * rather than trying to exceed these, which is also what the acceptance criterion asks for.
 */
export interface RequestLimits {
  windowMs: number;
  /** Ceiling across every caller, so the per-stream map cannot hold more keys than this per window. */
  globalMax: number;
  /** Ceiling for one stream id on the ingest route. */
  perStreamMax: number;
}

export const DEFAULT_REQUEST_LIMITS: RequestLimits = {
  windowMs: 60_000,
  globalMax: 6_000,
  perStreamMax: 300,
};

/**
 * Body ceilings. A segment is media and a control message is not, so they are far apart: 50MB is
 * roughly a minute of high-bitrate video in one part, and a control body that reaches even the JSON
 * default is malformed rather than large.
 */
export const MAX_SEGMENT_BODY = '50mb';
export const MAX_CONTROL_BODY = '100kb';

/**
 * The key the per-stream limit counts by. Bounded by S1.5 before this shipped: the limiter holds one
 * entry per distinct value, so an unvalidated header would have made this middleware the memory
 * exhaustion it exists to prevent.
 */
export function segmentRateKey(req: Request): string {
  const streamId = req.headers['x-stream-id'];
  return typeof streamId === 'string' ? streamId : '';
}

export const GLOBAL_RATE_KEY = 'all';
