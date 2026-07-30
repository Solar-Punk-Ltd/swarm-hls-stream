import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Fetcher } from '../src/engines/ome/interfaces.js';
import { DEFAULT_FETCH_TIMEOUT_MS, OmeHlsPuller } from '../src/engines/ome/OmeHlsPuller.js';
import { REJECT_QUEUE_FULL, SegmentResult } from '../src/types.js';

const MEDIA_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXTINF:2.0,',
  'segment_0.ts',
  '#EXTINF:2.0,',
  'segment_1.ts',
].join('\n');

const MEDIA_URL = 'http://ome/hls/app/stream/media.m3u8';

interface PullerInternals {
  lastSeq: number;
  processPlaylist(playlist: string, url: string): Promise<void>;
}

type OrchestratorArg = ConstructorParameters<typeof OmeHlsPuller>[5];

async function withSilencedLogs<T>(run: () => Promise<T>): Promise<T> {
  const { error, warn } = console;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

function makePuller(handleSegment: () => SegmentResult): PullerInternals {
  const orchestrator = { handleSegment } as unknown as OrchestratorArg;
  const puller = new OmeHlsPuller('stream-test', 'app', 'stream', 'http://ome/hls', 1000, orchestrator);
  return puller as unknown as PullerInternals;
}

describe('OmeHlsPuller backpressure', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(4),
    })) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does not advance lastSeq when a segment is rejected (queue full)', async () => {
    const puller = makePuller(() => ({ accepted: false, reason: REJECT_QUEUE_FULL }));

    await puller.processPlaylist(MEDIA_PLAYLIST, MEDIA_URL);

    assert.equal(puller.lastSeq, -1);
  });

  it('advances lastSeq through accepted segments', async () => {
    const puller = makePuller(() => ({ accepted: true }));

    await puller.processPlaylist(MEDIA_PLAYLIST, MEDIA_URL);

    assert.equal(puller.lastSeq, 1);
  });

  it('stops at the first rejected segment, keeping later ones for the next tick', async () => {
    let call = 0;
    const puller = makePuller(() =>
      call++ === 0 ? { accepted: true } : { accepted: false, reason: REJECT_QUEUE_FULL },
    );

    await puller.processPlaylist(MEDIA_PLAYLIST, MEDIA_URL);

    assert.equal(puller.lastSeq, 0);
  });
});

describe('OmeHlsPuller playlist resolution', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // First-poll latch race: OME's first response at ts:playlist.m3u8 is a segmentless stub (not yet a
  // master), so the puller falls back to polling the master URL as if it were the media playlist. Once
  // OME serves the real master (a variant list) at that URL, the puller must follow the variant — not
  // keep parsing a master as a media playlist forever, which yields zero segments and a stream that
  // never goes live.
  it('follows the variant when OME serves the master after an initial segmentless stub', async () => {
    const STUB = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2'].join('\n');
    const MASTER = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1000000', 'variant.m3u8'].join('\n');
    const MEDIA = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0', '#EXTINF:2.0,', 'segment_0.ts'].join('\n');

    let masterPolls = 0;
    globalThis.fetch = (async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith('/ts:playlist.m3u8')) {
        masterPolls++;
        // First two polls (resolve + same-tick media fetch) get the stub; then the real master.
        return { ok: true, status: 200, text: async () => (masterPolls <= 2 ? STUB : MASTER) };
      }
      if (url.endsWith('/variant.m3u8')) {
        return { ok: true, status: 200, text: async () => MEDIA };
      }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) };
    }) as unknown as typeof globalThis.fetch;

    const pulled: number[] = [];
    const orchestrator = {
      handleSegment: (_id: string, seq: number) => {
        pulled.push(seq);
        return { accepted: true };
      },
    } as unknown as ConstructorParameters<typeof OmeHlsPuller>[5];

    // Huge interval so the puller's own scheduled ticks never fire — the test drives tick() by hand.
    const puller = new OmeHlsPuller(
      'stream-test',
      'app',
      'stream',
      'http://ome/hls',
      1_000_000,
      orchestrator,
    ) as unknown as {
      tick(): Promise<void>;
      stop(): void;
    };

    await puller.tick(); // stub -> latch the master URL as the media playlist, no segments
    await puller.tick(); // master now served -> follow the variant
    await puller.tick(); // variant media playlist -> pull segment 0
    puller.stop();

    assert.deepEqual(
      pulled,
      [0],
      'the puller must follow the variant once OME serves the master, not latch a dead URL',
    );
  });
});

