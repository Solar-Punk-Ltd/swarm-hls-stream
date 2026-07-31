import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Fetcher } from '../src/engines/ome/interfaces.js';
import { DEFAULT_FETCH_TIMEOUT_MS, OmeHlsPuller, SEGMENT_RETRY_LIMIT } from '../src/engines/ome/OmeHlsPuller.js';
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

interface CapturedLogs {
  errors: string[];
  warns: string[];
}

async function withCapturedLogs(run: () => Promise<unknown>): Promise<CapturedLogs> {
  const { error, warn } = console;
  const captured: CapturedLogs = { errors: [], warns: [] };
  console.error = (...args: unknown[]) => captured.errors.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => captured.warns.push(args.map(String).join(' '));
  try {
    await run();
    return captured;
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

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

  it('writes a segment off after the documented number of attempts', () => {
    // Every loop above uses the constant, so its value cannot be caught by them: 3 to 5 and 3 to 100
    // both leave the suite green. Pinned as a literal for the same reason the abort default is.
    assert.equal(SEGMENT_RETRY_LIMIT, 3);
  });

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
      handleSegmentLoss: () => true,
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

  interface ReportedLoss {
    firstIndex: number;
    count: number;
  }

  interface LossRecorder {
    delivered: number[];
    lost: ReportedLoss[];
  }

  function makeRecordingOrchestrator(record: LossRecorder): OrchestratorArg {
    return {
      handleSegment: (_id: string, seq: number) => {
        record.delivered.push(seq);
        return { accepted: true };
      },
      handleSegmentLoss: (_id: string, firstIndex: number, count: number) => {
        record.lost.push({ firstIndex, count });
        return true;
      },
    } as unknown as OrchestratorArg;
  }

  it('writes off a segment that keeps failing, reports the loss, and resumes the live edge', async () => {
    const record: LossRecorder = { delivered: [], lost: [] };
    const fetcher = ((input: RequestInfo | URL) =>
      String(input).endsWith('segment_1.ts')
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(okSegment())) as unknown as Fetcher;
    const puller = new OmeHlsPuller(
      'stream-test',
      'app',
      'stream',
      'http://ome/hls',
      1_000_000,
      makeRecordingOrchestrator(record),
      { fetcher },
    ) as unknown as PullerInternals;

    for (let pass = 0; pass < SEGMENT_RETRY_LIMIT; pass++) {
      await withSilencedLogs(() => puller.processPlaylist(THREE_SEGMENT_PLAYLIST, MEDIA_URL));
    }

    assert.deepEqual(record.lost, [{ firstIndex: 1, count: 1 }], 'the write-off is reported once, not once per pass');
    assert.deepEqual(record.delivered, [0, 2], 'the live edge resumes rather than parking behind one bad segment');
    assert.equal(puller.lastSeq, 2);
  });

  it('reports the loss when the origin rolls the held segment out of its playlist window', async () => {
    const WINDOW_MOVED_ON = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:2',
      '#EXTINF:2.0,',
      'segment_2.ts',
    ].join('\n');

    const record: LossRecorder = { delivered: [], lost: [] };
    const fetcher = ((input: RequestInfo | URL) =>
      String(input).endsWith('segment_1.ts')
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(okSegment())) as unknown as Fetcher;
    const puller = new OmeHlsPuller(
      'stream-test',
      'app',
      'stream',
      'http://ome/hls',
      1_000_000,
      makeRecordingOrchestrator(record),
      { fetcher },
    ) as unknown as PullerInternals;

    await withSilencedLogs(() => puller.processPlaylist(THREE_SEGMENT_PLAYLIST, MEDIA_URL));
    await withSilencedLogs(() => puller.processPlaylist(WINDOW_MOVED_ON, MEDIA_URL));

    assert.deepEqual(
      record.lost,
      [{ firstIndex: 1, count: 1 }],
      'a segment the origin no longer serves is announced, not skipped',
    );
    assert.deepEqual(record.delivered, [0, 2]);
  });

  it('announces a large gap once rather than once per missing index', async () => {
    // The origin controls this number. A restarted OME serving a high #EXT-X-MEDIA-SEQUENCE would
    // otherwise put one log line and one queued job per missing index between the last delivered
    // segment and the new one, which at a realistic restart is millions of both.
    const HUGE_JUMP = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:1000000', '#EXTINF:2.0,', 'segment_1000000.ts'].join('\n');

    const record: LossRecorder = { delivered: [], lost: [] };
    const fetcher = (() => Promise.resolve(okSegment())) as unknown as Fetcher;
    const puller = new OmeHlsPuller(
      'stream-test',
      'app',
      'stream',
      'http://ome/hls',
      1_000_000,
      makeRecordingOrchestrator(record),
      { fetcher },
    ) as unknown as PullerInternals;

    await withSilencedLogs(() => puller.processPlaylist(THREE_SEGMENT_PLAYLIST, MEDIA_URL));
    await withSilencedLogs(() => puller.processPlaylist(HUGE_JUMP, MEDIA_URL));

    assert.deepEqual(record.lost, [{ firstIndex: 3, count: 999_997 }], 'the whole gap is one report carrying its size');
    assert.deepEqual(record.delivered, [0, 1, 2, 1_000_000]);
  });

  it('does not report a loss once the puller has stopped, so it cannot land on the next session', async () => {
    // A fetch started before the stop can answer after it, and by then the id may belong to a fresh
    // session whose first segment would carry a discontinuity that never happened.
    const record: LossRecorder = { delivered: [], lost: [] };
    const puller = new OmeHlsPuller(
      'stream-test',
      'app',
      'stream',
      'http://ome/hls',
      1_000_000,
      makeRecordingOrchestrator(record),
      {
        fetcher: ((input: RequestInfo | URL) => {
          if (!String(input).endsWith('segment_1.ts')) {
            return Promise.resolve(okSegment());
          }
          if (attempt++ === SEGMENT_RETRY_LIMIT - 1) {
            (puller as unknown as { stop(): void }).stop();
          }
          return Promise.reject(new TypeError('fetch failed'));
        }) as unknown as Fetcher,
      },
    ) as unknown as PullerInternals;
    let attempt = 0;

    for (let pass = 0; pass < SEGMENT_RETRY_LIMIT; pass++) {
      await withSilencedLogs(() => puller.processPlaylist(THREE_SEGMENT_PLAYLIST, MEDIA_URL));
    }

    assert.deepEqual(record.lost, [], 'a stopped puller reports nothing');
    assert.equal(puller.lastSeq, 0, 'and it does not step over the segment it could not report');
  });

  it('holds its position when nothing is registered to record the loss', async () => {
    // Every other fake here accepts, so the whole rejection path was unexercised. A stream can leave
    // the orchestrator between a puller's fetch and its report, through a drain, a recovery timeout
    // or a re-announce, and stepping over the gap there loses those indexes with no trace at all.
    const attempts: number[] = [];
    const orchestrator = {
      handleSegment: () => ({ accepted: true }),
      handleSegmentLoss: (_id: string, firstIndex: number) => {
        attempts.push(firstIndex);
        return false;
      },
    } as unknown as OrchestratorArg;
    const fetcher = ((input: RequestInfo | URL) =>
      String(input).endsWith('segment_1.ts')
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(okSegment())) as unknown as Fetcher;
    const puller = new OmeHlsPuller('stream-test', 'app', 'stream', 'http://ome/hls', 1_000_000, orchestrator, {
      fetcher,
    }) as unknown as PullerInternals;

    for (let pass = 0; pass < SEGMENT_RETRY_LIMIT + 2; pass++) {
      await withSilencedLogs(() => puller.processPlaylist(THREE_SEGMENT_PLAYLIST, MEDIA_URL));
    }

    assert.ok(attempts.length >= 2, 'the puller keeps trying to report rather than giving up quietly');
    assert.equal(puller.lastSeq, 0, 'and it never steps over a gap nothing recorded');
  });

  it('reports the segments it failed to obtain before ever delivering one', async () => {
    // The negative case, that a late join reports nothing, passes just as well when the baseline is
    // never recorded at all. This is the case the baseline exists for: a puller whose very first
    // segments fail, which is every cold start against an origin still warming up.
    const record: LossRecorder = { delivered: [], lost: [] };
    let warmingUp = true;
    const fetcher = ((input: RequestInfo | URL) =>
      Promise.resolve(
        warmingUp && String(input).endsWith('.ts') ? { ok: false, status: 404 } : okSegment(),
      )) as unknown as Fetcher;
    const puller = new OmeHlsPuller(
      'stream-test',
      'app',
      'stream',
      'http://ome/hls',
      1_000_000,
      makeRecordingOrchestrator(record),
      { fetcher },
    ) as unknown as PullerInternals;

    await withSilencedLogs(() => puller.processPlaylist(THREE_SEGMENT_PLAYLIST, MEDIA_URL));
    warmingUp = false;
    const WINDOW_MOVED_PAST = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:9', '#EXTINF:2.0,', 'segment_9.ts'].join('\n');
    await withSilencedLogs(() => puller.processPlaylist(WINDOW_MOVED_PAST, MEDIA_URL));

    assert.deepEqual(record.delivered, [9]);
    assert.deepEqual(
      record.lost,
      [{ firstIndex: 0, count: 9 }],
      'everything between the first index this puller saw and the one it finally got is a reported gap',
    );
  });

  it('does not report a loss for the indexes before the first segment it ever sees', async () => {
    // A puller joining a stream already in progress starts at whatever media sequence the origin is
    // serving. Those earlier indexes were never this puller's to deliver.
    const record: LossRecorder = { delivered: [], lost: [] };
    const LATE_JOIN = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:400', '#EXTINF:2.0,', 'segment_400.ts'].join('\n');
    const fetcher = (() => Promise.resolve(okSegment())) as unknown as Fetcher;
    const puller = new OmeHlsPuller(
      'stream-test',
      'app',
      'stream',
      'http://ome/hls',
      1_000_000,
      makeRecordingOrchestrator(record),
      { fetcher },
    ) as unknown as PullerInternals;

    await withSilencedLogs(() => puller.processPlaylist(LATE_JOIN, MEDIA_URL));

    assert.deepEqual(record.lost, []);
    assert.deepEqual(record.delivered, [400]);
  });

  it('re-pulls the held segment on the next pass once the origin recovers', async () => {
    const delivered: number[] = [];
    let failing = true;
    const orchestrator = {
      handleSegment: (_id: string, seq: number) => {
        delivered.push(seq);
        return { accepted: true };
      },
      handleSegmentLoss: () => true,
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

describe('OmeHlsPuller abort window coverage (TEST-15)', () => {
  const MASTER_URL = 'http://ome/hls/app/stream/ts:playlist.m3u8';
  const VARIANT_URL = 'http://ome/hls/app/stream/variant.m3u8';
  const MASTER = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1000', 'variant.m3u8'].join('\n');
  const MEDIA = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0', '#EXTINF:2.0,', 'segment_0.ts'].join('\n');

  interface SeenCall {
    url: string;
    signal: AbortSignal | undefined;
  }

  function recordingFetcher(calls: SeenCall[], segment: () => Promise<Response>): Fetcher {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, signal: init?.signal ?? undefined });
      if (url === MASTER_URL) {
        return Promise.resolve({ ok: true, status: 200, text: async () => MASTER } as unknown as Response);
      }
      if (url === VARIANT_URL) {
        return Promise.resolve({ ok: true, status: 200, text: async () => MEDIA } as unknown as Response);
      }
      return segment();
    }) as unknown as Fetcher;
  }

  function makePuller(fetcher: Fetcher): { tick(): Promise<void>; stop(): void } {
    const orchestrator = {
      handleSegment: () => ({ accepted: true }),
      handleSegmentLoss: () => true,
    } as unknown as OrchestratorArg;
    return new OmeHlsPuller('stream-test', 'app', 'stream', 'http://ome/hls', 1_000_000, orchestrator, {
      fetcher,
    }) as unknown as { tick(): Promise<void>; stop(): void };
  }

  const okSegmentResponse = () =>
    Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Response);

  it('carries an abort signal on every call site, including the media playlist polled each tick', async () => {
    const calls: SeenCall[] = [];
    const puller = makePuller(recordingFetcher(calls, okSegmentResponse));

    await withSilencedLogs(async () => {
      await puller.tick();
      await puller.tick();
    });
    puller.stop();

    const byUrl = new Map(calls.map((call) => [call.url, call.signal]));
    assert.ok(byUrl.has(VARIANT_URL), `the media playlist was never polled, saw ${[...byUrl.keys()].join(', ')}`);
    for (const [url, signal] of byUrl) {
      assert.ok(signal instanceof AbortSignal, `${url} was fetched without an abort signal`);
    }
  });

  // A memoized signal would abort every later request the instant the first window elapsed, which is
  // why the choke point builds one per call. Nothing failed when that was collapsed to a shared one.
  it('builds a fresh signal per call rather than sharing one', async () => {
    const calls: SeenCall[] = [];
    const puller = makePuller(recordingFetcher(calls, okSegmentResponse));

    await withSilencedLogs(async () => {
      await puller.tick();
      await puller.tick();
    });
    puller.stop();

    assert.ok(calls.length >= 2, 'more than one call is needed to tell a shared signal from a fresh one');
    assert.equal(new Set(calls.map((call) => call.signal)).size, calls.length, 'every call gets its own signal');
  });

  // The tick catch is the puller's other log site, and it has its own abort branch. Only the abort
  // half was driven, so upgrading its ordinary-failure arm to error level changed nothing observable.
  it('logs an ordinary playlist failure at warn from the tick catch, not at error', async () => {
    const failing = (() =>
      Promise.resolve({ ok: false, status: 500, text: async () => '' } as unknown as Response)) as unknown as Fetcher;
    const orchestrator = {
      handleSegment: () => ({ accepted: true }),
      handleSegmentLoss: () => true,
    } as unknown as OrchestratorArg;
    const puller = new OmeHlsPuller('stream-test', 'app', 'stream', 'http://ome/hls', 5, orchestrator, {
      fetcher: failing,
    }) as unknown as { start(): void; stop(): void };

    const logs = await withCapturedLogs(async () => {
      puller.start();
      await sleep(60);
      puller.stop();
    });

    assert.ok(
      logs.warns.some((line) => /Puller tick error/.test(line)),
      `expected the tick failure on warn, got ${JSON.stringify(logs)}`,
    );
    assert.ok(
      !logs.errors.some((line) => /Puller tick error/.test(line)),
      `an ordinary HTTP failure must not use the level reserved for a cut-off request, got ${JSON.stringify(
        logs.errors,
      )}`,
    );
  });

  interface LogLevelCase {
    name: string;
    error: unknown;
    level: keyof CapturedLogs;
  }

  // The whole point of the abort branch is that a cut-off request reads differently from an ordinary
  // failure. Only the abort half was tested, so an isAbortedRequest stuck at true, and either non-abort
  // branch upgraded to error, all left the suite green.
  const LOG_LEVEL_CASES: LogLevelCase[] = [
    {
      name: 'a timeout abort',
      error: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      level: 'errors',
    },
    { name: 'an explicit abort', error: new DOMException('This operation was aborted', 'AbortError'), level: 'errors' },
    { name: 'an ordinary network failure', error: new TypeError('fetch failed'), level: 'warns' },
  ];

  for (const { name, error, level } of LOG_LEVEL_CASES) {
    it(`logs ${name} on the segment fetch at ${level === 'errors' ? 'error' : 'warn'} level`, async () => {
      const calls: SeenCall[] = [];
      const puller = makePuller(recordingFetcher(calls, () => Promise.reject(error)));

      const logs = await withCapturedLogs(async () => {
        await puller.tick();
        await puller.tick();
      });
      puller.stop();

      const other: keyof CapturedLogs = level === 'errors' ? 'warns' : 'errors';
      assert.ok(
        logs[level].some((line) => /Segment 0/.test(line)),
        `expected the segment failure on ${level}, got ${JSON.stringify(logs)}`,
      );
      assert.ok(
        !logs[other].some((line) => /Segment 0/.test(line)),
        `the segment failure must not also appear on ${other}, got ${JSON.stringify(logs[other])}`,
      );
    });
  }
});

