import express from 'express';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { createOmeEngine, createOmeEngineFromEnv } from '../src/engines/ome.js';
import { Fetcher } from '../src/engines/ome/interfaces.js';
import { DEFAULT_FETCH_TIMEOUT_MS } from '../src/engines/ome/OmeHlsPuller.js';
import { EnginePlugin, RawBodyRequest } from '../src/engines/types.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';

import { makeTestOrchestrator } from './helpers/fakes.js';

/**
 * Posts a signed admission webhook to the engine's real route over HTTP, the way OME does. Every hop
 * the engine takes on an announce is behind this call: signature check, app/stream parse, the
 * orchestrator handoff, and the puller lifecycle.
 */
async function postAdmission(
  engine: EnginePlugin,
  orchestrator: StreamOrchestrator,
  status: 'opening' | 'closing',
  secret: string,
  streamUrl: string,
): Promise<void> {
  const app = express();
  // Mirrors the raw-body capture in api/server.ts, which is what the signature is computed over.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf;
      },
    }),
  );
  app.use(engine.prefix, engine.createRouter(orchestrator));

  const server = app.listen(0);
  try {
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const body = JSON.stringify({ request: { direction: 'incoming', status, url: streamUrl } });
    await fetch(`http://127.0.0.1:${port}${engine.prefix}/admission`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ome-signature': createHmac('sha1', secret).update(Buffer.from(body)).digest('base64url'),
      },
      body,
    });
  } finally {
    server.close();
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await sleep(10);
  }
}

// A recovered OME stream gets no fresh admission (the broadcaster's SRT session stayed open across the
// uploader crash), so resumeRecoveredStream must restart the HLS puller itself — proven here by the
// puller polling the stream's OME playlist. Without the fix nothing pulls and the stream is VOD-ed at
// the recovery timer.
describe('createOmeEngine resumeRecoveredStream (F: OME crash recovery)', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchedUrls: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchedUrls = [];
    // A 404 with a long poll interval means the puller polls once then idles far out of the test
    // window, so a single recorded fetch is enough to prove it started.
    globalThis.fetch = (async (input: string | URL) => {
      fetchedUrls.push(input.toString());
      return { ok: false, status: 404, text: async () => '' } as Response;
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('restarts the HLS puller for a recovered stream (polls its OME playlist)', async () => {
    const engine = createOmeEngine('http://ome:8081', 60_000);
    const orchestrator = {
      handleSegment: () => ({ accepted: true }),
      stopStream: async () => {},
    } as unknown as StreamOrchestrator;

    const { resumeRecoveredStream } = engine;
    assert.ok(resumeRecoveredStream, 'OME engine must expose resumeRecoveredStream');

    resumeRecoveredStream(orchestrator, 'video/stream');
    await sleep(50);

    assert.ok(
      fetchedUrls.includes('http://ome:8081/video/stream/ts:playlist.m3u8'),
      `resuming a recovered OME stream must restart its puller; fetched: ${fetchedUrls.join(', ') || '(none)'}`,
    );
  });
});

describe('createOmeEngineFromEnv validation (OBS-12)', () => {
  const OME_VARS = ['OME_ADMISSION_SECRET', 'OME_FETCH_TIMEOUT_MS', 'OME_HLS_POLL_INTERVAL_MS'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(OME_VARS.map((name) => [name, process.env[name]]));
    process.env.OME_ADMISSION_SECRET = 'test-secret';
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  // Each of these ran happily past startup and only showed up once a stream started pulling: zero
  // aborted every request, the overflow was clamped to 1ms while the log reported the window the
  // operator wrote, and the negative threw a RangeError per tick so no HTTP request was ever made.
  for (const badWindow of ['0', '-1', '2147483648', '10s']) {
    it(`refuses to build an engine with OME_FETCH_TIMEOUT_MS=${badWindow}`, () => {
      process.env.OME_FETCH_TIMEOUT_MS = badWindow;

      assert.throws(() => createOmeEngineFromEnv(), { message: /OME_FETCH_TIMEOUT_MS/ });
    });
  }

  it('builds an engine when the window is a usable integer', () => {
    process.env.OME_FETCH_TIMEOUT_MS = '2500';

    assert.equal(createOmeEngineFromEnv().name, 'ome');
  });
});

describe('createOmeEngineFromEnv fetch timeout plumbing (TEST-15)', () => {
  const CONFIGURED_WINDOW_MS = 150;
  const PLUMBING_SECRET = 'plumbing-secret';
  const STREAM_URL = 'srt://ome:10080/video/demo';
  const ENV_VARS = ['OME_ADMISSION_SECRET', 'OME_FETCH_TIMEOUT_MS', 'OME_HLS_POLL_INTERVAL_MS', 'OME_HLS_URL'] as const;

  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_VARS.map((name) => [name, process.env[name]]));
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  // OME_FETCH_TIMEOUT_MS reached the puller through four hops and no test crossed any of them, so
  // each hop could be severed with the whole suite, typecheck and lint still green. The window is
  // measured here rather than read back, because nothing exposes the number an AbortSignal carries.
  it('applies the environment window to the pullers it starts', async () => {
    process.env.OME_ADMISSION_SECRET = PLUMBING_SECRET;
    process.env.OME_FETCH_TIMEOUT_MS = String(CONFIGURED_WINDOW_MS);
    // One poll inside the test window, so the abort measured below is the first fetch and only fetch.
    process.env.OME_HLS_POLL_INTERVAL_MS = '1000000';
    process.env.OME_HLS_URL = 'http://ome:8081';

    const abortDelaysMs: number[] = [];
    const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const startedAt = performance.now();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          abortDelaysMs.push(performance.now() - startedAt);
          reject(init.signal?.reason);
        });
      });
    }) as unknown as Fetcher;

    const engine = createOmeEngineFromEnv({ fetcher });
    const orchestrator = {
      startStream: () => true,
      stopStream: async () => {},
      handleSegment: () => ({ accepted: true }),
      handleSegmentLoss: () => true,
    } as unknown as StreamOrchestrator;

    await postAdmission(engine, orchestrator, 'opening', PLUMBING_SECRET, STREAM_URL);
    await waitFor(() => abortDelaysMs.length > 0, DEFAULT_FETCH_TIMEOUT_MS / 5);
    await postAdmission(engine, orchestrator, 'closing', PLUMBING_SECRET, STREAM_URL);

    assert.equal(
      abortDelaysMs.length,
      1,
      `the puller's fetch never aborted inside ${
        DEFAULT_FETCH_TIMEOUT_MS / 5
      }ms, so it is not running on the configured ${CONFIGURED_WINDOW_MS}ms window`,
    );
    assert.ok(
      abortDelaysMs[0] >= CONFIGURED_WINDOW_MS - 20,
      `aborted after ${abortDelaysMs[0]}ms, far below the configured ${CONFIGURED_WINDOW_MS}ms, so the window is not the one that was set`,
    );
    assert.ok(
      abortDelaysMs[0] < DEFAULT_FETCH_TIMEOUT_MS,
      `aborted after ${abortDelaysMs[0]}ms, which is the built-in default rather than the configured window`,
    );
  });
});

