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
import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { STREAM_STATUS_VOD } from '../src/types.js';

import { makeFakeRecoveryStore, makeRecordingCatalog, makeTestOrchestrator } from './helpers/fakes.js';

/** The catalog entry shape these tests read back, narrowed from what StreamCatalog accepts. */
interface VodEntry {
  state: string;
  duration: number;
}

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
  /**
   * The publisher's socket, which real OME sends on every admission and which is the only field that
   * tells one session of a stream from the next. Captured from a live SRT publish: a session's
   * opening and its closing carry the same port, and two sessions of one stream carry different
   * ones. Omit it to reproduce a payload that carries no session identity at all.
   */
  client?: { address: string; port: number },
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
    const body = JSON.stringify({
      ...(client ? { client } : {}),
      request: { direction: 'incoming', status, url: streamUrl },
    });
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

  function mediaPlaylist(uris: string[], mediaSeq = 0): string {
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`,
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
  function makeOrigin(): { fetcher: Fetcher; restart(next?: string): void; playlistPolls(): number } {
    let session = 's1';
    let playlist = SESSION_PLAYLIST;
    let playlistPolls = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === PLAYLIST_URL) {
        playlistPolls++;
        return { ok: true, status: 200, text: async () => playlist } as Response;
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
      restart: (next?: string) => {
        session = 's2';
        if (next) {
          playlist = next;
        }
      },
      playlistPolls: () => playlistPolls,
    };
  }

  /**
   * Finalizing the outgoing session has to yield to the event loop, or this test proves nothing.
   *
   * The defect lives in the window between a re-announce and the old session leaving the live maps.
   * A fake whose writes resolve without ever yielding closes that window inside one microtask
   * cascade, ahead of the new puller's first tick, so the test passes against code that fails in
   * production on every restart. What reopens it is crossing a macrotask boundary at all, which any
   * real Bee call does and `sleep(0)` already does. The duration below is margin, not the mechanism.
   */
  const FINALIZE_LATENCY_MS = 25;

  // The whole failure is invisible one layer up: the puller keeps polling, every response is a 200,
  // and the orchestrator has an uploader registered throughout. Only what reaches Bee shows that the
  // second session was discarded, so that is where this asserts.
  it('delivers the new session after the origin restarts its media sequence', async () => {
    const uploaded: string[] = [];
    const origin = makeOrigin();
    const engine = createOmeEngine(HLS_BASE, POLL_INTERVAL_MS, {
      admissionSecret: RESTART_SECRET,
      fetcher: origin.fetcher,
    });
    const slowCatalog = {
      addStream: async () => {
        await sleep(FINALIZE_LATENCY_MS);
      },
    } as unknown as StreamCatalog;
    const orchestrator = makeTestOrchestrator(
      {},
      {
        uploadData: async (_stamp: string, data: Uint8Array) => {
          uploaded.push(new TextDecoder().decode(data));
          return { reference: { toHex: () => `ref${uploaded.length}` } };
        },
        uploadPayload: async (index: number) => {
          await sleep(FINALIZE_LATENCY_MS);
          return { reference: { toHex: () => `soc${index}` } };
        },
      },
      undefined,
      slowCatalog,
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

  // The other half of the same window, and the more damaging one. When the restarted origin numbers
  // above where the old session got to, its segments are not absorbed by the duplicate filter, they
  // are accepted: uploaded, added to the outgoing session's manifest, and shipped inside the VOD that
  // finalizes it. One broadcast's media published as part of another's recording. The duration of
  // that VOD is what gives it away, since it can only cover what the first session actually sent.
  it('keeps the restarted origin out of the VOD that finalizes the session it replaced', async () => {
    const SEGMENT_SECONDS = 2;
    const FIRST_SESSION_SEGMENTS = 4;
    const RESTARTED_HIGH = mediaPlaylist(['seg_9.ts', 'seg_10.ts', 'seg_11.ts', 'seg_12.ts'], 9);
    const published: VodEntry[] = [];
    const origin = makeOrigin();
    const engine = createOmeEngine(HLS_BASE, POLL_INTERVAL_MS, {
      admissionSecret: RESTART_SECRET,
      fetcher: origin.fetcher,
    });
    const orchestrator = makeTestOrchestrator(
      {},
      {
        uploadPayload: async (index: number) => {
          await sleep(FINALIZE_LATENCY_MS);
          return { reference: { toHex: () => `soc${index}` } };
        },
      },
      undefined,
      makeRecordingCatalog(published),
    );

    await postAdmission(engine, orchestrator, 'opening', RESTART_SECRET, STREAM_URL);
    await waitFor(() => published.length > 0, DELIVERY_TIMEOUT_MS);

    // The announce comes first and the restarted origin serves media second, which is the order OME
    // gives: the admission webhook is admission control, so the republish does not produce a segment
    // until this call has answered it. Restarting ahead of the announce instead leaves the replaced
    // puller polling an origin nothing has told the engine about, and its high-water is below these
    // indexes, so it delivers them into the session they replace. That window is real but no signal
    // closes it, since a jump from 3 to 9 is what rolling the playlist window forward looks like too.
    // See CON-19.
    await postAdmission(engine, orchestrator, 'opening', RESTART_SECRET, STREAM_URL);
    origin.restart(RESTARTED_HIGH);
    await waitFor(() => published.some((entry) => entry.state === STREAM_STATUS_VOD), DELIVERY_TIMEOUT_MS);
    await postAdmission(engine, orchestrator, 'closing', RESTART_SECRET, STREAM_URL);

    const vods = published.filter((entry) => entry.state === STREAM_STATUS_VOD);
    assert.ok(vods.length > 0, 'the replaced session never published a VOD, so nothing here was exercised');
    assert.equal(
      vods[0].duration,
      SEGMENT_SECONDS * FIRST_SESSION_SEGMENTS,
      `the finalized session's recording runs longer than what it was sent, so the restarted origin's media was published inside it; durations: ${vods
        .map((entry) => entry.duration)
        .join(', ')}`,
    );
  });

  // Dropping the replaced puller from the map without stopping it leaves it polling OME forever for a
  // session nobody can reach: it is no longer under its stream id, so no close, halt or shutdown can
  // ever reach it either. Invisible in what gets uploaded, because its own position is already past
  // everything the restarted origin advertises. A closed stream not polling its origin is the only
  // thing that shows it.
  it('leaves nothing polling the origin once the replaced stream closes', async () => {
    const origin = makeOrigin();
    const engine = createOmeEngine(HLS_BASE, POLL_INTERVAL_MS, {
      admissionSecret: RESTART_SECRET,
      fetcher: origin.fetcher,
    });
    const orchestrator = makeTestOrchestrator();

    await postAdmission(engine, orchestrator, 'opening', RESTART_SECRET, STREAM_URL);
    await waitFor(() => origin.playlistPolls() > 0, DELIVERY_TIMEOUT_MS);

    origin.restart();
    await postAdmission(engine, orchestrator, 'opening', RESTART_SECRET, STREAM_URL);
    await waitFor(() => origin.playlistPolls() > 2, DELIVERY_TIMEOUT_MS);
    await postAdmission(engine, orchestrator, 'closing', RESTART_SECRET, STREAM_URL);

    const afterClose = origin.playlistPolls();
    await sleep(POLL_INTERVAL_MS * 5);

    assert.equal(
      origin.playlistPolls(),
      afterClose,
      'a puller kept polling after its stream closed, so a replaced one was orphaned rather than stopped',
    );
  });
});

/**
 * The mirror image of CON-16, and measured against a real OvenMediaEngine rather than argued from the
 * code. On an abrupt publisher drop OME keeps both the SRT session and its HLS output alive until the
 * peer-idle timeout, which took 5.0s on 2026-07-31 against `airensoft/ovenmediaengine:latest` with
 * this repo's own `Server.xml.template`. A reconnect inside that window is put to the admission
 * webhook first, so the uploader opens a new session, resets its duplicate filter and starts a puller
 * whose high-water is -1, while the playlist the puller reads still holds the previous broadcast.
 *
 * The probe answered the admission at the same point in the tick order the puller polls at, and read
 * `#EXT-X-MEDIA-SEQUENCE:5` with the outgoing session's five segments. So the new session's manifest
 * opens with up to a full playlist window of the previous broadcast, and a VOD is paid for with
 * postage to record it.
 */
describe('createOmeEngine reconnect inside the origin idle window (CON-20)', () => {
  const SECRET = 'reconnect-secret';
  const HLS_BASE = 'http://ome:8081';
  const STREAM_URL = 'srt://ome:10080/video/demo';
  const PLAYLIST_URL = `${HLS_BASE}/video/demo/ts:playlist.m3u8`;
  const POLL_INTERVAL_MS = 20;
  const DELIVERY_TIMEOUT_MS = 5_000;
  const FINALIZE_LATENCY_MS = 25;

  /**
   * OME's own HLS output, including the per-segment `#EXT-X-PROGRAM-DATE-TIME` it emits by default and
   * which the CON-16 fixtures leave out. Both sessions number from zero and reuse the same segment
   * file names, because that is what OME does: it derives them from the app and stream name, so the
   * live capture showed `seg_917977731947844006_0_hls.ts` in two different broadcasts. That leaves the
   * date-time as the only thing in the playlist that tells the two apart.
   */
  function omePlaylist(uris: string[], mediaSeq: number, firstSegmentAt: Date, segmentSeconds: number): string {
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(segmentSeconds)}`,
      `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`,
      ...uris.flatMap((uri, offset) => [
        `#EXT-X-PROGRAM-DATE-TIME:${new Date(firstSegmentAt.getTime() + offset * segmentSeconds * 1000).toISOString()}`,
        `#EXTINF:${segmentSeconds}.0,`,
        uri,
      ]),
    ].join('\n');
  }

  const OUTGOING_SEGMENTS = ['seg_0.ts', 'seg_1.ts', 'seg_2.ts', 'seg_3.ts'];
  const RECONNECTED_SEGMENTS = ['seg_0.ts', 'seg_1.ts', 'seg_2.ts'];

  /**
   * The two sessions run at different segment durations so that the recorded length of a VOD says
   * which broadcast is inside it, not merely how much of something is.
   *
   * With equal durations the assertion was satisfiable by the wrong media: leaking three stale
   * segments and then discarding all three real ones came to the same total as delivering the three
   * real ones, and a mutation that shrank the floor to a single segment passed because of it. No
   * subset of four 2-second segments and three 5-second ones reaches 15 except the three real ones.
   */
  const OUTGOING_SEGMENT_SECONDS = 2;
  const RECONNECTED_SEGMENT_SECONDS = 5;

  /**
   * An origin that keeps serving the outgoing broadcast after its publisher is gone, and only turns
   * over when the test says so. The turnover is explicit because leaving it to timing is what made
   * this reproduce 5 times in 8 rather than every time.
   */
  function makeIdlingOrigin(
    outgoing: string,
    reconnected: string,
  ): {
    fetcher: Fetcher;
    turnOver(): void;
    playlistPolls(): number;
  } {
    let session = 'outgoing';
    let playlist = outgoing;
    let playlistPolls = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === PLAYLIST_URL) {
        playlistPolls++;
        return { ok: true, status: 200, text: async () => playlist } as Response;
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
      turnOver: () => {
        session = 'reconnected';
        playlist = reconnected;
      },
      playlistPolls: () => playlistPolls,
    };
  }

  it('keeps the outgoing broadcast out of the session that replaces it', async () => {
    const outgoingStartedAt = new Date(Date.now() - 60_000);
    const reconnectedStartedAt = new Date(Date.now() - 20_000);
    const published: VodEntry[] = [];
    const uploaded: string[] = [];
    const origin = makeIdlingOrigin(
      omePlaylist(OUTGOING_SEGMENTS, 0, outgoingStartedAt, OUTGOING_SEGMENT_SECONDS),
      omePlaylist(RECONNECTED_SEGMENTS, 0, reconnectedStartedAt, RECONNECTED_SEGMENT_SECONDS),
    );
    const engine = createOmeEngine(HLS_BASE, POLL_INTERVAL_MS, {
      admissionSecret: SECRET,
      fetcher: origin.fetcher,
    });
    const orchestrator = makeTestOrchestrator(
      {},
      {
        uploadData: async (_stamp: string, data: Uint8Array) => {
          uploaded.push(new TextDecoder().decode(data));
          return { reference: { toHex: () => `ref${uploaded.length}` } };
        },
        uploadPayload: async (index: number) => {
          await sleep(FINALIZE_LATENCY_MS);
          return { reference: { toHex: () => `soc${index}` } };
        },
      },
      undefined,
      makeRecordingCatalog(published),
    );

    await postAdmission(engine, orchestrator, 'opening', SECRET, STREAM_URL);
    await waitFor(() => published.length > 0, DELIVERY_TIMEOUT_MS);

    // The reconnect is announced while the origin is still serving the broadcast that is ending, which
    // is the state the live probe found at this exact point. The origin turns over only after the
    // replacement puller has had polls to spend on the stale playlist, so the window is closed by the
    // test rather than by luck.
    const beforeReconnect = origin.playlistPolls();
    await postAdmission(engine, orchestrator, 'opening', SECRET, STREAM_URL);
    await waitFor(() => origin.playlistPolls() > beforeReconnect + 2, DELIVERY_TIMEOUT_MS);
    origin.turnOver();

    await waitFor(() => published.filter((entry) => entry.state === STREAM_STATUS_VOD).length > 1, DELIVERY_TIMEOUT_MS);
    await postAdmission(engine, orchestrator, 'closing', SECRET, STREAM_URL);
    await waitFor(() => published.filter((entry) => entry.state === STREAM_STATUS_VOD).length > 1, DELIVERY_TIMEOUT_MS);

    const vods = published.filter((entry) => entry.state === STREAM_STATUS_VOD);
    assert.equal(
      vods.length,
      2,
      `both sessions have to reach a VOD or there is nothing to compare; durations: ${vods
        .map((entry) => entry.duration)
        .join(', ')}`,
    );
    assert.equal(
      vods[0].duration,
      OUTGOING_SEGMENT_SECONDS * OUTGOING_SEGMENTS.length,
      `the outgoing session's own recording is wrong, so the reconnected one below proves nothing; durations: ${vods
        .map((entry) => entry.duration)
        .join(', ')}`,
    );
    assert.equal(
      vods[1].duration,
      RECONNECTED_SEGMENT_SECONDS * RECONNECTED_SEGMENTS.length,
      `the reconnected session's recording is not the length of what it broadcast, so the outgoing session's media was published inside it; durations: ${vods
        .map((entry) => entry.duration)
        .join(', ')}`,
    );

    // The durations above are aggregates, and an aggregate cannot say whose media it is made of. This
    // fixture labels every segment body with the session that served it, and until these two lines
    // existed it labelled them for nobody: making both sessions return byte-identical bodies, or
    // making the origin switch playlists while still serving the outgoing bytes, left the whole suite
    // green. The second of those is the shape of the defect under test, since OME reuses its segment
    // file names across broadcasts.
    assert.equal(
      uploaded.filter((body) => body.startsWith('outgoing-')).length,
      OUTGOING_SEGMENTS.length,
      `more of the outgoing broadcast reached Bee than it ever served, so its media was uploaded a second time inside the session that replaced it; uploaded: ${uploaded.join(
        ', ',
      )}`,
    );
    assert.equal(
      uploaded.filter((body) => body.startsWith('reconnected-')).length,
      RECONNECTED_SEGMENTS.length,
      `the reconnected broadcast did not all reach Bee; uploaded: ${uploaded.join(', ')}`,
    );
  });

  function undatedPlaylist(uris: string[], segmentSeconds: number): string {
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(segmentSeconds)}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      ...uris.flatMap((uri) => [`#EXTINF:${segmentSeconds}.0,`, uri]),
    ].join('\n');
  }

  /**
   * A segment with no date-time under a floor is undecidable, not stale, and the two directions fail
   * very differently. Dropping it loses a live broadcast for as long as the origin keeps publishing
   * that way, silently, which is the CON-16 failure this register rates worst. Delivering it costs at
   * most the stale window once. So the undecidable case degrades to the behaviour that predates the
   * floor, and it is pinned here because nothing else in the suite could tell the two apart.
   */
  it('still delivers a session whose segments carry no date-time to judge them by', async () => {
    const outgoingStartedAt = new Date(Date.now() - 60_000);
    const published: VodEntry[] = [];
    const origin = makeIdlingOrigin(
      omePlaylist(OUTGOING_SEGMENTS, 0, outgoingStartedAt, OUTGOING_SEGMENT_SECONDS),
      undatedPlaylist(RECONNECTED_SEGMENTS, RECONNECTED_SEGMENT_SECONDS),
    );
    const engine = createOmeEngine(HLS_BASE, POLL_INTERVAL_MS, {
      admissionSecret: SECRET,
      fetcher: origin.fetcher,
    });
    const orchestrator = makeTestOrchestrator(
      {},
      {
        uploadPayload: async (index: number) => {
          await sleep(FINALIZE_LATENCY_MS);
          return { reference: { toHex: () => `soc${index}` } };
        },
      },
      undefined,
      makeRecordingCatalog(published),
    );

    await postAdmission(engine, orchestrator, 'opening', SECRET, STREAM_URL);
    await waitFor(() => published.length > 0, DELIVERY_TIMEOUT_MS);

    const beforeReconnect = origin.playlistPolls();
    await postAdmission(engine, orchestrator, 'opening', SECRET, STREAM_URL);
    await waitFor(() => origin.playlistPolls() > beforeReconnect + 2, DELIVERY_TIMEOUT_MS);
    origin.turnOver();

    await waitFor(() => published.filter((entry) => entry.state === STREAM_STATUS_VOD).length > 1, DELIVERY_TIMEOUT_MS);
    await postAdmission(engine, orchestrator, 'closing', SECRET, STREAM_URL);
    await waitFor(() => published.filter((entry) => entry.state === STREAM_STATUS_VOD).length > 1, DELIVERY_TIMEOUT_MS);

    const vods = published.filter((entry) => entry.state === STREAM_STATUS_VOD);
    assert.equal(
      vods.length,
      2,
      `the undated session never reached a VOD at all, so the floor swallowed a live broadcast; durations: ${vods
        .map((entry) => entry.duration)
        .join(', ')}`,
    );
    assert.equal(
      vods[1].duration,
      RECONNECTED_SEGMENT_SECONDS * RECONNECTED_SEGMENTS.length,
      `the undated session's media did not all reach its recording, so the floor is dropping segments it cannot judge; durations: ${vods
        .map((entry) => entry.duration)
        .join(', ')}`,
    );
  });

  /**
   * The sequence a real OME produces, and the one that defeated the first version of this fix.
   *
   * When a broadcaster reconnects inside the idle window OME answers the admission webhook, then
   * rejects the publish as a duplicate stream name and sends `closing` 111ms later. A broadcaster
   * whose client retries again therefore announces after a close, not after another open. Reading the
   * floor off the outgoing puller lost it there, because the close had already destroyed the puller,
   * and the warning that should have said so was itself gated on the puller still existing.
   */
  it('still knows where the outgoing broadcast ended after a closing has come and gone', async () => {
    const outgoingStartedAt = new Date(Date.now() - 60_000);
    const reconnectedStartedAt = new Date(Date.now() - 20_000);
    const published: VodEntry[] = [];
    const uploaded: string[] = [];
    const origin = makeIdlingOrigin(
      omePlaylist(OUTGOING_SEGMENTS, 0, outgoingStartedAt, OUTGOING_SEGMENT_SECONDS),
      omePlaylist(RECONNECTED_SEGMENTS, 0, reconnectedStartedAt, RECONNECTED_SEGMENT_SECONDS),
    );
    const engine = createOmeEngine(HLS_BASE, POLL_INTERVAL_MS, {
      admissionSecret: SECRET,
      fetcher: origin.fetcher,
    });
    const orchestrator = makeTestOrchestrator(
      {},
      {
        uploadData: async (_stamp: string, data: Uint8Array) => {
          uploaded.push(new TextDecoder().decode(data));
          return { reference: { toHex: () => `ref${uploaded.length}` } };
        },
        uploadPayload: async (index: number) => {
          await sleep(FINALIZE_LATENCY_MS);
          return { reference: { toHex: () => `soc${index}` } };
        },
      },
      undefined,
      makeRecordingCatalog(published),
    );

    await postAdmission(engine, orchestrator, 'opening', SECRET, STREAM_URL);
    await waitFor(() => uploaded.length >= OUTGOING_SEGMENTS.length, DELIVERY_TIMEOUT_MS);

    // The rejected republish: OME opens, is refused the name, and closes again.
    await postAdmission(engine, orchestrator, 'closing', SECRET, STREAM_URL);

    const beforeRetry = origin.playlistPolls();
    await postAdmission(engine, orchestrator, 'opening', SECRET, STREAM_URL);
    await waitFor(() => origin.playlistPolls() > beforeRetry + 2, DELIVERY_TIMEOUT_MS);
    origin.turnOver();
    await waitFor(
      () => uploaded.filter((body) => body.startsWith('reconnected-')).length === RECONNECTED_SEGMENTS.length,
      DELIVERY_TIMEOUT_MS,
    );
    await postAdmission(engine, orchestrator, 'closing', SECRET, STREAM_URL);

    assert.equal(
      uploaded.filter((body) => body.startsWith('outgoing-')).length,
      OUTGOING_SEGMENTS.length,
      `the outgoing broadcast was uploaded again after a closing destroyed the puller holding the boundary; uploaded: ${uploaded.join(
        ', ',
      )}`,
    );
  });

  // The protection is only as real as the origin's date-times, and an origin that publishes none
  // leaves the uploader exactly where it was before this fix. That has to be audible: nothing about a
  // floor matching zero segments looks different from a floor holding, and this repo has already
  // shipped two green suites over defects that were stubbed out of view.
  it('says so when the origin gives it nothing to tell the two sessions apart', async () => {
    const undated = undatedPlaylist(OUTGOING_SEGMENTS, OUTGOING_SEGMENT_SECONDS);
    const origin = makeIdlingOrigin(undated, undated);
    const engine = createOmeEngine(HLS_BASE, POLL_INTERVAL_MS, {
      admissionSecret: SECRET,
      fetcher: origin.fetcher,
    });
    const orchestrator = makeTestOrchestrator();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
    try {
      await postAdmission(engine, orchestrator, 'opening', SECRET, STREAM_URL);
      await waitFor(() => origin.playlistPolls() > 0, DELIVERY_TIMEOUT_MS);
      await postAdmission(engine, orchestrator, 'opening', SECRET, STREAM_URL);
      await postAdmission(engine, orchestrator, 'closing', SECRET, STREAM_URL);
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(
      warnings.some((line) => line.includes('EXT-X-PROGRAM-DATE-TIME') && line.includes('video/demo')),
      `replacing a puller with no date-time to go on has to be reported, or an unprotected deployment looks like a protected one; warnings: ${
        warnings.join(' | ') || '(none)'
      }`,
    );
  });
});