describe('OmeHlsPuller origin restart (CON-16)', () => {
  const PLAYLIST_URL = 'http://ome/hls/app/stream/ts:playlist.m3u8';

  function mediaPlaylist(uris: string[]): string {
    return ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0', ...uris.flatMap((uri) => ['#EXTINF:2.0,', uri])].join('\n');
  }

  // The audit measured a puller that had delivered 0..7 against an origin republishing 0..3. The
  // shorter second window is what a just-restarted origin serves, since it has only encoded a few
  // segments by the time of the next poll.
  const FIRST_SESSION = mediaPlaylist([
    's1_0.ts',
    's1_1.ts',
    's1_2.ts',
    's1_3.ts',
    's1_4.ts',
    's1_5.ts',
    's1_6.ts',
    's1_7.ts',
  ]);
  const SECOND_SESSION = mediaPlaylist(['s2_0.ts', 's2_1.ts', 's2_2.ts', 's2_3.ts']);
  // The same origin one poll later, once it has caught back up to the length of the old session. Its
  // indexes are then indistinguishable from an idle poll, and only the segment at the last delivered
  // index says otherwise.
  const SECOND_SESSION_CAUGHT_UP = mediaPlaylist([
    's2_0.ts',
    's2_1.ts',
    's2_2.ts',
    's2_3.ts',
    's2_4.ts',
    's2_5.ts',
    's2_6.ts',
    's2_7.ts',
  ]);
  const FIRST_SESSION_SEQS = [0, 1, 2, 3, 4, 5, 6, 7];

  interface RestartingOrigin {
    fetcher: Fetcher;
    fetched: string[];
    restart(playlist?: string): void;
  }

  /** Serves one session, then the same media sequence again with different segments, as a restarted OME does. */
  function makeOrigin(): RestartingOrigin {
    let playlist = FIRST_SESSION;
    const fetched: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url === PLAYLIST_URL) {
        return { ok: true, status: 200, text: async () => playlist } as unknown as Response;
      }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Response;
    }) as unknown as Fetcher;

    return {
      fetcher,
      fetched,
      restart: (next = SECOND_SESSION) => {
        playlist = next;
      },
    };
  }

  function makeRestartPuller(fetcher: Fetcher, delivered: number[]): { tick(): Promise<void>; stop(): void } {
    const orchestrator = {
      handleSegment: (_id: string, seq: number) => {
        delivered.push(seq);
        return { accepted: true };
      },
      handleSegmentLoss: () => true,
    } as unknown as OrchestratorArg;
    return new OmeHlsPuller('stream-test', 'app', 'stream', 'http://ome/hls', 1_000_000, orchestrator, {
      fetcher,
    }) as unknown as { tick(): Promise<void>; stop(): void };
  }

  // Without an escape from `seq <= lastSeq` the puller keeps polling, keeps getting 200s, and hands
  // nothing on: the second session's indexes all sit at or below the first session's, so every one of
  // them is skipped. Ten ticks stands in for the forty the audit measured.
  it('fetches the restarted origin instead of discarding every index it already used', async () => {
    const origin = makeOrigin();
    const delivered: number[] = [];
    const puller = makeRestartPuller(origin.fetcher, delivered);

    await withSilencedLogs(async () => {
      await puller.tick();
      assert.deepEqual(
        delivered,
        FIRST_SESSION_SEQS,
        'the first session must be delivered before the restart means anything',
      );

      origin.restart();
      for (let i = 0; i < 10; i++) {
        await puller.tick();
      }
    });
    puller.stop();

    const secondSessionFetches = origin.fetched.filter((url) => url.includes('s2_'));
    assert.ok(
      secondSessionFetches.length > 0,
      `the restarted origin's segments were never even fetched, so the puller is silent for good; fetched: ${origin.fetched.join(
        ', ',
      )}`,
    );
  });

  it('reports the restart rather than going quiet about it', async () => {
    const origin = makeOrigin();
    const delivered: number[] = [];
    const puller = makeRestartPuller(origin.fetcher, delivered);

    const logs = await withCapturedLogs(async () => {
      await puller.tick();
      origin.restart();
      await puller.tick();
    });
    puller.stop();

    assert.ok(
      logs.errors.some((line) => /restart/i.test(line)),
      `an origin restart is an operator-visible event and nothing said so; errors: ${JSON.stringify(logs.errors)}`,
    );
  });

  // The steady state is a playlist whose newest index is exactly the last one delivered. Treating that
  // as a restart would re-pull the whole window on every idle poll, so the guard has to exclude it.
  it('does not treat a playlist with no new segments as a restart', async () => {
    const origin = makeOrigin();
    const delivered: number[] = [];
    const puller = makeRestartPuller(origin.fetcher, delivered);

    const logs = await withCapturedLogs(async () => {
      await puller.tick();
      await puller.tick();
      await puller.tick();
    });
    puller.stop();

    assert.deepEqual(delivered, FIRST_SESSION_SEQS, 'an unchanged playlist must not be re-delivered');
    assert.ok(
      !logs.errors.some((line) => /restart/i.test(line)),
      `an idle playlist was reported as a restart; errors: ${JSON.stringify(logs.errors)}`,
    );
  });

  // The case the index comparison alone cannot see. By the time the puller polls again the restarted
  // origin can be advertising as many segments as the old session had reached, so every index matches
  // what was already delivered and the playlist reads as an idle one. Nothing recovers on its own
  // here: the indexes never climb past `lastSeq` again until the new session outgrows the old one.
  it('follows a restarted origin that has already caught up to the old session length', async () => {
    const origin = makeOrigin();
    const delivered: number[] = [];
    const puller = makeRestartPuller(origin.fetcher, delivered);

    await withSilencedLogs(async () => {
      await puller.tick();
      origin.restart(SECOND_SESSION_CAUGHT_UP);
      for (let i = 0; i < 3; i++) {
        await puller.tick();
      }
    });
    puller.stop();

    const secondSessionFetches = origin.fetched.filter((url) => url.includes('s2_'));
    assert.ok(
      secondSessionFetches.length > 0,
      `a restart that lands on the same indexes was read as an idle playlist, so the new session was never fetched; fetched: ${origin.fetched.join(
        ', ',
      )}`,
    );
  });
});

