import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { createOmeEngine, createOmeEngineFromEnv } from '../src/engines/ome.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';

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
