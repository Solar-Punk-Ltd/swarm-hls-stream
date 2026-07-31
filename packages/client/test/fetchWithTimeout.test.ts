import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_FETCH_TIMEOUT_MS, FetchTimeoutError, fetchWithTimeout } from '../src/utils/fetchWithTimeout';

const SHORT_WINDOW_MS = 60;

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** A gateway that accepts the connection and never answers at all. */
function silentGateway(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(abortError()));
    })) as unknown as typeof fetch;
}

/**
 * A gateway that answers headers at once and then withholds the body. `fetch` resolves at the
 * headers, so this is the case a window applied only to the fetch call cannot see, and it is the one
 * a real overloaded or hostile gateway produces.
 */
function stallingBodyGateway(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () =>
        new Promise<string>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(abortError()));
        }),
    } as unknown as Response)) as unknown as typeof fetch;
}

function answering(text: string, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers(headers),
      text: async () => text,
    } as unknown as Response)) as unknown as typeof fetch;
}

describe('fetchWithTimeout (OBS-2, client half)', () => {
  it('gives up on a gateway that never answers', async () => {
    const started = Date.now();

    await expect(
      fetchWithTimeout('http://gateway/feeds/x', { timeoutMs: SHORT_WINDOW_MS, fetcher: silentGateway() }),
    ).rejects.toBeInstanceOf(FetchTimeoutError);

    const elapsed = Date.now() - started;
    // Both bounds, and the lower one is the load-bearing half. With only an upper bound a timer that
    // ignored `timeoutMs` and fired immediately passed this test, so it asserted that the call ends
    // rather than that it waits for the window it was given.
    expect(elapsed).toBeGreaterThanOrEqual(SHORT_WINDOW_MS - 5);
    expect(elapsed).toBeLessThan(SHORT_WINDOW_MS * 20);
  });

  // The defect this file exists for. `fetch` resolves at the headers, so a window that ends there
  // leaves the body read unbounded, and the caller's signal unsubscribed while it hangs.
  it('gives up on a gateway that answers headers and then withholds the body', async () => {
    const started = Date.now();

    await expect(
      fetchWithTimeout('http://gateway/feeds/x', { timeoutMs: SHORT_WINDOW_MS, fetcher: stallingBodyGateway() }),
    ).rejects.toBeInstanceOf(FetchTimeoutError);

    expect(Date.now() - started).toBeGreaterThanOrEqual(SHORT_WINDOW_MS - 5);
  });

  it("lets the caller's own signal abort a stalled body read", async () => {
    const abort = new AbortController();
    const pending = fetchWithTimeout('http://gateway/feeds/x', {
      timeoutMs: 60_000,
      signal: abort.signal,
      fetcher: stallingBodyGateway(),
    });
    setTimeout(() => abort.abort(), 20);

    // An unmount has to reach the body, not only the headers. Returning an unread response and
    // unsubscribing made this hang for as long as the gateway cared to hold it.
    await expect(pending).rejects.not.toBeInstanceOf(FetchTimeoutError);
  });

  it('names the url and the window it gave up after, and identifies itself', async () => {
    const error = await fetchWithTimeout('http://gateway/feeds/x', {
      timeoutMs: SHORT_WINDOW_MS,
      fetcher: silentGateway(),
    }).catch((caught: unknown) => caught as FetchTimeoutError);

    expect(error.url).toBe('http://gateway/feeds/x');
    expect(error.timeoutMs).toBe(SHORT_WINDOW_MS);
    // Callers that cross a bundle boundary compare names rather than prototypes.
    expect(error.name).toBe('FetchTimeoutError');
  });

  // Reporting an unrelated failure as a timeout sends whoever reads the log after the wrong cause.
  it('keeps the real error when a failure merely lands after the window', async () => {
    const dnsFailure = new TypeError('Failed to fetch: getaddrinfo ENOTFOUND gateway');
    const ignoresTheSignal = (() =>
      new Promise<Response>((_resolve, reject) => {
        setTimeout(() => reject(dnsFailure), SHORT_WINDOW_MS * 2);
      })) as unknown as typeof fetch;

    await expect(
      fetchWithTimeout('http://gateway/feeds/x', { timeoutMs: SHORT_WINDOW_MS, fetcher: ignoresTheSignal }),
    ).rejects.toBe(dnsFailure);
  });

  it('keeps the original abort as the cause when it does report a timeout', async () => {
    const error = await fetchWithTimeout('http://gateway/feeds/x', {
      timeoutMs: SHORT_WINDOW_MS,
      fetcher: silentGateway(),
    }).catch((caught: unknown) => caught as FetchTimeoutError);

    expect((error.cause as Error | undefined)?.name).toBe('AbortError');
  });

  it("aborts when the caller's own signal fires, and does not call it a timeout", async () => {
    const abort = new AbortController();
    const pending = fetchWithTimeout('http://gateway/feeds/x', {
      timeoutMs: 60_000,
      signal: abort.signal,
      fetcher: silentGateway(),
    });

    abort.abort();

    await expect(pending).rejects.not.toBeInstanceOf(FetchTimeoutError);
  });

  it('refuses to start when the caller has already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const fetcher = vi.fn(silentGateway());

    await expect(
      fetchWithTimeout('http://gateway/feeds/x', { signal: abort.signal, fetcher: fetcher as unknown as typeof fetch }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns the body and the headers a caller needs', async () => {
    const result = await fetchWithTimeout('http://gateway/feeds/x', {
      fetcher: answering('#EXTM3U', { 'swarm-feed-index': '0a' }),
    });

    expect(result.text).toBe('#EXTM3U');
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    // ManifestManagement reads the feed index off this header, so buffering the body must not cost it.
    expect(result.headers.get('swarm-feed-index')).toBe('0a');
  });

  it('stops the clock on success', async () => {
    vi.useFakeTimers();
    try {
      await fetchWithTimeout('http://gateway/feeds/x', { fetcher: answering('body') });

      // A window left running holds a timer past the response. Nothing else in this suite would
      // notice, and in the player it is one leaked timer per manifest poll.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the clock when the request fails, not only when it succeeds', async () => {
    vi.useFakeTimers();
    try {
      await expect(
        fetchWithTimeout('http://gateway/feeds/x', {
          fetcher: (async () => {
            throw new Error('connection refused');
          }) as unknown as typeof fetch,
        }),
      ).rejects.toThrow('connection refused');

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a default window long enough for a real request to complete', () => {
    // A bound, not merely a positive number: a default of a few milliseconds would abort every real
    // request in production while still satisfying "greater than zero".
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('fetchWithTimeout default wiring', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Every other test injects a fetcher, which leaves the composition root every call site actually
  // depends on with no coverage at all: swapping `fetcher = fetch` for something else passed them.
  it('calls the global fetch when no fetcher is injected', async () => {
    const global = vi.fn(answering('from the global'));
    globalThis.fetch = global as unknown as typeof fetch;

    const result = await fetchWithTimeout('http://gateway/feeds/x');

    expect(global).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('from the global');
  });
});

const SRC_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Spellings that reach the unbounded global. The bare form needs the leading guard so a method named
 * `fetch` on some other object does not count, and the three explicit globals need naming precisely
 * because that guard would otherwise wave them through: `window.fetch(` has a dot before `fetch` just
 * as `cache.fetch(` does.
 */
const UNBOUNDED_CALL = /(^|[^.\w])fetch\s*\(|\b(?:window|globalThis|self)\s*\.\s*fetch\s*\(/;

// The uploader half of OBS-2 was closed by routing every call through one helper so a new call site
// could not forget the window. The client has no such chokepoint, since any component can reach for
// the global, so the equivalent guarantee has to be asserted rather than designed in.
describe('the client makes no unbounded requests (OBS-2)', () => {
  it('has no call to the global fetch left in src', () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter((path) => !path.endsWith(join('utils', 'fetchWithTimeout.ts')))
      .flatMap((path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          .map((line, index) => ({ path, line: line.trim(), number: index + 1 }))
          .filter(({ line }) => UNBOUNDED_CALL.test(line) && !/\basync\s+fetch\s*\(/.test(line)),
      )
      .map(({ path, number, line }) => `${path.slice(SRC_DIR.length + 1)}:${number}: ${line}`);

    expect(offenders, 'these reach the network with no timeout; route them through fetchWithTimeout').toEqual([]);
  });

  it.each(['fetch(url)', 'window.fetch(url)', 'globalThis.fetch(url)', 'self.fetch(url)', 'await fetch(`${a}/b`)'])(
    'recognises %s as an unbounded call',
    (spelling) => {
      expect(UNBOUNDED_CALL.test(spelling)).toBe(true);
    },
  );

  it.each(['cache.fetch(url)', 'manifestFetcher.fetch(url)', 'this.fetchResource(path)'])(
    'does not mistake %s for one',
    (spelling) => {
      expect(UNBOUNDED_CALL.test(spelling)).toBe(false);
    },
  );
});
