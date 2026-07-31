/**
 * How long any client request may wait before it is given up on. Node and browsers both leave
 * `fetch` with no timeout of its own, so a gateway that accepts the connection and then goes silent
 * holds the request open until the tab is closed.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** Raised in place of a bare `AbortError` so a caller can tell a timeout from a cancelled request. */
export class FetchTimeoutError extends Error {
  constructor(readonly url: string, readonly timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
  }
}

export interface FetchWithTimeoutOptions {
  timeoutMs?: number;
  /** A caller's own cancellation, typically a React effect's unmount signal. Composed, not replaced. */
  signal?: AbortSignal;
  /** Injected only by tests. Production always uses the global. */
  fetcher?: typeof fetch;
}

/**
 * `fetch` with a bounded wait, composing the caller's own cancellation signal rather than replacing
 * it, so an unmount still aborts in flight work.
 *
 * Deliberately built from `AbortController` and `setTimeout` rather than `AbortSignal.timeout` and
 * `AbortSignal.any`, which are the obvious tools and are both newer than this bundle's declared
 * `build.target`: `AbortSignal.timeout` lands in Safari 16 against a target of Safari 14, so it
 * would throw at runtime on exactly the engines the target promises to support, and nothing in the
 * build would say so. The timeout is tracked with a local flag rather than an abort reason for the
 * same reason, since the reason argument to `abort()` is no older.
 */
export async function fetchWithTimeout(url: string, options: FetchWithTimeoutOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal, fetcher = fetch } = options;

  if (signal?.aborted) {
    throw signal.reason ?? new Error('Request was cancelled before it started');
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetcher(url, { signal: controller.signal });
  } catch (error) {
    // The abort looks identical either way at this point, so the flag is what separates "the server
    // went silent" from "the component unmounted". Only the first is worth an operator's attention.
    if (timedOut) {
      throw new FetchTimeoutError(url, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
