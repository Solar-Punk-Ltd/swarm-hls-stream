import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { MEDIA_TYPE_VIDEO } from '../src/types.js';
import { renderPrometheusMetrics } from '../src/utils/metricsFormat.js';

import { ApiTestServer, startTestApi } from './helpers/apiTestServer.js';
import { makeTestOrchestrator, rejectImmediately } from './helpers/fakes.js';

const STREAM_ID = 'live/one';
const SETTLE_CEILING_MS = 4_000;

/** `name value` for every sample in an exposition body, so a test can assert on numbers not text. */
function parseExposition(body: string): Map<string, number> {
  const samples = new Map<string, number>();
  for (const line of body.split('\n')) {
    if (line.startsWith('#') || line.length === 0) {
      continue;
    }
    const [name, value] = line.split(' ');
    samples.set(name, Number(value));
  }
  return samples;
}

describe('metrics exposition format', () => {
  const SNAPSHOT = {
    segmentsUploadedTotal: 12,
    segmentsDroppedTotal: 3,
    segmentsLostTotal: 40,
    segmentsSkippedTotal: 5,
    manifestPublishFailuresTotal: 2,
    streamsFinalizedTotal: 1,
    streamsFailedTotal: 1,
    authRejectionsTotal: 4,
    lastSegmentAt: 1_700_000_000_000,
    activeStreams: 2,
    queueDepth: 7,
    queueBacklogSeconds: 14,
  };

  it('renders every metric with a help line, a type line and a value', () => {
    const body = renderPrometheusMetrics(SNAPSHOT);

    const samples = parseExposition(body);
    assert.equal(samples.size, 12, `every metric must be exposed once, got ${[...samples.keys()].join(', ')}`);
    for (const name of samples.keys()) {
      assert.ok(body.includes(`# HELP ${name} `), `${name} has no HELP line`);
      assert.ok(body.includes(`# TYPE ${name} `), `${name} has no TYPE line`);
    }
    assert.ok(body.endsWith('\n'), 'the exposition format requires a trailing newline');
  });

  /**
   * Milliseconds everywhere else in this service and seconds here, because a Prometheus timestamp
   * gauge is compared against `time()` in a query. Exposing milliseconds would put every alert on
   * this metric out by a factor of a thousand and still look like a plausible number.
   */
  it('renders the last segment timestamp in unix seconds, not milliseconds', () => {
    const samples = parseExposition(renderPrometheusMetrics(SNAPSHOT));

    assert.equal(samples.get('swarm_hls_last_segment_timestamp_seconds'), 1_700_000_000);
  });

  it('renders zero rather than null when no segment has landed', () => {
    const samples = parseExposition(renderPrometheusMetrics({ ...SNAPSHOT, lastSegmentAt: null }));

    assert.equal(samples.get('swarm_hls_last_segment_timestamp_seconds'), 0);
  });
});

