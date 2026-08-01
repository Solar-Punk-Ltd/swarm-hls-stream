import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { Fetcher } from '../src/engines/ome/interfaces.js';
import { OmeHlsPuller, SEGMENT_RETRY_LIMIT } from '../src/engines/ome/OmeHlsPuller.js';
import { RecoveryStore } from '../src/libs/RecoveryStore.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import {
  HEALTH_DEGRADED,
  HEALTH_OK,
  HEALTH_REASON_QUEUE_PRESSURE,
  HEALTH_REASON_SEGMENT_LOSS,
  HEALTH_REASON_SEGMENT_STALL,
  HEALTH_REASON_SEGMENT_UPLOAD_FAILURE,
  HEALTH_REASON_STALE_MANIFEST,
  MEDIA_TYPE_VIDEO,
} from '../src/types.js';
import { MANIFEST_FAILURE_THRESHOLD } from '../src/utils/health.js';

import { ApiTestServer, startTestApi } from './helpers/apiTestServer.js';
import { FakeClock } from './helpers/fakeClock.js';
import {
  FakeUploads,
  makeFakeRecoveryStore,
  makeRecoveredState,
  makeTestOrchestrator,
  neverSettles,
  rejectImmediately,
  toRecoveryFileId,
} from './helpers/fakes.js';

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
        'msSinceSegmentLoss',
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

  const STALL_WINDOW_MS = 60;
  const UNDER_THE_STALL_WINDOW_MS = 25;
  const PAST_THE_STALL_WINDOW_MS = 120;
  /** Long enough that no test here advances far enough to fire the recovery timer by accident. */
  const RECOVERY_TIMEOUT_MS = 5_000;

  /** A recovery store holding one crashed session of `STREAM_ID`, so recoverStreams restores it. */
  const RECOVERING = makeFakeRecoveryStore({
    listActive: () => [toRecoveryFileId(STREAM_ID)],
    load: () => makeRecoveredState(STREAM_ID),
  });

  /**
   * The stall signal is the distance between two readings of the orchestrator's clock, so every test
   * below is really about that distance and not about elapsed time. Driving an injected clock is not
   * merely faster than sleeping: a real sleep measures the machine, and on a loaded one the round trip
   * of feeding a segment and then reading /health runs past a 60ms window all by itself. That is what
   * failed `stays ok across the stall window` in 4 of 8 concurrent runs, with the code under test
   * behaving correctly every time.
   */
  function makeStallingOrchestrator(
    clock: FakeClock,
    uploads: FakeUploads = {},
    recoveryStore: RecoveryStore = makeFakeRecoveryStore(),
  ): StreamOrchestrator {
    return makeTestOrchestrator(
      { segmentStallMs: STALL_WINDOW_MS, recoveryTimeout: RECOVERY_TIMEOUT_MS, clock },
      uploads,
      recoveryStore,
    );
  }

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
    const clock = new FakeClock();
    const api = await start(makeStallingOrchestrator(clock));

    await startStream(api, 'live/a');
    await startStream(api, 'live/b');
    await api.requestUntil('/health', hasActiveStreams(2));

    // Let both age past the window, then feed only live/a. A process-wide clock would read live/a's
    // fresh timestamp and call the whole service healthy while live/b is dead.
    await clock.advance(PAST_THE_STALL_WINDOW_MS);
    await postSegment(api, 0, 'live/a');

    const { status, body } = await api.request('/health');

    assert.equal(status, 503, 'the worst stream sets the signal, not the busiest one');
    assert.deepEqual((body as HealthBody).reasons, [HEALTH_REASON_SEGMENT_STALL]);
  });

  it('does not treat a replayed segment index as progress', async () => {
    const clock = new FakeClock();
    const api = await start(makeStallingOrchestrator(clock));

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1));
    await postSegment(api, 0);
    await clock.advance(PAST_THE_STALL_WINDOW_MS);

    const replay = await postSegment(api, 0);
    assert.equal(replay.status, 200, 'a duplicate is still accepted, it just is not progress');

    const { status, body } = await api.request('/health');

    assert.equal(status, 503, 'a sender stuck replaying one index does no upload work and advances no manifest');
    assert.deepEqual((body as HealthBody).reasons, [HEALTH_REASON_SEGMENT_STALL]);
  });

  it('does not report a stall against a stream that is draining', async () => {
    // notifyStop hangs on the VOD manifest write, so the stream stays registered for the whole drain.
    // A drain accepts no segments by design, and DRAIN_TIMEOUT_MS is 5 minutes against this window.
    const clock = new FakeClock();
    const api = await start(makeStallingOrchestrator(clock, { uploadPayload: neverSettles }));

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1));
    await postSegment(api, 0);
    // stopStream registers the drain before its first await, so it is registered by the time this
    // response comes back, whatever the machine is doing. The route answers ahead of the drain.
    await api.request('/stream/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamId: STREAM_ID }),
    });
    await clock.advance(PAST_THE_STALL_WINDOW_MS);

    const { status, body } = await api.request('/health');

    assert.equal(status, 200, 'a healthy drain must not read as a stall');
    assert.deepEqual((body as HealthBody).reasons, []);
  });

  it('stays ok across the stall window while segments keep arriving', async () => {
    // The positive half of the stall signal. Without this, dropping the timestamp refresh on the
    // accept path leaves every stall test still passing, because a never-refreshed clock degrades
    // just as readily as a stalled one.
    const clock = new FakeClock();
    const api = await start(makeStallingOrchestrator(clock));

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1));

    // Six gaps under the window that sum to well over it, which is the case a single reading cannot
    // distinguish from a stall: what must stay small is the distance between consecutive segments,
    // not the age of the stream.
    for (let index = 0; index < 6; index++) {
      await postSegment(api, index);
      await clock.advance(UNDER_THE_STALL_WINDOW_MS);
      const { status, body } = await api.request('/health');
      assert.equal(status, 200, `a feeding stream must stay healthy, failed after segment ${index}`);
      assert.deepEqual((body as HealthBody).reasons, []);
    }
  });

  it('does not report a stall for a recovered stream, before or right after the engine resumes', async () => {
    const clock = new FakeClock();
    const orchestrator = makeStallingOrchestrator(clock, {}, RECOVERING);
    const api = await start(orchestrator);

    await orchestrator.recoverStreams();
    await clock.advance(PAST_THE_STALL_WINDOW_MS);

    const waiting = await api.request('/health');
    assert.equal(waiting.status, 200, 'a stream awaiting reconnect is not stalled, its recovery timer owns that');

    // The engine resumes by replaying an index recovery already knows, which cancels the timer and
    // makes the stream eligible for the stall signal again. It must rejoin with a fresh reading.
    await postSegment(api, 0);
    const resumed = await api.request('/health');

    assert.equal(resumed.status, 200, 'a resumed stream must not inherit the age it accrued while waiting');
    assert.deepEqual((resumed.body as HealthBody).reasons, []);
  });

  it('does not report a stall after a recovered stream is re-announced', async () => {
    // The second route out of the recovery wait, and a different one from the test above: an engine
    // that sends on_publish rather than segments takes the recovery branch of startStream. Both
    // routes make the stream eligible for the stall signal again, so both need a fresh reading.
    const clock = new FakeClock();
    const orchestrator = makeStallingOrchestrator(clock, {}, RECOVERING);
    const api = await start(orchestrator);

    await orchestrator.recoverStreams();
    await clock.advance(PAST_THE_STALL_WINDOW_MS);
    await startStream(api);

    const { status, body } = await api.request('/health');

    assert.equal(status, 200, 'a re-announce is progress, so the stream must not inherit its waiting age');
    assert.deepEqual((body as HealthBody).reasons, []);
  });

  it('reports degraded and 503 when the engine loses a segment it could never download', async () => {
    // The OBS-11 shape: the segment never reaches the uploader at all, so no upload is attempted and
    // no manifest publish fails. Every signal stayed clean and health answered 200 while the manifest
    // grew a hole players are told is contiguous.
    const orchestrator = makeTestOrchestrator();
    const api = await start(orchestrator);

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1));

    orchestrator.handleSegmentLoss(STREAM_ID, 1, 1);

    const { status, body } = await api.requestUntil(
      '/health',
      (received) => (received as HealthBody).status === HEALTH_DEGRADED,
    );

    assert.equal(status, 503);
    assert.deepEqual((body as HealthBody).reasons, [HEALTH_REASON_SEGMENT_LOSS]);
  });

  // Driven through the real puller rather than by calling the seam, because calling the seam is what
  // hid the defect this test exists for: the puller writes a segment off and downloads the next one
  // in the same pass, and that success used to clear the counter before any poll could read it.
  it('still reports 503 when a real puller loses one segment and keeps delivering the rest', async () => {
    const orchestrator = makeTestOrchestrator();
    const api = await start(orchestrator);

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1));

    const lines = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0'];
    for (let index = 0; index < 12; index++) {
      lines.push('#EXTINF:2.0,', `segment_${index}.ts`);
    }
    const fetcher = ((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).endsWith('segment_3.ts')
          ? ({ ok: false, status: 404 } as Response)
          : ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Response),
      )) as unknown as Fetcher;
    const puller = new OmeHlsPuller(STREAM_ID, 'live', 'one', 'http://ome/hls', 1_000_000, orchestrator, {
      fetcher,
    }) as unknown as { processPlaylist(playlist: string, url: string): Promise<void> };

    for (let pass = 0; pass <= SEGMENT_RETRY_LIMIT; pass++) {
      await puller.processPlaylist(lines.join('\n'), 'http://ome/hls/live/one/media.m3u8');
    }

    const { status, body } = await api.request('/health');

    assert.equal(status, 503, 'one lost segment among many delivered ones still has to be visible');
    assert.deepEqual((body as HealthBody).reasons, [HEALTH_REASON_SEGMENT_LOSS]);
  });

  it('clears the segment failure count once a segment lands again', async () => {
    // The counter is documented as consecutive rather than latching. Without this the threshold of
    // one would pin a stream at 503 for its whole life after a single transient drop.
    let attempts = 0;
    const failOnlyTheFirst = () => {
      attempts += 1;
      return attempts === 1 ? rejectImmediately() : Promise.resolve({ reference: { toHex: () => `ref${attempts}` } });
    };
    const api = await start(makeTestOrchestrator({}, { uploadData: failOnlyTheFirst }));

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1));

    await postSegment(api, 0);
    const degraded = await api.requestUntil(
      '/health',
      (received) => (received as HealthBody).status === HEALTH_DEGRADED,
    );
    assert.deepEqual((degraded.body as HealthBody).reasons, [HEALTH_REASON_SEGMENT_UPLOAD_FAILURE]);

    await postSegment(api, 1);
    const recovered = await api.requestUntil('/health', (received) => (received as HealthBody).status === HEALTH_OK);

    assert.equal(recovered.status, 200, 'a successful segment must clear the count, not leave it latched');
    assert.deepEqual((recovered.body as HealthBody).reasons, []);
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
