import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { MEDIA_TYPE_VIDEO } from '../src/types.js';

import { ApiTestServer, startTestApi } from './helpers/apiTestServer.js';
import { makeTestOrchestrator } from './helpers/fakes.js';

function hasActiveStreams(count: number): (body: unknown) => boolean {
  return (body) => (body as { activeStreams?: number }).activeStreams === count;
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
      ['activeStreams', 'engines', 'queuePressure', 'staleManifestStreams', 'status'].sort(),
      'the health body is a published contract, health.sh and the e2e suite both read it',
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
    const orchestrator = makeTestOrchestrator();
    const api = await start(orchestrator);

    await api.request('/stream/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamId: 'live/one', mediatype: MEDIA_TYPE_VIDEO }),
    });
    // startStream queues uploader construction, so the stream is not addressable on return.
    await api.requestUntil('/health', hasActiveStreams(1));

    const { status, body } = await api.request('/stream/segment', {
      method: 'POST',
      headers: {
        'content-type': 'video/mp2t',
        'x-stream-id': 'live/one',
        'x-segment-index': '0',
        'x-duration': '2',
      },
      body: Buffer.from('segment-payload'),
    });

    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, queued: true });
  });

  it('answers a segment for an unknown stream with 404', async () => {
    const api = await start(makeTestOrchestrator());

    const { status, body } = await api.request('/stream/segment', {
      method: 'POST',
      headers: {
        'content-type': 'video/mp2t',
        'x-stream-id': 'live/ghost',
        'x-segment-index': '0',
        'x-duration': '2',
      },
      body: Buffer.from('segment-payload'),
    });

    assert.equal(status, 404);
    assert.deepEqual(body, { ok: false, error: 'Unknown stream: live/ghost', statusCode: 404 });
  });
});