describe('GET /metrics (S2.7, OBS-7)', () => {
  const servers: ApiTestServer[] = [];
  after(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  async function start(...args: Parameters<typeof startTestApi>): Promise<ApiTestServer> {
    const server = await startTestApi(...args);
    servers.push(server);
    return server;
  }

  function startStream(api: ApiTestServer) {
    return api.request('/stream/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamId: STREAM_ID, mediatype: MEDIA_TYPE_VIDEO }),
    });
  }

  function postSegment(api: ApiTestServer, index: number) {
    return api.request('/stream/segment', {
      method: 'POST',
      headers: {
        'content-type': 'video/mp2t',
        'x-stream-id': STREAM_ID,
        'x-segment-index': String(index),
        'x-duration': '2',
      },
      body: Buffer.from(`segment-${index}`),
    });
  }

  /** For `requestUntil`, whose predicate is synchronous over an already-fetched body. */
  function hasSample(name: string, value: number): (body: unknown) => boolean {
    return (body) => parseExposition(String(body)).get(name) === value;
  }

  async function scrape(api: ApiTestServer): Promise<Map<string, number>> {
    const { body } = await api.request('/metrics');
    return parseExposition(String(body));
  }

  it('serves the exposition over http', async () => {
    const api = await start(makeTestOrchestrator());

    const { status } = await api.request('/metrics');
    const samples = await scrape(api);

    assert.equal(status, 200);
    assert.equal(samples.get('swarm_hls_active_streams'), 0);
    assert.equal(samples.get('swarm_hls_segments_uploaded_total'), 0);
  });

  it('counts a segment that reached swarm', async () => {
    const api = await start(makeTestOrchestrator());

    await startStream(api);
    await api.requestUntil('/metrics', hasSample('swarm_hls_active_streams', 1), SETTLE_CEILING_MS);
    await postSegment(api, 0);

    await api.requestUntil('/metrics', hasSample('swarm_hls_segments_uploaded_total', 1), SETTLE_CEILING_MS);
    const samples = await scrape(api);

    assert.equal(samples.get('swarm_hls_segments_dropped_total'), 0, 'a segment that landed is not also a drop');
    assert.ok(
      (samples.get('swarm_hls_last_segment_timestamp_seconds') ?? 0) > 0,
      'the last segment timestamp stayed at its never-seen value after a segment landed',
    );
  });

  /** The acceptance criterion names this one specifically. */
  it('increments the dropped counter when an upload fails', async () => {
    const api = await start(makeTestOrchestrator({}, { uploadData: rejectImmediately }));

    await startStream(api);
    await api.requestUntil('/metrics', hasSample('swarm_hls_active_streams', 1), SETTLE_CEILING_MS);
    await postSegment(api, 0);

    await api.requestUntil('/metrics', hasSample('swarm_hls_segments_dropped_total', 1), SETTLE_CEILING_MS);
    const samples = await scrape(api);

    assert.equal(samples.get('swarm_hls_segments_uploaded_total'), 0, 'a dropped segment must not also count as one');
  });

  /**
   * The reason these exist rather than more `/health` fields. `/health` describes the streams that are
   * registered now, so at the moment a live session is wrongly killed it answers `ok` with
   * `activeStreams: 0`: the healthiest reading it can give is also the worst state it can be in. A
   * total outlives the stream it counted. See OBS-17.
   */
  it('keeps its totals after every stream it counted is gone', async () => {
    const api = await start(makeTestOrchestrator());

    await startStream(api);
    await api.requestUntil('/metrics', hasSample('swarm_hls_active_streams', 1), SETTLE_CEILING_MS);
    await postSegment(api, 0);
    await api.requestUntil('/metrics', hasSample('swarm_hls_segments_uploaded_total', 1), SETTLE_CEILING_MS);

    await api.request('/stream/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamId: STREAM_ID }),
    });
    await api.requestUntil('/metrics', hasSample('swarm_hls_active_streams', 0), SETTLE_CEILING_MS);

    const samples = await scrape(api);
    assert.equal(
      samples.get('swarm_hls_segments_uploaded_total'),
      1,
      'the total went with the stream that produced it',
    );
    assert.equal(samples.get('swarm_hls_streams_finalized_total'), 1);
    assert.equal(samples.get('swarm_hls_streams_failed_total'), 0);
  });

  it('counts a stop whose finalize never published as a failed stream', async () => {
    const api = await start(makeTestOrchestrator({}, { uploadPayload: rejectImmediately }));

    await startStream(api);
    await api.requestUntil('/metrics', hasSample('swarm_hls_active_streams', 1), SETTLE_CEILING_MS);
    await postSegment(api, 0);
    await api.request('/stream/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamId: STREAM_ID }),
    });

    await api.requestUntil('/metrics', hasSample('swarm_hls_streams_failed_total', 1), SETTLE_CEILING_MS);
    const samples = await scrape(api);

    assert.equal(samples.get('swarm_hls_streams_finalized_total'), 0, 'a broadcast with no VOD counted as finalized');
  });
});
