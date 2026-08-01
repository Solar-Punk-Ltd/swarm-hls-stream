import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net, { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { RequestLimits } from '../../src/api/requestLimits.js';
import { createApiApp } from '../../src/api/server.js';
import { EnginePlugin } from '../../src/engines/types.js';
import { StreamOrchestrator } from '../../src/libs/StreamOrchestrator.js';

import { LOOPBACK_HOST } from './loopbackServer.js';

const POLL_INTERVAL_MS = 10;
const RAW_RESPONSE_TIMEOUT_MS = 2_000;

/** Long enough to satisfy the production minimum, so tests exercise the real gate rather than a relaxed one. */
export const TEST_AUTH_TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

/**
 * Sends no `Authorization` header at all. A sentinel rather than `null`, because `new Headers({ a: null })`
 * stringifies to the four characters `null` and the request goes out with a garbage credential, which
 * still returns 401 and so still passes a test written to assert one.
 */
export const NO_AUTH_HEADER = { authorization: 'none' };

export interface ApiResponse {
  status: number;
  body: unknown;
  /** Lowercased response headers, for the ones that carry meaning of their own such as `Retry-After`. */
  headers: Record<string, string>;
}

export interface ApiTestServer {
  /** Sends a hand-written request and resolves the status line's code. For header forms fetch will not emit. */
  rawRequest(request: string): Promise<number>;
  /** Authenticated by default. Pass your own `authorization` header, or `NO_AUTH_HEADER`, to drive the gate. */
  request(path: string, init?: RequestInit): Promise<ApiResponse>;
  /** Polls `path` until `pred` accepts the parsed body, then returns that response. Throws on timeout. */
  requestUntil(path: string, pred: (body: unknown) => boolean, timeoutMs?: number): Promise<ApiResponse>;
  close(): Promise<void>;
}

/**
 * Drives the real express app over a real socket on an ephemeral port, so middleware order, body
 * parsing, status codes and the error handler are all exercised. Route handlers called directly
 * with a stub `res` see none of that.
 */
export async function startTestApi(
  streamOrchestrator: StreamOrchestrator,
  engines: EnginePlugin[] = [],
  limits?: RequestLimits,
): Promise<ApiTestServer> {
  const server = http.createServer(createApiApp(streamOrchestrator, { authToken: TEST_AUTH_TOKEN, engines, limits }));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });

  const { port } = server.address() as AddressInfo;
  const origin = `http://${LOOPBACK_HOST}:${port}`;

  async function request(path: string, init?: RequestInit): Promise<ApiResponse> {
    // Authenticated unless the caller says otherwise, so every pre-auth test keeps working unchanged
    // and the tests that drive the gate opt out explicitly rather than by forgetting a header.
    const supplied = new Headers(init?.headers);
    if (!supplied.has('authorization')) {
      supplied.set('authorization', `Bearer ${TEST_AUTH_TOKEN}`);
    }
    if (supplied.get('authorization') === NO_AUTH_HEADER.authorization) {
      supplied.delete('authorization');
    }
    const response = await fetch(`${origin}${path}`, { ...init, headers: supplied });
    const headers = Object.fromEntries(response.headers);
    const text = await response.text();
    if (text === '') {
      return { status: response.status, body: undefined, headers };
    }
    // Parsed by what the server said it sent, rather than by assuming JSON. `/metrics` serves
    // Prometheus exposition, and parsing that as JSON throws a syntax error that reads like a broken
    // route instead of a test helper that only knows one content type.
    const isJson = response.headers.get('content-type')?.includes('json') ?? false;
    return { status: response.status, body: isJson ? JSON.parse(text) : text, headers };
  }

  async function rawRequest(request: string): Promise<number> {
    const socket = net.connect(port, LOOPBACK_HOST);
    try {
      await once(socket, 'connect');
      socket.write(request);
      // A bounded wait, so a body parser that sits in front of the gate and waits for a body that
      // never comes fails this test rather than hanging the run with no tally to read.
      socket.setTimeout(RAW_RESPONSE_TIMEOUT_MS, () => socket.destroy(new Error('no response')));
      const [chunk] = (await once(socket, 'data')) as [Buffer];
      return Number(/^HTTP\/1\.\d (\d{3})/.exec(chunk.toString())?.[1]);
    } finally {
      socket.destroy();
    }
  }

  return {
    request,
    rawRequest,

    async requestUntil(path, pred, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      let last = await request(path);
      while (!pred(last.body)) {
        assert.ok(
          Date.now() < deadline,
          `GET ${path} never satisfied the condition within ${timeoutMs}ms, last body: ${JSON.stringify(last.body)}`,
        );
        await sleep(POLL_INTERVAL_MS);
        last = await request(path);
      }
      return last;
    },

    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