describe('OmeHlsPuller injected fetcher (S0.6)', () => {
  const MASTER_URL = 'http://ome/hls/app/stream/ts:playlist.m3u8';
  const VARIANT_URL = 'http://ome/hls/app/stream/variant.m3u8';
  const MASTER_PLAYLIST = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1000', 'variant.m3u8'].join('\n');

  interface Route {
    status?: number;
    body?: string;
  }

  function routedFetcher(routes: Record<string, Route>, calls: string[] = []): Fetcher {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      // Segment payloads are always served: these tests are about playlist resolution, and an
      // unrouted segment would 404 and be skipped, which reads as a resolution failure instead.
      const route = routes[url] ?? (url.endsWith('.ts') ? {} : undefined);
      const status = route ? route.status ?? 200 : 404;
      return {
        status,
        ok: status >= 200 && status < 300,
        text: async () => route?.body ?? '',
        arrayBuffer: async () => new ArrayBuffer(4),
      };
    }) as unknown as Fetcher;
  }

  interface PullerDriver {
    tick(): Promise<void>;
    stop(): void;
  }

  function makeDrivablePuller(
    fetcher: Fetcher,
    pulled: number[] = [],
    halts: number[] = [],
    overrides: { intervalMs?: number; fetchTimeoutMs?: number } = {},
  ): PullerDriver {
    const orchestrator = {
      handleSegment: (_id: string, seq: number) => {
        pulled.push(seq);
        return { accepted: true };
      },
    } as unknown as OrchestratorArg;

    // A huge interval by default so the puller's own scheduled ticks never fire and the test drives
    // tick() itself. The timeout tests override it, because rescheduling is what they assert.
    return new OmeHlsPuller(
      'stream-test',
      'app',
      'stream',
      'http://ome/hls',
      overrides.intervalMs ?? 1_000_000,
      orchestrator,
      {
        fetcher,
        onHalt: () => halts.push(1),
        fetchTimeoutMs: overrides.fetchTimeoutMs,
      },
    ) as unknown as PullerDriver;
  }

  it('resolves the master playlist and then follows the variant, with no network', async () => {
    const pulled: number[] = [];
    const puller = makeDrivablePuller(
      routedFetcher({
        [MASTER_URL]: { body: MASTER_PLAYLIST },
        [VARIANT_URL]: { body: MEDIA_PLAYLIST },
      }),
      pulled,
    );

    await puller.tick();
    await puller.tick();
    puller.stop();

    assert.deepEqual(pulled, [0, 1], 'both segments of the variant playlist reach the orchestrator');
  });

  it('survives a 404 on the master playlist without halting or throwing', async () => {
    const calls: string[] = [];
    const pulled: number[] = [];
    const halts: number[] = [];
    const puller = makeDrivablePuller(routedFetcher({ [MASTER_URL]: { status: 404 } }, calls), pulled, halts);

    await puller.tick();
    await puller.tick();
    puller.stop();

    assert.deepEqual(pulled, [], 'nothing is published while the playlist is missing');
    assert.deepEqual(halts, [], 'a 404 inside the retry window must not halt the puller');
    assert.deepEqual(
      calls,
      [MASTER_URL, MASTER_URL],
      'a 404 leaves the puller retrying the master rather than latching a dead variant',
    );
  });

  const FETCH_TIMEOUT_MS = 25;

  it('defaults the abort window to the documented value', () => {
    // Pinned as a literal on purpose. Every test above passes its own short window, so none of them
    // would notice the production default changing, and the default is what a real deploy runs with.
    assert.equal(DEFAULT_FETCH_TIMEOUT_MS, 10_000);
  });

  /**
   * Never resolves on its own, and **honours the abort signal** by rejecting when it fires. Honouring
   * it is the whole point: a fake that ignores the signal never settles whatever timeout is
   * configured, so a test built on one passes identically with and without a timeout.
   */
  function hangingFetcher(seenSignals: (AbortSignal | undefined)[] = [], urls: string[] = []): Fetcher {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      const signal = init?.signal ?? undefined;
      seenSignals.push(signal);
      return new Promise((_resolve, reject) => {
        // Rejecting with signal.reason rather than a hand-rolled Error, because that is the exact
        // TimeoutError DOMException AbortSignal.timeout produces, and the code under test branches on it.
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    }) as unknown as Fetcher;
  }

  it('aborts a hanging fetch within the configured window instead of stalling the tick', async () => {
    const seenSignals: (AbortSignal | undefined)[] = [];
    const puller = makeDrivablePuller(hangingFetcher(seenSignals), [], [], { fetchTimeoutMs: FETCH_TIMEOUT_MS });

    const outcome = await Promise.race([
      puller.tick().then(
        () => 'resolved',
        () => 'rejected',
      ),
      sleep(FETCH_TIMEOUT_MS * 20).then(() => 'still-pending'),
    ]);
    puller.stop();

    assert.equal(outcome, 'rejected', 'a black-holed connection has to abort and surface, not stall the poll loop');
    assert.ok(seenSignals[0] instanceof AbortSignal, 'the fetch is handed an abort signal');
    assert.equal(seenSignals[0]?.aborted, true, 'and that signal is what ended the hang');
  });

  it('carries an abort signal on the segment fetch too, not only the playlist ones', async () => {
    const seenSignals: (AbortSignal | undefined)[] = [];
    const urls: string[] = [];
    // Playlists resolve normally, so the hang lands on the segment fetch specifically.
    const routes: Record<string, Route> = {
      [MASTER_URL]: { body: MASTER_PLAYLIST },
      [VARIANT_URL]: { body: MEDIA_PLAYLIST },
    };
    const playlists = routedFetcher(routes);
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('.ts')) {
        return hangingFetcher(seenSignals, urls)(input, init);
      }
      return playlists(input, init);
    }) as unknown as Fetcher;

    const errors: string[] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    console.warn = () => {};

    const puller = makeDrivablePuller(fetcher, [], [], { fetchTimeoutMs: FETCH_TIMEOUT_MS });
    try {
      await Promise.race([puller.tick().catch(() => undefined), sleep(FETCH_TIMEOUT_MS * 20)]);
      puller.stop();
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }

    assert.ok(urls.length > 0, 'a segment fetch was attempted');
    assert.ok(seenSignals[0] instanceof AbortSignal, 'the segment fetch is handed an abort signal');
    assert.equal(seenSignals[0]?.aborted, true, 'and it aborts rather than hanging the playlist loop');
    // The segment catch is a second, separate log site from the tick catch, and it is the one that runs
    // per segment in steady state. Pinned here because downgrading it alone left the whole suite green.
    assert.ok(
      errors.some((line) => /Segment .*abort/i.test(line)),
      `the segment abort is logged at error level, got ${JSON.stringify(errors.slice(0, 3))}`,
    );
  });

  it('logs the abort as an error and still runs the next tick', async () => {
    const errors: string[] = [];
    const urls: string[] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    console.warn = () => {};

    const puller = makeDrivablePuller(hangingFetcher([], urls), [], [], {
      fetchTimeoutMs: FETCH_TIMEOUT_MS,
      intervalMs: 5,
    });

    try {
      (puller as unknown as { start(): void }).start();
      await sleep(FETCH_TIMEOUT_MS * 8);
      puller.stop();
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }

    assert.ok(urls.length >= 2, `the poll loop kept going after the abort, saw ${urls.length} attempts`);
    assert.ok(
      errors.some((line) => /abort|timed out|timeout/i.test(line)),
      `the abort is logged at error level, got ${JSON.stringify(errors.slice(0, 3))}`,
    );
  });
});

