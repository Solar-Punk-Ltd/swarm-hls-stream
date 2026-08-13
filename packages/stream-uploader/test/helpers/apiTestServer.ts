import assert from 'node:assert/strict';
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

/**
 * Socket errors that mean the peer stopped reading while this side was still sending.
 *
 * ⭐ **For a server that refuses a request before reading its body, this is the behaviour under test.**
 * The gate answers and the connection is destroyed, and whatever is left of a large body in this
 * side's send buffer then fails. `srsWebhookAuth.test.ts` posts a 200 KB body it expects to be refused
 * pre-parse, so it provokes exactly this every time; whether the write has drained before the answer
 * arrives is decided by machine load, which is why it failed under a full `pnpm verify` and passed
 * three times in isolation.
 *
 * ⚠️ **Ignored as a cause, never as an answer.** A request that gets no status line still rejects on
 * `close`, so no caller's assertion is weakened by this: an oversized body that was quietly accepted,
 * or refused with the wrong code, fails exactly as before.
 */
const PEER_STOPPED_READING = new Set(['EPIPE', 'ECONNRESET']);

function isPeerStoppedReading(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && PEER_STOPPED_READING.has(code);
}

/**
 * Sends a hand-written request to `port` and resolves the status code from the response's first line.
 *
 * **Accumulates until that line is complete, which is the whole point of it existing.** This used to
 * read a single `data` event and run the status regex over that chunk. A `data` event is not a
 * message boundary: TCP may split a response anywhere, so a response arriving as `HTTP/1.1 40` then
 * `1 Unauthorized` missed the regex and the helper returned `NaN`, failing whatever asserted `401`.
 * That is why `srsWebhookAuth.test.ts` failed once under a full `pnpm verify` and passed in
 * isolation: load changes where the chunk boundaries land, and nothing else about the test. See
 * TEST-53.
 *
 * **Reading and sending are settled separately**, which is the second reason it is not a plain
 * `for await` over the socket. Iterating couples them: the send failing tears down the read, so an
 * answer already in flight is thrown away and replaced by the `EPIPE` that proves the answer was
 * sent. See `isPeerStoppedReading`.
 *
 * ⛔ **That does not make a request that sends a body safe, and no amount of care on this side can.**
 * Separating the two only stops *this* side from throwing the answer away. The loss that remains
 * happens below Node: when the server closes with the request body still unread, TCP answers with
 * **RST** rather than FIN, and an RST makes this side's kernel discard bytes it has received but not
 * yet read. Measured against `createApiApp` with the SRS engine mounted and `Connection: close`, the
 * 401 was lost on 50 of 60 attempts with a 4 MB body and 35 of 60 with 40 MB. Use
 * `withheldBodyRequest` for anything asserting a refusal that precedes the body.
 *
 * Exported so it can be pointed at a server that splits on purpose, or hangs up mid-write on purpose,
 * neither of which a test using the real app can make it do.
 */
export async function readStatusCode(port: number, request: string): Promise<number> {
  const socket = net.connect(port, LOOPBACK_HOST);
  try {
    return await new Promise<number>((resolve, reject) => {
      let buffered = '';
      let settled = false;
      const settle = (finish: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        finish();
      };

      // A bounded wait, so a body parser that sits in front of the gate and waits for a body that
      // never comes fails this test rather than hanging the run with no tally to read.
      socket.setTimeout(RAW_RESPONSE_TIMEOUT_MS, () => settle(() => reject(new Error('no response'))));

      socket.on('data', (chunk: Buffer) => {
        buffered += String(chunk);
        const lineEnd = buffered.indexOf('\r\n');
        if (lineEnd === -1) {
          return;
        }
        const statusLine = buffered.slice(0, lineEnd);
        const status = /^HTTP\/1\.\d (\d{3})/.exec(statusLine);
        settle(() =>
          status
            ? resolve(Number(status[1]))
            : reject(new Error(`not an HTTP status line: ${JSON.stringify(statusLine)}`)),
        );
      });

      // Not `socket.destroy(error)` and not a rethrow: see `isPeerStoppedReading`. An error here is
      // only ever a *cause*, and what the request was answered with is decided by `data` and `close`.
      socket.on('error', (error) => {
        if (isPeerStoppedReading(error)) {
          return;
        }
        settle(() => reject(error));
      });

      socket.on('close', () =>
        settle(() =>
          reject(new Error(`connection closed before a status line arrived: ${JSON.stringify(buffered.slice(0, 80))}`)),
        ),
      );

      socket.on('connect', () => socket.write(request));
    });
  } finally {
    socket.destroy();
  }
}

export interface WithheldBodyRequest {
  path: string;
  /** The `Content-Length` the request announces and then never sends. */
  declaredBodyBytes: number;
  method?: string;
  /** `Content-Length` is appended last, so a caller cannot accidentally contradict the declaration. */
  headers?: Record<string, string>;
}

/**
 * A request head that announces a body and then never sends it.
 *
 * ⭐ **The deterministic way to observe a refusal that happens before the body is read.** Sending the
 * body is what made that observation a coin flip: the client is still writing when the gate answers,
 * so the server holds unread bytes when it closes, and a close over unread data is an RST, which
 * makes the client discard the answer it had already received. `readStatusCode` says what was
 * measured. Withholding the body removes the precondition rather than tolerating the loss, because
 * nothing is in flight for the server to reset over. Measured at 60 of 60 against the real app at
 * 200 KB, 4 MB and 40 MB declared, where sending 4 MB lost the answer 50 times in 60.
 *
 * ⭐ **It also asserts more than sending the body did.** A server that answers while the body is
 * still owed cannot have read or parsed it. A status read after the body was sent is equally
 * consistent with a parser that read every byte first, which is the thing the caller wants to rule
 * out.
 *
 * ⚠️ A server that waits for the announced body gets no answer out of this and fails its caller on
 * the `readStatusCode` timeout. That is the point rather than a limitation: a gate that moved behind
 * the parser cannot produce a pass. See `rawStatusLine.test.ts`.
 *
 * `Connection: close` is kept rather than avoided. It is what makes Node's HTTP server hang up the
 * hard way, which is the close that loses an answer, and withholding the body is what makes that
 * close harmless: the server has nothing unread to reset over, so it sends FIN. Keeping it also
 * leaves no half-open connection for `startTestApi`'s `close` to wait on.
 */
export function withheldBodyRequest({
  path,
  declaredBodyBytes,
  method = 'POST',
  headers = {},
}: WithheldBodyRequest): string {
  const head = { Host: 'x', Connection: 'close', ...headers, 'Content-Length': String(declaredBodyBytes) };
  const lines = Object.entries(head).map(([name, value]) => `${name}: ${value}\r\n`);
  return `${method} ${path} HTTP/1.1\r\n${lines.join('')}\r\n`;
}

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
    return readStatusCode(port, request);
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
