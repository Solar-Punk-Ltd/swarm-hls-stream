import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

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