// A puller is stopped from outside, by the engine replacing it or by an announce closing the stream,
// while a poll of its own is in flight. Everything below is what that in-flight poll must not do when
// it finally answers, because by then the stream id can belong to a different session.
describe('OmeHlsPuller stopped mid-poll (CON-16)', () => {
  const MEDIA = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0', '#EXTINF:2.0,', 'segment_0.ts'].join('\n');

  interface StoppablePuller {
    tick(): Promise<void>;
    stop(): void;
  }

  it('does not hand over a segment whose download outlived the stop', async () => {
    const delivered: number[] = [];

    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) {
        return { ok: true, status: 200, text: async () => MEDIA } as unknown as Response;
      }
      // The stop lands while this download is outstanding, which is the only way the race happens.
      puller.stop();
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Response;
    }) as unknown as Fetcher;

    const orchestrator = {
      handleSegment: (_id: string, seq: number) => {
        delivered.push(seq);
        return { accepted: true };
      },
      handleSegmentLoss: () => true,
    } as unknown as OrchestratorArg;

    const puller = new OmeHlsPuller('stream-test', 'app', 'stream', 'http://ome/hls', 1_000_000, orchestrator, {
      fetcher,
    }) as unknown as StoppablePuller;

    await withSilencedLogs(() => puller.tick());

    assert.deepEqual(
      delivered,
      [],
      'a segment fetched before the stop was published after it, into whichever session holds the id now',
    );
  });

  it('does not halt the stream when the 404 that would trigger it outlived the stop', async () => {
    const halts: string[] = [];
    let polls = 0;

    const fetcher = (async () => {
      polls++;
      // Second poll: the stop lands while this one is outstanding. With the halt threshold at zero,
      // an unguarded handleNotFound gives up here and finalizes a stream it no longer owns.
      if (polls > 1) {
        puller.stop();
      }
      return { ok: false, status: 404, text: async () => '' } as unknown as Response;
    }) as unknown as Fetcher;

    const orchestrator = {
      handleSegment: () => ({ accepted: true }),
      handleSegmentLoss: () => true,
    } as unknown as OrchestratorArg;

    const puller = new OmeHlsPuller('stream-test', 'app', 'stream', 'http://ome/hls', 1_000_000, orchestrator, {
      fetcher,
      haltAfterNotFoundMs: 0,
      onHalt: () => halts.push('halted'),
    }) as unknown as StoppablePuller;

    await withSilencedLogs(async () => {
      await puller.tick();
      // Real elapsed time, so the zero threshold is genuinely exceeded on the second poll.
      await sleep(5);
      await puller.tick();
    });

    assert.deepEqual(halts, [], 'a stopped puller halted anyway, taking the session that replaced it with it');
  });

  // Proves the threshold seam is wired to the path it claims to control, so the test above is not
  // passing because nothing could ever halt.
  it('does halt on a 404 past the threshold while it is still running', async () => {
    const halts: string[] = [];
    const fetcher = (async () =>
      ({ ok: false, status: 404, text: async () => '' } as unknown as Response)) as unknown as Fetcher;
    const orchestrator = {
      handleSegment: () => ({ accepted: true }),
      handleSegmentLoss: () => true,
    } as unknown as OrchestratorArg;

    const puller = new OmeHlsPuller('stream-test', 'app', 'stream', 'http://ome/hls', 1_000_000, orchestrator, {
      fetcher,
      haltAfterNotFoundMs: 0,
      onHalt: () => halts.push('halted'),
    }) as unknown as StoppablePuller;

    await withSilencedLogs(async () => {
      await puller.tick();
      await sleep(5);
      await puller.tick();
    });
    puller.stop();

    assert.deepEqual(halts, ['halted'], 'the halt path never fired, so the guard above proves nothing');
  });
});

