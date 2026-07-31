import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_FETCH_TIMEOUT_MS, FetchTimeoutError, fetchWithTimeout } from '../src/utils/fetchWithTimeout';

const SHORT_WINDOW_MS = 40;

/** A gateway that accepts the connection and never answers, which is the failure being bounded. */
function silentGateway(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
    })) as unknown as typeof fetch;
}

describe('fetchWithTimeout (OBS-2, client half)', () => {
  it('gives up on a gateway that never answers', async () => {
    const started = Date.now();

    await expect(
      fetchWithTimeout('http://gateway/feeds/x', { timeoutMs: SHORT_WINDOW_MS, fetcher: silentGateway() }),
    ).rejects.toBeInstanceOf(FetchTimeoutError);

    // Without the window this rejects never, so the elapsed time is the assertion and the error type
    // alone is not: a fetcher that rejected for its own reasons would satisfy the line above.
    expect(Date.now() - started).toBeLessThan(SHORT_WINDOW_MS * 20);
  });

  it('names the url and the window it gave up after', async () => {
    const error = await fetchWithTimeout('http://gateway/feeds/x', {
      timeoutMs: SHORT_WINDOW_MS,
      fetcher: silentGateway(),
    }).catch((caught: unknown) => caught as FetchTimeoutError);

    expect(error.url).toBe('http://gateway/feeds/x');
    expect(error.timeoutMs).toBe(SHORT_WINDOW_MS);
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

  it('passes the response through and stops the clock on success', async () => {
    vi.useFakeTimers();
    try {
      const answered = { ok: true, status: 200 } as Response;
      const result = await fetchWithTimeout('http://gateway/feeds/x', {
        fetcher: (async () => answered) as unknown as typeof fetch,
      });

      expect(result).toBe(answered);
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

  it('leaves a default window in place for callers that ask for nothing', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
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
          // A method named `fetch` and a call to `something.fetch(` are both fine. The global on its
          // own is the one with no window behind it.
          .filter(({ line }) => /(^|[^.\w])fetch\s*\(/.test(line) && !/\basync\s+fetch\s*\(/.test(line)),
      )
      .map(({ path, number, line }) => `${path.slice(SRC_DIR.length + 1)}:${number}: ${line}`);

    expect(offenders, 'these reach the network with no timeout; route them through fetchWithTimeout').toEqual([]);
  });
});
