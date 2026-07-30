import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { createApiApp } from '../../src/api/server.js';
import { EnginePlugin } from '../../src/engines/types.js';
import { StreamOrchestrator } from '../../src/libs/StreamOrchestrator.js';

const POLL_INTERVAL_MS = 10;

/** Long enough to satisfy the production minimum, so tests exercise the real gate rather than a relaxed one. */
export const TEST_AUTH_TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface ApiTestServer {
  /** Authenticated by default. Pass an `authorization` header, or `null` for it, to drive the gate itself. */
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
): Promise<ApiTestServer> {
  const server = http.createServer(createApiApp(streamOrchestrator, { authToken: TEST_AUTH_TOKEN, engines }));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  async function request(path: string, init?: RequestInit): Promise<ApiResponse> {
    // Authenticated unless the caller says otherwise, so every pre-auth test keeps working unchanged
    // and the tests that drive the gate opt out explicitly rather than by forgetting a header.
    const supplied = new Headers(init?.headers);
    if (!supplied.has('authorization')) {
      supplied.set('authorization', `Bearer ${TEST_AUTH_TOKEN}`);
    }
    if (supplied.get('authorization') === 'none') {
      supplied.delete('authorization');
    }
    const response = await fetch(`${origin}${path}`, { ...init, headers: supplied });
    const text = await response.text();
    return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
  }

  return {
    request,

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
