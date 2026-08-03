import assert from 'node:assert/strict';
import { once } from 'node:events';
import net, { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { readStatusCode } from './helpers/apiTestServer.js';
import { LOOPBACK_HOST } from './helpers/loopbackServer.js';

/**
 * That the raw-socket helper reads a status line however TCP delivers it. See TEST-53.
 *
 * `srsWebhookAuth.test.ts` asserts `401` on four oversized and unparseable bodies through this
 * helper, and one of those failed once under a full `pnpm verify` and then passed three times in
 * isolation. That signature reads like contention and is not: the helper took a single `data` event
 * and ran the status regex over that chunk, and a `data` event is not a message boundary. A response
 * split as `HTTP/1.1 40` + `1 Unauthorized` missed the regex entirely and the helper returned `NaN`.
 * Load only decides where the split lands.
 *
 * The real app cannot be made to split on demand, so these drive servers that split on purpose. That
 * is the only way the defect is reachable from a test rather than from a busy machine.
 */

const servers: net.Server[] = [];

after(async () => {
  for (const server of servers) {
    server.close();
  }
});

/**
 * Long enough that loopback does not coalesce consecutive writes into one TCP segment.
 *
 * Measured rather than chosen: with `setImmediate` between the writes, the two-chunk case **passed
 * against the very implementation it was written to catch**, because both writes landed in a single
 * `data` event and the old single-chunk read saw a whole status line. A test that cannot observe the
 * split is not testing the split.
 */
const CHUNK_GAP_MS = 5;

/** A server that writes `chunks` in order, spaced so the client sees each as its own `data` event. */
async function serverWriting(chunks: readonly string[]): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on('data', () => {});
    // The reader closes as soon as it has the status line, so every chunk after that one writes into
    // a socket the peer has already destroyed. Without both of these the one-byte-at-a-time case
    // raises EPIPE after its test has ended, which the runner reports as a failure of the whole file.
    socket.on('error', () => {});
    void (async () => {
      for (const chunk of chunks) {
        if (socket.destroyed || socket.writableEnded) {
          return;
        }
        socket.write(chunk);
        await new Promise((resolve) => setTimeout(resolve, CHUNK_GAP_MS));
      }
    })();
  });
  servers.push(server);
  server.listen(0, LOOPBACK_HOST);
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

describe('reading a status code off a raw socket', () => {
  it('reads it when the whole response arrives in one chunk', async () => {
    const port = await serverWriting(['HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n']);

    assert.equal(await readStatusCode(port, 'POST / HTTP/1.1\r\nHost: x\r\n\r\n'), 401);
  });

  /**
   * The case that was failing. Split inside the status code itself, which is the worst placement and
   * the one a chunk boundary is free to choose.
   */
  it('reads it when the status line is split across two chunks', async () => {
    const port = await serverWriting(['HTTP/1.1 40', '1 Unauthorized\r\nContent-Length: 0\r\n\r\n']);

    assert.equal(await readStatusCode(port, 'POST / HTTP/1.1\r\nHost: x\r\n\r\n'), 401);
  });

  it('reads it when the response arrives one byte at a time', async () => {
    const port = await serverWriting([...'HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\n\r\n']);

    assert.equal(await readStatusCode(port, 'POST / HTTP/1.1\r\nHost: x\r\n\r\n'), 413);
  });

  /**
   * A wrong answer has to be an error rather than `NaN`. The old helper returned `NaN` for anything
   * it could not match, and `assert.equal(NaN, 401)` fails with a message about the number rather
   * than about the socket, which is what sent the first investigation looking at the rate limiter.
   */
  it('throws rather than returning NaN when the peer speaks no HTTP', async () => {
    const port = await serverWriting(['GARBAGE, not a status line\r\n\r\n']);

    await assert.rejects(() => readStatusCode(port, 'POST / HTTP/1.1\r\nHost: x\r\n\r\n'), /not an HTTP status line/);
  });

  it('throws when the peer closes before sending a line at all', async () => {
    const port = await serverWriting([]);
    const server = servers[servers.length - 1];
    server.on('connection', (socket) => setImmediate(() => socket.end()));

    await assert.rejects(() => readStatusCode(port, 'POST / HTTP/1.1\r\nHost: x\r\n\r\n'), /before a status line/);
  });
});
