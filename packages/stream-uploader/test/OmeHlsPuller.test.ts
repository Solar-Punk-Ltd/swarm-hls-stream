import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Fetcher } from '../src/engines/ome/interfaces.js';
import { DEFAULT_FETCH_TIMEOUT_MS, OmeHlsPuller, SEGMENT_RETRY_LIMIT } from '../src/engines/ome/OmeHlsPuller.js';
import { REJECT_QUEUE_FULL, SegmentResult } from '../src/types.js';

import { waitFor } from './helpers/waiting.js';

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
  /** Two abort windows plus room for a machine running the whole suite at once. Reached only on a hang. */
  const ABORT_RECOVERY_CEILING_MS = 4_000;

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
    const mentionsAbort = (line: string) => /abort|timed out|timeout/i.test(line);

    const puller = makeDrivablePuller(hangingFetcher([], urls), [], [], {
      fetchTimeoutMs: FETCH_TIMEOUT_MS,
      intervalMs: 5,
    });

    try {
      (puller as unknown as { start(): void }).start();
      // A ceiling on a hung test, not a measurement of how long this takes. Sleeping the two abort
      // windows this needs and then asserting made the test a stopwatch on the machine: under a
      // loaded suite the poll loop's timers are starved, the second tick has not run yet, and a
      // correct puller reads as one that stopped after the first abort.
      await waitFor(() => urls.length >= 2 && errors.some(mentionsAbort), ABORT_RECOVERY_CEILING_MS);
      puller.stop();
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }

    assert.ok(urls.length >= 2, `the poll loop kept going after the abort, saw ${urls.length} attempts`);
    assert.ok(
      errors.some(mentionsAbort),
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

/**
 * The handover floor's own failure modes. Every case here was found by a review-gate lens against the
 * first version of the fix, and each one is a way for the floor to destroy media rather than protect
 * it. See CON-20.
 */
describe('OmeHlsPuller handover floor (CON-20)', () => {
  const FLOOR = Date.parse('2026-07-31T12:00:00.000Z');
  const PLAYLIST_URL = 'http://ome/hls/app/stream/ts:playlist.m3u8';

  function stamped(entries: Array<{ uri: string; at: number }>, mediaSeq = 0): string {
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`,
      ...entries.flatMap(({ uri, at }) => [
        `#EXT-X-PROGRAM-DATE-TIME:${new Date(at).toISOString()}`,
        '#EXTINF:2.0,',
        uri,
      ]),
    ].join('\n');
  }

  function drive(playlist: string, options: Record<string, unknown> = {}) {
    const delivered: number[] = [];
    const losses: Array<{ first: number; count: number }> = [];
    const orchestrator = {
      handleSegment: (_id: string, seq: number) => {
        delivered.push(seq);
        return { accepted: true } as SegmentResult;
      },
      handleSegmentLoss: (_id: string, first: number, count: number) => {
        losses.push({ first, count });
        return true;
      },
    } as unknown as OrchestratorArg;

    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === PLAYLIST_URL) {
        return { ok: true, status: 200, text: async () => playlist } as Response;
      }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    }) as unknown as Fetcher;

    const puller = new OmeHlsPuller('app/stream', 'app', 'stream', 'http://ome/hls', 1_000_000, orchestrator, {
      fetcher,
      staleBefore: FLOOR,
      ...options,
    }) as unknown as PullerInternals & { tick(): Promise<void> };

    return { puller, delivered, losses };
  }

  /**
   * A segment under the floor arriving after this session has already delivered something is not a gap
   * in this session's media, but the rolled-out report could not tell the difference: it worked from
   * the high-water alone, so a deliberate skip became an error-level loss and a discontinuity in the
   * manifest, for a segment that was in the playlist and downloadable one tick earlier. That is the
   * very fabrication the register wrongly attributed to the defect this floor exists to fix.
   */
  it('does not announce a segment it skipped on purpose as media the origin rolled out', async () => {
    const { puller, delivered, losses } = drive(
      stamped([
        { uri: 'live_0.ts', at: FLOOR + 2_000 },
        { uri: 'stale_1.ts', at: FLOOR - 5_000 },
        { uri: 'live_2.ts', at: FLOOR + 6_000 },
      ]),
    );

    await withSilencedLogs(() => puller.tick());

    assert.deepEqual(delivered, [0, 2], 'the two live segments should be the ones delivered');
    assert.deepEqual(losses, [], `a deliberate skip was reported as a loss: ${JSON.stringify(losses)}`);
  });

  /**
   * A floor above everything the origin serves discards the whole broadcast, and every signal that
   * could show it is bypassed: nothing is delivered so no gap is reported, and the playlist answers
   * 200 so the not-found halt never fires. An origin clock stepping backwards between two sessions
   * produces exactly that. Giving the floor up costs one playlist window; keeping it costs the stream.
   */
  it('gives up a floor that has matched every segment for too long, and says so', async () => {
    const playlist = stamped([
      { uri: 'a.ts', at: FLOOR - 8_000 },
      { uri: 'b.ts', at: FLOOR - 6_000 },
    ]);
    const { puller, delivered } = drive(playlist, { abandonFloorAfterMs: 0 });

    const logs = await withCapturedLogs(async () => {
      await puller.tick();
      await sleep(5);
      await puller.tick();
      await sleep(5);
      await puller.tick();
    });

    assert.deepEqual(delivered, [0, 1], `the broadcast never arrived, so the floor swallowed it: ${delivered}`);
    assert.ok(
      logs.errors.some((line) => line.includes('cannot be right')),
      `abandoning the floor has to be loud, or a stream recording nothing looks like a quiet one; errors: ${
        logs.errors.join(' | ') || '(none)'
      }`,
    );
  });

  it('keeps a floor that is doing its job rather than giving it up on a timer', async () => {
    let playlist = stamped([
      { uri: 'stale_0.ts', at: FLOOR - 4_000 },
      { uri: 'live_1.ts', at: FLOOR + 2_000 },
    ]);
    const delivered: number[] = [];
    const orchestrator = {
      handleSegment: (_id: string, seq: number) => {
        delivered.push(seq);
        return { accepted: true } as SegmentResult;
      },
      handleSegmentLoss: () => true,
    } as unknown as OrchestratorArg;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith('ts:playlist.m3u8')) {
        return { ok: true, status: 200, text: async () => playlist } as Response;
      }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    }) as unknown as Fetcher;
    const puller = new OmeHlsPuller('app/stream', 'app', 'stream', 'http://ome/hls', 1_000_000, orchestrator, {
      fetcher,
      staleBefore: FLOOR,
      abandonFloorAfterMs: 0,
    }) as unknown as PullerInternals & { tick(): Promise<void> };

    await withSilencedLogs(async () => {
      // Two ordinary passes first, so a retirement rule that ignored how much it was actually skipping
      // would have elapsed its window by now.
      await puller.tick();
      await sleep(5);
      await puller.tick();
      // Only then does a segment of the replaced session turn up. It is the one the floor exists for,
      // and it arrives after the point where a careless timer would already have thrown the floor away.
      playlist = stamped([{ uri: 'stale_2.ts', at: FLOOR - 3_000 }], 2);
      await sleep(5);
      await puller.tick();
    });

    assert.deepEqual(
      delivered,
      [1],
      `the outgoing session's media was delivered, so the floor had been given up before it was needed: ${delivered}`,
    );
  });

  /**
   * Retirement is for a floor that rejects everything the origin keeps producing, not for a pass that
   * happens to contain only stragglers. A straggler is stepped over once and absorbed by the
   * high-water on the next pass, so the run of all-skipped passes that retirement waits for cannot
   * form, and the floor stays in force for the media that comes after.
   */
  it('does not retire the floor over stragglers that are stepped over and then absorbed', async () => {
    let playlist = stamped([
      { uri: 'stale_0.ts', at: FLOOR - 4_000 },
      { uri: 'live_1.ts', at: FLOOR + 2_000 },
    ]);
    const delivered: number[] = [];
    const orchestrator = {
      handleSegment: (_id: string, seq: number) => {
        delivered.push(seq);
        return { accepted: true } as SegmentResult;
      },
      handleSegmentLoss: () => true,
    } as unknown as OrchestratorArg;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith('ts:playlist.m3u8')) {
        return { ok: true, status: 200, text: async () => playlist } as Response;
      }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    }) as unknown as Fetcher;
    const puller = new OmeHlsPuller('app/stream', 'app', 'stream', 'http://ome/hls', 1_000_000, orchestrator, {
      fetcher,
      staleBefore: FLOOR,
      abandonFloorAfterMs: 0,
    }) as unknown as PullerInternals & { tick(): Promise<void> };

    await withSilencedLogs(async () => {
      await puller.tick();
      // Every segment in this pass is under the floor and none has been seen, which is exactly the
      // shape that retires a floor that never delivered anything.
      playlist = stamped(
        [
          { uri: 'stale_2.ts', at: FLOOR - 3_000 },
          { uri: 'stale_3.ts', at: FLOOR - 2_000 },
        ],
        2,
      );
      // Four passes, because retirement needs one pass to start its clock, a second to elapse it, and
      // a third before anything the abandoned floor was holding back can actually be delivered.
      for (let pass = 0; pass < 3; pass++) {
        await sleep(5);
        await puller.tick();
      }
    });

    assert.deepEqual(
      delivered,
      [1],
      `the floor was given up after it had already done its job, so the outgoing session's stragglers were delivered: ${delivered}`,
    );
  });

  // The skip does not advance the high-water during a handover, so an unchanged playlist is re-examined
  // every tick. Logging each time turned a five-segment window into a line every poll interval, for as
  // long as the origin served it.
  it('announces each skipped segment once, not once per poll', async () => {
    const { puller } = drive(
      stamped([
        { uri: 'stale_0.ts', at: FLOOR - 6_000 },
        { uri: 'stale_1.ts', at: FLOOR - 4_000 },
      ]),
    );

    const { infos } = await withCapturedInfo(async () => {
      await puller.tick();
      await sleep(5);
      await puller.tick();
      await sleep(5);
      await puller.tick();
    });

    const skipLines = infos.filter((line) => line.includes('belongs to the session this puller replaced'));
    assert.equal(skipLines.length, 2, `one line per skipped segment, not per poll; got: ${skipLines.join(' | ')}`);
  });
});

async function withCapturedInfo(run: () => Promise<unknown>): Promise<{ infos: string[] }> {
  const { info, error, warn } = console;
  const infos: string[] = [];
  console.info = (...args: unknown[]) => infos.push(args.map(String).join(' '));
  console.error = () => {};
  console.warn = () => {};
  try {
    await run();
    return { infos };
  } finally {
    console.info = info;
    console.error = error;
    console.warn = warn;
  }
}
