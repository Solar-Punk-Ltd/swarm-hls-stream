import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  HEALTH_DEGRADED,
  HEALTH_OK,
  HEALTH_REASON_QUEUE_PRESSURE,
  HEALTH_REASON_SEGMENT_STALL,
  HEALTH_REASON_SEGMENT_UPLOAD_FAILURE,
  HEALTH_REASON_STALE_MANIFEST,
  MEDIA_TYPE_VIDEO,
  StreamState,
} from '../src/types.js';
import { MANIFEST_FAILURE_THRESHOLD } from '../src/utils/health.js';

import { ApiTestServer, startTestApi } from './helpers/apiTestServer.js';
import { makeFakeRecoveryStore, makeTestOrchestrator, neverSettles, rejectImmediately } from './helpers/fakes.js';

const STREAM_ID = 'live/one';

interface HealthBody {
  status?: string;
  reasons?: string[];
  activeStreams?: number;
  maxConsecutiveManifestFailures?: number;
}

function hasActiveStreams(count: number): (body: unknown) => boolean {
  return (body) => (body as HealthBody).activeStreams === count;
}

function hasManifestFailures(count: number): (body: unknown) => boolean {
  return (body) => (body as HealthBody).maxConsecutiveManifestFailures === count;
}

function startStream(api: ApiTestServer, streamId = STREAM_ID): Promise<unknown> {
  return api.request('/stream/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ streamId, mediatype: MEDIA_TYPE_VIDEO }),
  });
}

function recoveredState(streamId: string): StreamState {
  return {
    streamId,
    streamRawTopic: 'topic-xyz',
    mediatype: MEDIA_TYPE_VIDEO,
    socIndex: 3,
    segments: [{ index: 0, duration: 2, ref: 'ref0', discontinuity: false }],
    hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
    isFirstSegmentReady: true,
    isFirstManifestReady: true,
    pendingDiscontinuity: false,
    liveManifestStale: false,
    updatedAt: Date.now(),
  };
}

function postSegment(api: ApiTestServer, index: number, streamId = STREAM_ID) {
  return api.request('/stream/segment', {
    method: 'POST',
    headers: {
      'content-type': 'video/mp2t',
      'x-stream-id': streamId,
      'x-segment-index': String(index),
      'x-duration': '2',
    },
    body: Buffer.from(`segment-${index}`),
  });
}

describe('api server over http (S0.7 test layer)', () => {
  const servers: ApiTestServer[] = [];

  async function start(...args: Parameters<typeof startTestApi>): Promise<ApiTestServer> {
    const server = await startTestApi(...args);
    servers.push(server);
    return server;
  }

  after(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  it('serves GET /health with the documented body', async () => {
    const api = await start(makeTestOrchestrator());

    const { status, body } = await api.request('/health');

    assert.equal(status, 200, 'an idle uploader is healthy');
    assert.deepEqual(
      Object.keys(body as object).sort(),
      [
        'activeStreams',
        'engines',
        'maxConsecutiveManifestFailures',
        'maxConsecutiveSegmentFailures',
        'msSinceStreamActivity',
        'queuePressure',
        'reasons',
        'staleManifestStreams',
        'status',
      ].sort(),
      // health.sh reads only the status code (curl -o /dev/null), so the body's consumer is the e2e
      // suite in streaming-infra-manager, which asserts on status and activeStreams.
      'the health body is a published contract',
    );
  });

  it('answers an unknown path with the api error envelope', async () => {
    const api = await start(makeTestOrchestrator());

    const { status, body } = await api.request('/nope');

    assert.equal(status, 404);
    assert.deepEqual(body, { ok: false, error: 'Not found', statusCode: 404 });
  });

  it('rejects POST /stream/start without a mediatype through the error handler', async () => {
    const api = await start(makeTestOrchestrator());

    const { status, body } = await api.request('/stream/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamId: 'live/one' }),
    });

    assert.equal(status, 400, 'json body parsing and ApiError both run in the real middleware chain');
    assert.deepEqual(body, { ok: false, error: 'streamId and mediatype are required', statusCode: 400 });
  });

  it('accepts a segment for a started stream', async () => {
    const api = await start(makeTestOrchestrator());

    await startStream(api);
    // startStream queues uploader construction, so the stream is not addressable on return.
    await api.requestUntil('/health', hasActiveStreams(1));

    const { status, body } = await postSegment(api, 0);

    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, queued: true });
  });

  it('answers a segment for an unknown stream with 404', async () => {
    const api = await start(makeTestOrchestrator());

    const { status, body } = await postSegment(api, 0, 'live/ghost');

    assert.equal(status, 404);
    assert.deepEqual(body, { ok: false, error: 'Unknown stream: live/ghost', statusCode: 404 });
  });
});