// The reset is destructive: it rewinds the puller to the start of a playlist it has already worked
// through. Firing it when the origin did not restart re-delivers a whole window and reports a gap
// that never happened, so these pin the two states that look like a restart and are not.
describe('OmeHlsPuller restart detection false positives (CON-16)', () => {
  const PLAYLIST_URL = 'http://ome/hls/app/stream/ts:playlist.m3u8';

  function playlistFrom(mediaSeq: number, uris: string[]): string {
    return ['#EXTM3U', `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`, ...uris.flatMap((uri) => ['#EXTINF:2.0,', uri])].join('\n');
  }

  interface Losses {
    firstIndex: number;
    count: number;
  }

  interface DrivenPuller {
    tick(): Promise<void>;
    stop(): void;
    losses: Losses[];
    delivered: number[];
    serve(playlist: string): void;
  }

  /**
   * Serves one playlist until told otherwise. Deliberately not switched on a poll count: the first
   * tick fetches the playlist twice, once to resolve the media URL and once to read it, so a counter
   * moves the origin on before the puller has processed anything.
   */
  function drive(initialPlaylist: string, segmentOk: (uri: string) => boolean): DrivenPuller {
    const losses: Losses[] = [];
    const delivered: number[] = [];
    let playlist = initialPlaylist;

    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === PLAYLIST_URL) {
        return { ok: true, status: 200, text: async () => playlist } as unknown as Response;
      }
      const uri = url.slice(url.lastIndexOf('/') + 1);
      return segmentOk(uri)
        ? ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Response)
        : ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response);
    }) as unknown as Fetcher;

    const orchestrator = {
      handleSegment: (_id: string, seq: number) => {
        delivered.push(seq);
        return { accepted: true };
      },
      handleSegmentLoss: (_id: string, firstIndex: number, count: number) => {
        losses.push({ firstIndex, count });
        return true;
      },
    } as unknown as OrchestratorArg;

    const puller = new OmeHlsPuller('stream-test', 'app', 'stream', 'http://ome/hls', 1_000_000, orchestrator, {
      fetcher,
    }) as unknown as { tick(): Promise<void>; stop(): void };

    return Object.assign(puller, {
      losses,
      delivered,
      serve: (next: string) => {
        playlist = next;
      },
    });
  }

  // Writing a segment off moves the position to an index nothing was delivered from, so there is no
  // URI belonging to it. Comparing the one from an earlier index against whatever sits there now
  // makes every later poll of an unchanged playlist look like a restart. The written-off segment is
  // the last in the window on purpose: anywhere else the next delivery in the same pass overwrites
  // the stale URI before a second poll can read it, and the defect hides.
  it('does not read a written-off segment as a restart on the next poll', async () => {
    const PLAYLIST = playlistFrom(0, ['seg_0.ts', 'seg_1.ts', 'seg_2.ts', 'seg_3.ts']);
    const puller = drive(PLAYLIST, (uri) => uri !== 'seg_3.ts');

    const logs = await withCapturedLogs(async () => {
      // Three passes write seg_3 off, a fourth reads the same playlist with the position sitting on it.
      for (let i = 0; i < SEGMENT_RETRY_LIMIT + 1; i++) {
        await puller.tick();
      }
    });
    puller.stop();

    assert.ok(
      !logs.errors.some((line) => /Origin restarted/.test(line)),
      `an unchanged playlist was read as a restart after a segment was written off; errors: ${JSON.stringify(
        logs.errors,
      )}`,
    );
  });

  // After a real restart the puller starts over, so the first index of the new session is its new
  // floor. Keeping the old session's floor makes everything between the two look rolled out, and a
  // rollout report marks a discontinuity and moves the counter /health reads.
  it('does not report a gap between the old session floor and the new one', async () => {
    const OLD_SESSION = playlistFrom(0, ['s1_0.ts', 's1_1.ts', 's1_2.ts', 's1_3.ts', 's1_4.ts', 's1_5.ts']);
    // Restarted, and already rolled its own first indexes out of its window: it starts at 3, below
    // the 5 last delivered, so this is a restart, and above the 0 the old session started from.
    const NEW_SESSION = playlistFrom(3, ['s2_3.ts', 's2_4.ts']);
    const puller = drive(OLD_SESSION, () => true);

    await withSilencedLogs(async () => {
      await puller.tick();
      assert.deepEqual(puller.delivered, [0, 1, 2, 3, 4, 5], 'the old session must be delivered first');
      puller.serve(NEW_SESSION);
      await puller.tick();
    });
    puller.stop();

    assert.deepEqual(
      puller.losses,
      [],
      'a restart was reported as lost segments, marking a discontinuity over indexes the new session never had',
    );
  });
});
