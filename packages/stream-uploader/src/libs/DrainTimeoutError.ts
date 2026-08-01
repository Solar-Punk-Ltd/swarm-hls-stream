/**
 * The drain deadline elapsed before the finalize settled.
 *
 * A class rather than a message the caller string-matches, so that telling a timeout from a finalize
 * rejection does not depend on wording that a later edit is free to change. The distinction is the
 * only thing `GET /stream/status` can now say about a failed stop, since the text of the underlying
 * error is not something a response body may carry. See S1.7.
 */
export class DrainTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Drain timeout after ${timeoutMs}ms`);
    this.name = 'DrainTimeoutError';
  }
}