describe('OmeHlsPuller segment loss (OBS-11)', () => {
  const THREE_SEGMENT_PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:2.0,',
    'segment_0.ts',
    '#EXTINF:2.0,',
    'segment_1.ts',
    '#EXTINF:2.0,',
    'segment_2.ts',
  ].join('\n');

  interface SegmentDoor {
    name: string;
    respond: () => Promise<Response>;
  }

  /**
   * Every way a segment download can end without the bytes arriving. All four reach the same place, and
   * all four used to let `lastSeq` advance past the segment, which is what makes the loss permanent.
   */
  const SEGMENT_FAILURE_DOORS: SegmentDoor[] = [
    {
      name: 'an aborted request',
      respond: () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    },
    {
      name: 'a network drop',
      respond: () => Promise.reject(new TypeError('fetch failed')),
    },
    {
      name: 'a body read that fails mid-download',
      respond: async () =>
        ({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.reject(new Error('aborted: socket hang up')),
        } as unknown as Response),
    },
    {
      name: 'an origin error status',
      respond: async () => ({ ok: false, status: 503 } as unknown as Response),
    },
  ];

  function okSegment(): Response {
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Response;
  }

  function makePullerFailingOn(failingSeq: number | null, door: SegmentDoor, delivered: number[]): PullerInternals {
    const fetcher = ((input: RequestInfo | URL) =>
      String(input).endsWith(`segment_${failingSeq}.ts`)
        ? door.respond()
        : Promise.resolve(okSegment())) as unknown as Fetcher;

    const orchestrator = {
      handleSegment: (_id: string, seq: number) => {
        delivered.push(seq);
        return { accepted: true };
      },
      handleSegmentLoss: () => {},
    } as unknown as OrchestratorArg;

    return new OmeHlsPuller('stream-test', 'app', 'stream', 'http://ome/hls', 1_000_000, orchestrator, {
      fetcher,
    }) as unknown as PullerInternals;
  }

  for (const door of SEGMENT_FAILURE_DOORS) {
    it(`holds position when ${door.name} loses a segment, rather than skipping it forever`, async () => {
      const delivered: number[] = [];
      const puller = makePullerFailingOn(1, door, delivered);

      await withSilencedLogs(() => puller.processPlaylist(THREE_SEGMENT_PLAYLIST, MEDIA_URL));

      assert.deepEqual(delivered, [0], 'the pass stops at the failed segment instead of running past it');
      assert.equal(puller.lastSeq, 0, 'lastSeq must not advance past a segment that was never delivered');
    });
  }

  it('re-pulls the held segment on the next pass once the origin recovers', async () => {
    const delivered: number[] = [];
    let failing = true;
    const orchestrator = {
      handleSegment: (_id: string, seq: number) => {
        delivered.push(seq);
        return { accepted: true };
      },
      handleSegmentLoss: () => {},
    } as unknown as OrchestratorArg;
    const fetcher = ((input: RequestInfo | URL) =>
      failing && String(input).endsWith('segment_1.ts')
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(okSegment())) as unknown as Fetcher;
    const puller = new OmeHlsPuller('stream-test', 'app', 'stream', 'http://ome/hls', 1_000_000, orchestrator, {
      fetcher,
    }) as unknown as PullerInternals;

    await withSilencedLogs(() => puller.processPlaylist(THREE_SEGMENT_PLAYLIST, MEDIA_URL));
    failing = false;
    await withSilencedLogs(() => puller.processPlaylist(THREE_SEGMENT_PLAYLIST, MEDIA_URL));

    assert.deepEqual(delivered, [0, 1, 2], 'the recovered segment is delivered in order, with no hole');
    assert.equal(puller.lastSeq, 2);
  });
});