/**
 * CON-21: a `closing` carries no session identity, so a delayed one can finalize the session that
 * replaced the session it was actually sent for.
 *
 * The `closing` branch keys on the stream URL alone and stops whatever currently holds that id. Two
 * admissions for one stream are independent HTTP requests against a 3000ms admission timeout, so a
 * slow `closing` for a dropped session can be processed after an `opening` that OME did admit.
 *
 * The reachability reported by the PR #43 concurrency lens is refuted in the register: OME rejects a
 * reconnect admitted while the dropped session is still up, 4 of 4, so the ordinary timeline lands
 * both closings first. What remains is the reordered webhook, which is what this drives.
 *
 * The fix rests on a measurement rather than on the interface. A real OME publish, kill and
 * republish on 2026-08-01 produced four admissions carrying `client.port`, and the port matches its
 * own session's opening and closing while differing between sessions: 44546 for the first, 22138 for
 * the second. The interface declares that field optional; a real SRT publish always populates it.
 */
describe('createOmeEngine reordered closing (CON-21)', () => {
  const SECRET = 'session-identity-secret';
  const HLS_BASE = 'http://ome:8081';
  const STREAM_URL = 'srt://ome:10080/video/demo';
  const PLAYLIST_URL = `${HLS_BASE}/video/demo/ts:playlist.m3u8`;
  const POLL_INTERVAL_MS = 20;
  const SETTLE_MS = 5_000;

  // The two sockets the live capture recorded, kept as the real numbers so the fixture cannot drift
  // into a shape OME does not produce.
  const SESSION_A = { address: '192.168.65.1', port: 44546 };
  const SESSION_B = { address: '192.168.65.1', port: 22138 };

  const PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PROGRAM-DATE-TIME:2026-08-01T00:00:00.000+00:00',
    '#EXTINF:2.000,',
    'seg_0_hls.ts',
    '',
  ].join('\n');

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.OME_HLS_BASE_URL = HLS_BASE;
    process.env.OME_HLS_POLL_INTERVAL_MS = String(POLL_INTERVAL_MS);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function makePollCountingOrigin(): { fetcher: Fetcher; polls(): number } {
    let polls = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === PLAYLIST_URL) {
        polls++;
        return { ok: true, status: 200, text: async () => PLAYLIST } as Response;
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('seg').buffer,
      } as Response;
    }) as unknown as Fetcher;
    return { fetcher, polls: () => polls };
  }

  it('leaves the live session alone when a closing for the session it replaced arrives late', async () => {
    const origin = makePollCountingOrigin();
    const engine = createOmeEngine(HLS_BASE, POLL_INTERVAL_MS, { admissionSecret: SECRET, fetcher: origin.fetcher });
    const published: VodEntry[] = [];
    const orchestrator = makeTestOrchestrator({}, {}, makeFakeRecoveryStore(), makeRecordingCatalog(published));

    // Session A publishes, then drops without a clean close.
    await postAdmission(engine, orchestrator, 'opening', SECRET, STREAM_URL, SESSION_A);
    await waitFor(() => origin.polls() > 0, SETTLE_MS);

    // Session B reconnects and is admitted, replacing A. Replacing A finalizes A, so A's own VOD is
    // expected here and is not the defect. What must not happen is a second one.
    await postAdmission(engine, orchestrator, 'opening', SECRET, STREAM_URL, SESSION_B);
    const pollsWhenBWasLive = origin.polls();
    await waitFor(() => origin.polls() > pollsWhenBWasLive, SETTLE_MS);
    const vodsBeforeStaleClosing = published.filter((entry) => entry.state === STREAM_STATUS_VOD).length;

    // A's closing finally arrives, out of order, carrying A's socket rather than B's.
    await postAdmission(engine, orchestrator, 'closing', SECRET, STREAM_URL, SESSION_A);

    const pollsAfterStaleClosing = origin.polls();
    await sleep(POLL_INTERVAL_MS * 8);

    assert.ok(
      origin.polls() > pollsAfterStaleClosing,
      `a closing for a session that has already been replaced must not stop the live puller, but polling stopped at ${pollsAfterStaleClosing}`,
    );
    assert.equal(
      published.filter((entry) => entry.state === STREAM_STATUS_VOD).length,
      vodsBeforeStaleClosing,
      'the live session was VOD-finalized by a closing that was sent for the session it replaced',
    );
  });

  it('still stops the stream when the closing matches the live session', async () => {
    // The guard must not turn into a stream that never finalizes, which would be the worse failure:
    // a leaked puller and no VOD at all.
    const origin = makePollCountingOrigin();
    const engine = createOmeEngine(HLS_BASE, POLL_INTERVAL_MS, { admissionSecret: SECRET, fetcher: origin.fetcher });
    const published: VodEntry[] = [];
    const orchestrator = makeTestOrchestrator({}, {}, makeFakeRecoveryStore(), makeRecordingCatalog(published));

    await postAdmission(engine, orchestrator, 'opening', SECRET, STREAM_URL, SESSION_A);
    await waitFor(() => origin.polls() > 0, SETTLE_MS);
    await postAdmission(engine, orchestrator, 'closing', SECRET, STREAM_URL, SESSION_A);

    await waitFor(() => published.some((entry) => entry.state === STREAM_STATUS_VOD), SETTLE_MS);
    assert.equal(
      published.filter((entry) => entry.state === STREAM_STATUS_VOD).length,
      1,
      'a closing carrying the live session’s own socket has to finalize it',
    );
  });

  it('stops the stream when the payload carries no session identity at all', async () => {
    // OME populates client on every real SRT publish, but the field is optional in the protocol and a
    // future transport might omit it. Refusing to stop without evidence would leak the stream, so the
    // guard is strict only when it has an identity to be strict with.
    const origin = makePollCountingOrigin();
    const engine = createOmeEngine(HLS_BASE, POLL_INTERVAL_MS, { admissionSecret: SECRET, fetcher: origin.fetcher });
    const published: VodEntry[] = [];
    const orchestrator = makeTestOrchestrator({}, {}, makeFakeRecoveryStore(), makeRecordingCatalog(published));

    await postAdmission(engine, orchestrator, 'opening', SECRET, STREAM_URL);
    await waitFor(() => origin.polls() > 0, SETTLE_MS);
    await postAdmission(engine, orchestrator, 'closing', SECRET, STREAM_URL);

    await waitFor(() => published.some((entry) => entry.state === STREAM_STATUS_VOD), SETTLE_MS);
    assert.equal(
      published.filter((entry) => entry.state === STREAM_STATUS_VOD).length,
      1,
      'a payload with no client cannot be matched, so the closing has to be honoured rather than dropped',
    );
  });
});
