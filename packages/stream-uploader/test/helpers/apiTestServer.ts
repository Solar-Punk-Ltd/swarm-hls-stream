import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { createApiApp } from '../../src/api/server.js';
import { EnginePlugin } from '../../src/engines/types.js';
import { StreamOrchestrator } from '../../src/libs/StreamOrchestrator.js';

const POLL_INTERVAL_MS = 10;

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface ApiTestServer {
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
  const server = http.createServer(createApiApp(streamOrchestrator, engines));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  async function request(path: string, init?: RequestInit): Promise<ApiResponse> {
    const response = await fetch(`${origin}${path}`, init);
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
