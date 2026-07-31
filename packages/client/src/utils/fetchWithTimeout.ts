/**
 * How long any client request may wait before it is given up on, headers and body together. Node and
 * browsers both leave `fetch` with no timeout of its own, so a gateway that accepts the connection
 * and then goes silent holds the request open until the tab is closed.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** Raised in place of a bare `AbortError` so a caller can tell a timeout from a cancelled request. */
export class FetchTimeoutError extends Error {
  /**
   * Whatever the request actually rejected with. Declared rather than passed to `super`, because the
   * options form of the `Error` constructor is newer than this bundle's `build.target` and would be
   * dropped in silence on the older engines that target promises.
   */
  readonly cause?: unknown;

  constructor(readonly url: string, readonly timeoutMs: number, cause?: unknown) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
    this.cause = cause;
  }
}

/** What a caller gets back: the body already read, plus the parts of the response worth keeping. */
export interface TimedResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  /** Read inside the window. Handing back an unread body is what left the wait unbounded before. */
  text: string;
}

export interface FetchWithTimeoutOptions {
  timeoutMs?: number;
  /** A caller's own cancellation, typically a React effect's unmount signal. Composed, not replaced. */
  signal?: AbortSignal;
  /** Injected only by tests. Production always uses the global. */
  fetcher?: typeof fetch;
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null | undefined)?.name === 'AbortError';
}

/**
 * `fetch` with a bounded wait over the whole exchange, composing the caller's own cancellation signal
 * rather than replacing it, so an unmount still aborts work in flight.
 *
 * **The body is read here on purpose.** `fetch` resolves as soon as the response headers arrive, and
 * the body is a separate stream consumed afterwards. Returning the `Response` and clearing the timer
 * at that point bounds only the time to headers: a gateway that answers `200` and then withholds the
 * body hangs the caller forever, and the caller's own signal has been unsubscribed by then, so an
 * unmount cannot rescue it either. In `StreamPreview` that is worse than one stalled preview, because
 * the thumbnail queue runs at concurrency 1 and a stuck read blocks every other stream's thumbnail
 * for the life of the page. See OBS-2.
 *
 * Deliberately built from `AbortController` and `setTimeout` rather than `AbortSignal.timeout` and
 * `AbortSignal.any`, which are the obvious tools and are both newer than this bundle's declared
 * `build.target`: `AbortSignal.timeout` lands in Safari 16 against a target of Safari 14, so it would
 * throw at runtime on exactly the engines the target promises to support, and nothing in the build
 * would say so. The timeout is tracked with a local flag rather than an abort reason for the same
 * reason, since the reason argument to `abort()` is no older.
 */
export async function fetchWithTimeout(url: string, options: FetchWithTimeoutOptions = {}): Promise<TimedResponse> {
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
    const response = await fetcher(url, { signal: controller.signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, headers: response.headers, text };
  } catch (error) {
    // Order matters. A caller who cancelled gets their own error back even if the window happened to
    // elapse in the same tick, and a failure that merely landed after the window keeps its identity:
    // reporting a DNS or CORS failure as a timeout points whoever reads the log at the wrong cause.
    if (signal?.aborted || !timedOut || !isAbortError(error)) {
      throw error;
    }
    throw new FetchTimeoutError(url, timeoutMs, error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
