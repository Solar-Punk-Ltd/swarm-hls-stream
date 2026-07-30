import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Fetcher } from '../src/engines/ome/interfaces.js';
import { OmeHlsPuller } from '../src/engines/ome/OmeHlsPuller.js';
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

  function makeDrivablePuller(fetcher: Fetcher, pulled: number[] = []): PullerDriver {
    const orchestrator = {
      handleSegment: (_id: string, seq: number) => {
        pulled.push(seq);
        return { accepted: true };
      },
    } as unknown as OrchestratorArg;

    // A huge interval so the puller's own scheduled ticks never fire and the test drives tick() itself.
    return new OmeHlsPuller('stream-test', 'app', 'stream', 'http://ome/hls', 1_000_000, orchestrator, {
      fetcher,
    }) as unknown as PullerDriver;
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
    const puller = makeDrivablePuller(routedFetcher({ [MASTER_URL]: { status: 404 } }, calls), pulled);

    await puller.tick();
    await puller.tick();
    puller.stop();

    assert.deepEqual(pulled, [], 'nothing is published while the playlist is missing');
    assert.deepEqual(
      calls,
      [MASTER_URL, MASTER_URL],
      'a 404 leaves the puller retrying the master rather than latching a dead variant',
    );
  });

  it('blocks the tick while a fetch hangs, which is the gap S2.2 closes', async () => {
    const puller = makeDrivablePuller((() => new Promise(() => {})) as unknown as Fetcher);

    const settled = await Promise.race([puller.tick().then(() => 'settled'), sleep(80).then(() => 'still-pending')]);
    puller.stop();

    assert.equal(
      settled,
      'still-pending',
      'no fetch here has a timeout, so one black-holed connection stalls the poll loop indefinitely',
    );
  });
});