describe('GET /health status (S2.1)', () => {
  const servers: ApiTestServer[] = [];

  async function start(...args: Parameters<typeof startTestApi>): Promise<ApiTestServer> {
    const server = await startTestApi(...args);
    servers.push(server);
    return server;
  }

  after(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  it('reports ok while a stream is uploading normally', async () => {
    const api = await start(makeTestOrchestrator());

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1));
    await postSegment(api, 0);

    const { status, body } = await api.request('/health');

    assert.equal(status, 200);
    assert.equal((body as HealthBody).status, HEALTH_OK);
    assert.deepEqual((body as HealthBody).reasons, []);
  });

  it('reports degraded and 503 once the segment queue backs up', async () => {
    // A Bee that accepts the connection and never answers: the first segment occupies the queue's
    // single slot and the second one waits, which is a full queue at maxQueueSize 1.
    const api = await start(makeTestOrchestrator({ maxQueueSize: 1 }, { uploadData: neverSettles }));

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1));
    await postSegment(api, 0);
    await postSegment(api, 1);

    const { status, body } = await api.request('/health');

    assert.equal(status, 503, 'a non-200 is what health.sh reports as a warning');
    assert.equal((body as HealthBody).status, HEALTH_DEGRADED);
    assert.deepEqual((body as HealthBody).reasons, [HEALTH_REASON_QUEUE_PRESSURE]);
  });

  it('reports degraded and 503 after three consecutive live-manifest publish failures', async () => {
    // Segment uploads succeed and only the manifest SOC write is refused, which is the state that
    // used to report ok: segments land in Swarm while the live playlist stops advancing.
    const api = await start(makeTestOrchestrator({}, { uploadPayload: rejectImmediately }));

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1));

    for (let failures = 1; failures <= MANIFEST_FAILURE_THRESHOLD; failures++) {
      await postSegment(api, failures - 1);
      // One segment at a time: a manifest publish already queued is not queued twice, so feeding
      // segments in a batch would not produce one failure each.
      const { status, body } = await api.requestUntil('/health', hasManifestFailures(failures));

      if (failures < MANIFEST_FAILURE_THRESHOLD) {
        assert.equal(status, 200, `${failures} failure(s) self-heal on the next segment, so health holds at ok`);
        assert.equal((body as HealthBody).status, HEALTH_OK);
      }
    }

    const { status, body } = await api.request('/health');

    assert.equal(status, 503);
    assert.equal((body as HealthBody).status, HEALTH_DEGRADED);
    assert.deepEqual((body as HealthBody).reasons, [HEALTH_REASON_STALE_MANIFEST]);
  });

  it('reports degraded and 503 when accepted segments are not reaching swarm', async () => {
    // The stamp-exhausted shape: the API accepts every segment and bee refuses every payload write.
    // No segment reaches addSegment, so no manifest publish is attempted and the manifest counter
    // never moves; the queue empties instantly because the failure is immediate. This reported ok.
    const api = await start(makeTestOrchestrator({}, { uploadData: rejectImmediately }));

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1));
    const accepted = await postSegment(api, 0);

    assert.equal(accepted.status, 200, 'the API accepts the segment, which is what makes the loss silent');

    const { status, body } = await api.requestUntil(
      '/health',
      (received) => (received as HealthBody).status === HEALTH_DEGRADED,
    );

    assert.equal(status, 503);
    assert.deepEqual((body as HealthBody).reasons, [HEALTH_REASON_SEGMENT_UPLOAD_FAILURE]);
  });

  it('reports a stalled stream even while a sibling stream is feeding', async () => {
    const api = await start(makeTestOrchestrator({ segmentStallMs: 60 }));

    await startStream(api, 'live/a');
    await startStream(api, 'live/b');
    await api.requestUntil('/health', hasActiveStreams(2));

    // Let both age past the window, then feed only live/a. A process-wide clock would read live/a's
    // fresh timestamp and call the whole service healthy while live/b is dead.
    await sleep(120);
    await postSegment(api, 0, 'live/a');

    const { status, body } = await api.request('/health');

    assert.equal(status, 503, 'the worst stream sets the signal, not the busiest one');
    assert.deepEqual((body as HealthBody).reasons, [HEALTH_REASON_SEGMENT_STALL]);
  });

  it('does not treat a replayed segment index as progress', async () => {
    const api = await start(makeTestOrchestrator({ segmentStallMs: 60 }));

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1));
    await postSegment(api, 0);
    await sleep(120);

    const replay = await postSegment(api, 0);
    assert.equal(replay.status, 200, 'a duplicate is still accepted, it just is not progress');

    const { status, body } = await api.request('/health');

    assert.equal(status, 503, 'a sender stuck replaying one index does no upload work and advances no manifest');
    assert.deepEqual((body as HealthBody).reasons, [HEALTH_REASON_SEGMENT_STALL]);
  });

  it('does not report a stall against a stream that is draining', async () => {
    // notifyStop hangs on the VOD manifest write, so the stream stays registered for the whole drain.
    // A drain accepts no segments by design, and DRAIN_TIMEOUT_MS is 5 minutes against this window.
    const api = await start(makeTestOrchestrator({ segmentStallMs: 60 }, { uploadPayload: neverSettles }));

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1));
    await postSegment(api, 0);
    await api.request('/stream/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamId: STREAM_ID }),
    });
    await sleep(150);

    const { status, body } = await api.request('/health');

    assert.equal(status, 200, 'a healthy drain must not read as a stall');
    assert.deepEqual((body as HealthBody).reasons, []);
  });

  it('stays ok across the stall window while segments keep arriving', async () => {
    // The positive half of the stall signal. Without this, dropping the timestamp refresh on the
    // accept path leaves every stall test still passing, because a never-refreshed clock degrades
    // just as readily as a stalled one.
    const api = await start(makeTestOrchestrator({ segmentStallMs: 60 }));

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1));

    for (let index = 0; index < 6; index++) {
      await postSegment(api, index);
      await sleep(25);
      const { status, body } = await api.request('/health');
      assert.equal(status, 200, `a feeding stream must stay healthy, failed after segment ${index}`);
      assert.deepEqual((body as HealthBody).reasons, []);
    }
  });

  it('does not report a stall for a recovered stream, before or right after the engine resumes', async () => {
    const orchestrator = makeTestOrchestrator(
      { segmentStallMs: 60, recoveryTimeout: 5_000 },
      {},
      makeFakeRecoveryStore({
        // listActive returns the slash-sanitized file name, the real id lives inside the state.
        listActive: () => [STREAM_ID.replace(/[/\\]/g, '_')],
        load: () => recoveredState(STREAM_ID),
      }),
    );
    const api = await start(orchestrator);

    await orchestrator.recoverStreams();
    await sleep(120);

    const waiting = await api.request('/health');
    assert.equal(waiting.status, 200, 'a stream awaiting reconnect is not stalled, its recovery timer owns that');

    // The engine resumes by replaying an index recovery already knows, which cancels the timer and
    // makes the stream eligible for the stall signal again. It must rejoin with a fresh reading.
    await postSegment(api, 0);
    const resumed = await api.request('/health');

    assert.equal(resumed.status, 200, 'a resumed stream must not inherit the age it accrued while waiting');
    assert.deepEqual((resumed.body as HealthBody).reasons, []);
  });

  it('reports degraded and 503 when a registered stream sends no segments', async () => {
    const api = await start(makeTestOrchestrator({ segmentStallMs: 50 }));

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1));

    const { status, body } = await api.requestUntil(
      '/health',
      (received) => (received as HealthBody).status === HEALTH_DEGRADED,
    );

    assert.equal(status, 503, 'a stream that announces and then goes silent must not report healthy');
    assert.deepEqual((body as HealthBody).reasons, [HEALTH_REASON_SEGMENT_STALL]);
  });
});
