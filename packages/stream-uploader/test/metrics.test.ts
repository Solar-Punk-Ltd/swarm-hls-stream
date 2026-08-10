import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MEDIA_TYPE_VIDEO } from '../src/types.js';
import { renderPrometheusMetrics } from '../src/utils/metricsFormat.js';

import { ApiTestServer, startTestApi } from './helpers/apiTestServer.js';
import { makeMetricsSnapshot, makeTestOrchestrator, rejectImmediately } from './helpers/fakes.js';

const STREAM_ID = 'live/one';
const SETTLE_CEILING_MS = 4_000;

/** `name -> help text` for every metric in an exposition body, so a test can assert the text is there. */
function parseHelp(body: string): Map<string, string> {
  const help = new Map<string, string>();
  for (const match of body.matchAll(/^# HELP (swarm_hls_[a-z0-9_]+) ?(.*)$/gm)) {
    help.set(match[1], match[2]);
  }
  return help;
}

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

/**
 * Every metric the README's table names, which is the list an operator builds their dashboard from.
 *
 * Read out of the file rather than duplicated here, because a copy of the list in a test is a third
 * place to forget. The table had drifted twice before this existed: `segments_skipped_total` and
 * `auth_rejections_total` were both exposed and both undocumented.
 */
function documentedMetrics(): string[] {
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  return [...readme.matchAll(/^\| `(swarm_hls_[a-z0-9_]+)` *\| *(counter|gauge) /gm)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
}

/** `name type` for every metric the renderer emits, which is the same shape the table is read as. */
function servedMetrics(): string[] {
  const body = renderPrometheusMetrics(makeMetricsSnapshot());
  return [...body.matchAll(/^# TYPE (swarm_hls_[a-z0-9_]+) (counter|gauge)$/gm)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
}

describe("the README's metric table", () => {
  /**
   * A metric nobody documented is one nobody alerts on, and a documented one that no longer exists is
   * a dashboard panel that reads empty and looks like a healthy service.
   */
  it('names exactly the metrics `/metrics` serves, with the right type on each', () => {
    // The type matters as much as the name: an operator who reads `counter` off this table writes
    // `rate(...)` over a gauge and gets a number that means nothing, and nothing else compares them.
    assert.deepEqual(documentedMetrics().sort(), servedMetrics().sort());
  });
});

describe('metrics exposition format', () => {
  const SNAPSHOT = {
    segmentsUploadedTotal: 12,
    segmentsDroppedTotal: 3,
    segmentsLostTotal: 40,
    segmentsSkippedTotal: 5,
    segmentsNeverNamedTotal: 5,
    manifestPublishFailuresTotal: 2,
    openingSegmentsWithheldTotal: 8,
    streamsFinalizedTotal: 1,
    streamsFailedTotal: 1,
    streamsReapedTotal: 2,
    segmentDurationsUnreadTotal: 3,
    authRejectionsTotal: 4,
    takeoversRefusedTotal: 6,
    lastSegmentAt: 1_700_000_000_000,
    activeStreams: 2,
    queueDepth: 7,
    queueBacklogSeconds: 14,
  };

  it('renders every metric with a help line, a type line and a value', () => {
    const body = renderPrometheusMetrics(SNAPSHOT);

    const samples = parseExposition(body);
    assert.equal(samples.size, 17, `every metric must be exposed once, got ${[...samples.keys()].join(', ')}`);
    for (const name of samples.keys()) {
      assert.ok(body.includes(`# HELP ${name} `), `${name} has no HELP line`);
      assert.ok(body.includes(`# TYPE ${name} `), `${name} has no TYPE line`);
    }
    assert.ok(body.endsWith('\n'), 'the exposition format requires a trailing newline');
  });

  /**
   * The assertion above checks a HELP line is present and cannot check it says anything, because
   * `# HELP name ` with the text removed still contains `# HELP name `. Mutation testing found every
   * one of the seventeen help strings surviving on exactly that gap. The HELP text is the only
   * description an operator gets at 3am from a plain curl, so an empty one is a real regression.
   *
   * Deliberately asserts that text EXISTS rather than what it says: pinning the wording would make
   * every future edit to an explanation a failing test, and the wording is not the contract.
   */
  it('gives every metric help text that actually describes it', () => {
    const help = parseHelp(renderPrometheusMetrics(SNAPSHOT));

    assert.equal(help.size, 17, 'every metric must carry a HELP line');
    for (const [name, text] of help) {
      assert.ok(text.trim().length > 0, `${name} has a HELP line with no text in it`);
    }
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

  /**
   * The version in this string is part of the Prometheus text exposition contract, not decoration, and
   * nothing else in the suite read it: mutation testing blanked the whole constant and every test
   * still passed. Blanked, Express falls back to `application/octet-stream`, and a scraper that gets
   * the wrong media type does not fall back, it drops the target. The service then carries on looking
   * perfectly healthy from the inside.
   *
   * ⛔ Asserts the type and the version separately rather than comparing against the constant, because
   * Express reorders media type parameters and serves `text/plain; charset=utf-8; version=0.0.4`.
   * Parameter order carries no meaning in HTTP, so an equality check here would fail on a detail that
   * is not the contract, and the first fix anyone reached for would be to loosen it to nothing.
   */
  it('declares the prometheus exposition content type on the response', async () => {
    const api = await start(makeTestOrchestrator());

    const { headers } = await api.request('/metrics');

    assert.match(headers['content-type'], /^text\/plain\b/);
    assert.match(headers['content-type'], /\bversion=0\.0\.4\b/);
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
