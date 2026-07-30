import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { MIN_AUTH_TOKEN_LENGTH } from '../src/api/middleware/requireAuth.js';
import { createApiApp } from '../src/api/server.js';
import { MEDIA_TYPE_VIDEO } from '../src/types.js';

import { ApiTestServer, NO_AUTH_HEADER, startTestApi, TEST_AUTH_TOKEN } from './helpers/apiTestServer.js';
import { makeTestOrchestrator } from './helpers/fakes.js';

const STREAM_ID = 'live/one';

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
        headers: { ...(init.headers as Record<string, string>), ...NO_AUTH_HEADER },
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

  it('rejects a credential with no space after the scheme', async () => {
    const calls = noCalls();
    const api = await start(calls);

    const { status } = await api.request('/stream/start', {
      ...startBody(),
      headers: { 'content-type': 'application/json', authorization: `Bearer${TEST_AUTH_TOKEN}` },
    });

    assert.equal(status, 401, 'RFC 7235 requires at least one space, so no separator is not a credential');
    assert.deepEqual(calls.startStream, []);
  });

  it('gates the whole /stream prefix, not only the routes that exist today', async () => {
    // The middleware claims a route added to this router later is covered without anyone remembering.
    // A 401 rather than a 404 on an unrouted path is what makes that true.
    const api = await start(noCalls());

    const { status } = await api.request('/stream/not-a-route-yet', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...NO_AUTH_HEADER },
      body: '{}',
    });

    assert.equal(status, 401);
  });

  it('accepts a base64 token, which is what the documented generator can produce', () => {
    // token68 admits + / and =, and openssl rand -base64 uses all three. Rejecting one would lock an
    // operator out at startup for following the README.
    assert.doesNotThrow(() =>
      createApiApp(makeTestOrchestrator(), { authToken: 'aB3+cD4/eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5a=' }),
    );
  });

  it('sets the floor at the documented length', () => {
    // Pinned as a literal, because every other assertion here is written against the constant and so
    // moves with it. The same reason the abort window's default is pinned this way.
    assert.equal(MIN_AUTH_TOKEN_LENGTH, 32);
  });

  it('rejects a token one character below the floor', () => {
    assert.throws(() => createApiApp(makeTestOrchestrator(), { authToken: 'a'.repeat(MIN_AUTH_TOKEN_LENGTH - 1) }), {
      message: /at least/,
    });
    assert.doesNotThrow(() => createApiApp(makeTestOrchestrator(), { authToken: 'a'.repeat(MIN_AUTH_TOKEN_LENGTH) }));
  });

  it('leaves /health reachable without a token, since health.sh reads it', async () => {
    const api = await start(noCalls());

    const { status } = await api.request('/health', { headers: NO_AUTH_HEADER });

    assert.equal(status, 200);
  });

  // Every one of these was found by the gate on this pull request, and none of them had a test.
  const UNUSABLE_TOKENS: { name: string; token: string }[] = [
    { name: 'a token with characters no HTTP header can carry', token: 'ключ-очень-длинный-секрет-0123456' },
    { name: 'a token of emoji that only looks long enough', token: '\u{1F600}'.repeat(16) },
    { name: 'a token containing a space', token: 'a token with spaces padded out to thirty two' },
  ];

  for (const unusable of UNUSABLE_TOKENS) {
    it(`refuses to build an app with ${unusable.name}`, () => {
      // Accepting one starts a service nobody can authenticate against, and the 401 every caller then
      // gets says nothing about why, so the operator has no way back except reading this source.
      assert.throws(() => createApiApp(makeTestOrchestrator(), { authToken: unusable.token }), {
        message: /unreserved characters|at least/,
      });
    });
  }

  it('accepts the credential after more than one space, which RFC 7235 allows', async () => {
    const calls = noCalls();
    const api = await start(calls);

    const { status } = await api.request('/stream/start', {
      ...startBody(),
      headers: { 'content-type': 'application/json', authorization: `Bearer   ${TEST_AUTH_TOKEN}` },
    });

    assert.equal(status, 200);
    assert.equal(calls.startStream.length, 1);
  });

  it('refuses an unauthenticated request before its body is parsed', async () => {
    // The gate sits ahead of the body parsers. Behind them, a malformed anonymous body reaches the
    // parser first and answers 500 with a server-side error line, so an anonymous caller controls the
    // 5xx rate and the error log. Behind them the 50MB segment parser also allocates per connection
    // before the refusal, measured at 117MB to 583MB of RSS for eight concurrent bodies.
    const api = await start(noCalls());

    const { status, body } = await api.request('/stream/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...NO_AUTH_HEADER },
      body: '{"streamId": ',
    });

    assert.equal(status, 401, 'a malformed anonymous body must be refused, not parsed and then 500');
    assert.deepEqual(body, { error: 'Unauthorized' });
  });

  it('refuses an oversized anonymous segment before the raw parser sees its length', async () => {
    // The malformed-JSON case above pins the gate ahead of express.json only, and it is express.raw
    // that allocates 50MB per connection. Driven over a raw socket because fetch computes
    // Content-Length from the body, and the point is a declared length the parser would reject with
    // 413 before a single byte of the body arrives.
    const api = await start(noCalls());
    const status = await api.rawRequest(
      [
        'POST /stream/segment HTTP/1.1',
        `Host: 127.0.0.1`,
        'Content-Type: video/mp2t',
        'x-stream-id: live/one',
        'x-segment-index: 0',
        'x-duration: 2',
        'Content-Length: 52428801',
        '',
        '',
      ].join('\r\n'),
    );

    assert.equal(status, 401, 'the gate has to answer before the body parser weighs the request');
  });

  it('names the full path in the rejection log, not the mount-relative one', async () => {
    const api = await start(noCalls());
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

    try {
      await api.request('/stream/start', {
        ...startBody(),
        headers: { 'content-type': 'application/json', ...NO_AUTH_HEADER },
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(
      warnings.some((line) => line.includes('/stream/start')),
      `express strips the mount prefix, so the line would otherwise name /start, got ${JSON.stringify(warnings)}`,
    );
  });

  it('refuses to build an app with a token short enough to guess', () => {
    assert.throws(
      () => createApiApp(makeTestOrchestrator(), { authToken: 'short' }),
      { message: new RegExp(String(MIN_AUTH_TOKEN_LENGTH)) },
      'a weak token has to fail at startup, not quietly protect nothing',
    );
  });
});
