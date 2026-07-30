import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { MIN_AUTH_TOKEN_LENGTH } from '../src/api/middleware/requireAuth.js';
import { createApiApp } from '../src/api/server.js';
import { MEDIA_TYPE_VIDEO } from '../src/types.js';

import { ApiTestServer, startTestApi, TEST_AUTH_TOKEN } from './helpers/apiTestServer.js';
import { makeTestOrchestrator } from './helpers/fakes.js';

const STREAM_ID = 'live/one';

/** Sentinel the harness understands as "send no Authorization header at all". */
const NO_AUTH = { authorization: 'none' };

interface OrchestratorCalls {
  startStream: unknown[][];
  handleSegment: unknown[][];
  stopStream: unknown[][];
}

/**
 * A real orchestrator with every entry point recorded. The acceptance criterion is not only that the
 * response is 401, it is that the work behind the route never ran: a 401 returned after a segment was
 * already uploaded and paid for would satisfy a status-code assertion and none of the point.
 */
function spyingOrchestrator(calls: OrchestratorCalls) {
  const orchestrator = makeTestOrchestrator();
  const spied = orchestrator as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of Object.keys(calls) as (keyof OrchestratorCalls)[]) {
    const original = spied[name].bind(orchestrator);
    spied[name] = (...args: unknown[]) => {
      calls[name].push(args);
      return original(...args);
    };
  }
  return orchestrator;
}

function noCalls(): OrchestratorCalls {
  return { startStream: [], handleSegment: [], stopStream: [] };
}

function startBody(): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ streamId: STREAM_ID, mediatype: MEDIA_TYPE_VIDEO }),
  };
}

function segmentBody(): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'video/mp2t',
      'x-stream-id': STREAM_ID,
      'x-segment-index': '0',
      'x-duration': '2',
    },
    body: Buffer.from('segment-0'),
  };
}

function stopBody(): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ streamId: STREAM_ID }),
  };
}

const ROUTES = [
  { path: '/stream/start', init: startBody, spy: 'startStream' as const },
  { path: '/stream/segment', init: segmentBody, spy: 'handleSegment' as const },
  { path: '/stream/stop', init: stopBody, spy: 'stopStream' as const },
];

describe('api auth (S1.1, closes SEC-1)', () => {
  const servers: ApiTestServer[] = [];

  async function start(calls: OrchestratorCalls): Promise<ApiTestServer> {
    const server = await startTestApi(spyingOrchestrator(calls));
    servers.push(server);
    return server;
  }

  after(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  for (const route of ROUTES) {
    it(`answers 401 for an unauthenticated POST ${route.path} and never reaches the orchestrator`, async () => {
      const calls = noCalls();
      const api = await start(calls);

      const init = route.init();
      const { status, body } = await api.request(route.path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), ...NO_AUTH },
      });

      assert.equal(status, 401);
      assert.deepEqual(
        calls[route.spy],
        [],
        `${route.spy} ran for an unauthenticated caller, so a 401 was returned after the work was already done`,
      );
      assert.deepEqual(body, { error: 'Unauthorized' }, 'the rejection carries nothing back about the request');
    });

    it(`accepts POST ${route.path} with the correct token`, async () => {
      const calls = noCalls();
      const api = await start(calls);

      if (route.path !== '/stream/start') {
        await api.request('/stream/start', startBody());
        await api.requestUntil('/health', (b) => (b as { activeStreams?: number }).activeStreams === 1);
      }

      const { status } = await api.request(route.path, route.init());

      assert.equal(status, 200, 'a correctly authenticated caller is unaffected');
      assert.ok(calls[route.spy].length > 0, `${route.spy} ran for an authenticated caller`);
    });
  }

  const BAD_TOKENS: { name: string; header: string }[] = [
    { name: 'a wrong token of the same length', header: `Bearer ${'x'.repeat(TEST_AUTH_TOKEN.length)}` },
    { name: 'a token that is a prefix of the real one', header: `Bearer ${TEST_AUTH_TOKEN.slice(0, -1)}` },
    { name: 'the token with no Bearer scheme', header: TEST_AUTH_TOKEN },
    { name: 'a different scheme', header: `Basic ${TEST_AUTH_TOKEN}` },
    { name: 'an empty bearer value', header: 'Bearer ' },
  ];

  for (const bad of BAD_TOKENS) {
    it(`rejects ${bad.name}`, async () => {
      const calls = noCalls();
      const api = await start(calls);

      const { status } = await api.request('/stream/start', {
        ...startBody(),
        headers: { 'content-type': 'application/json', authorization: bad.header },
      });

      assert.equal(status, 401);
      assert.deepEqual(calls.startStream, []);
    });
  }

  it('accepts a lowercase scheme, since RFC 7235 makes it case-insensitive', async () => {
    const calls = noCalls();
    const api = await start(calls);

    const { status } = await api.request('/stream/start', {
      ...startBody(),
      headers: { 'content-type': 'application/json', authorization: `bearer ${TEST_AUTH_TOKEN}` },
    });

    assert.equal(status, 200, 'rejecting a conforming client is a functional break, not a hardening win');
    assert.equal(calls.startStream.length, 1);
  });

  it('leaves /health reachable without a token, since health.sh reads it', async () => {
    const api = await start(noCalls());

    const { status } = await api.request('/health', { headers: NO_AUTH });

    assert.equal(status, 200);
  });

  it('refuses to build an app with a token short enough to guess', () => {
    assert.throws(
      () => createApiApp(makeTestOrchestrator(), { authToken: 'short' }),
      { message: new RegExp(String(MIN_AUTH_TOKEN_LENGTH)) },
      'a weak token has to fail at startup, not quietly protect nothing',
    );
  });
});