describe('createOmeEngine origin restart (CON-16)', () => {
  const RESTART_SECRET = 'restart-secret';
  const HLS_BASE = 'http://ome:8081';
  const STREAM_URL = 'srt://ome:10080/video/demo';
  const PLAYLIST_URL = `${HLS_BASE}/video/demo/ts:playlist.m3u8`;
  const POLL_INTERVAL_MS = 20;
  const DELIVERY_TIMEOUT_MS = 5_000;

  function mediaPlaylist(uris: string[]): string {
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:0',
      ...uris.flatMap((uri) => ['#EXTINF:2.0,', uri]),
    ].join('\n');
  }

  // Deliberately the same four names in both sessions. A restarted OME reuses its segment file names,
  // and the puller's own restart detection is blind here by construction: the indexes are the ones it
  // already delivered and the names at them are unchanged, so this playlist is indistinguishable from
  // an idle poll. Replacing the puller on the announce is the only thing that can rescue it, which is
  // what makes this test fail if the engine half of the fix is removed.
  const SESSION_PLAYLIST = mediaPlaylist(['seg_0.ts', 'seg_1.ts', 'seg_2.ts', 'seg_3.ts']);

  /**
   * An origin whose segment bodies carry the session they belong to, so what reached Bee says which
   * session produced it. Both sessions number from `#EXT-X-MEDIA-SEQUENCE:0`, which is what a
   * restarted OME serves and what puts the new indexes at or below the ones already delivered.
   */
  function makeOrigin(): { fetcher: Fetcher; restart(): void } {
    let session = 's1';
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === PLAYLIST_URL) {
        return { ok: true, status: 200, text: async () => SESSION_PLAYLIST } as Response;
      }
      const body = `${session}-${url.slice(url.lastIndexOf('/') + 1)}`;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      } as Response;
    }) as unknown as Fetcher;

    return {
      fetcher,
      restart: () => {
        session = 's2';
      },
    };
  }

  // The whole failure is invisible one layer up: the puller keeps polling, every response is a 200,
  // and the orchestrator has a healthy-looking uploader. Only what reaches Bee shows that the second
  // session was discarded, so that is where this asserts.
  it('delivers the new session after the origin restarts its media sequence', async () => {
    const uploaded: string[] = [];
    const origin = makeOrigin();
    const engine = createOmeEngine(HLS_BASE, POLL_INTERVAL_MS, {
      admissionSecret: RESTART_SECRET,
      fetcher: origin.fetcher,
    });
    const orchestrator = makeTestOrchestrator(
      {},
      {
        uploadData: async (_stamp: string, data: Uint8Array) => {
          uploaded.push(new TextDecoder().decode(data));
          return { reference: { toHex: () => `ref${uploaded.length}` } };
        },
      },
    );

    await postAdmission(engine, orchestrator, 'opening', RESTART_SECRET, STREAM_URL);
    await waitFor(() => uploaded.some((body) => body.startsWith('s1-')), DELIVERY_TIMEOUT_MS);
    assert.ok(
      uploaded.some((body) => body.startsWith('s1-')),
      'the first session never reached Bee, so the test proves nothing about the second',
    );

    origin.restart();
    // OME announces the new session exactly as it announced the first one.
    await postAdmission(engine, orchestrator, 'opening', RESTART_SECRET, STREAM_URL);
    await waitFor(() => uploaded.some((body) => body.startsWith('s2-')), DELIVERY_TIMEOUT_MS);
    await postAdmission(engine, orchestrator, 'closing', RESTART_SECRET, STREAM_URL);

    assert.ok(
      uploaded.some((body) => body.startsWith('s2-')),
      `nothing from the restarted origin was ever uploaded, so the stream is silent for good; uploaded: ${
        uploaded.join(', ') || '(nothing)'
      }`,
    );
  });
});
