import assert from 'node:assert/strict';
import { once } from 'node:events';
import net, { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { readStatusCode, withheldBodyRequest } from './helpers/apiTestServer.js';
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

/**
 * That an answer sent *before* the request finished arriving is still the answer.
 *
 * This is what a gate ahead of the body parser does: it refuses on the headers, writes its status and
 * destroys the connection, all while the client is still pushing a body nobody is going to read. The
 * client's remaining write then fails with `EPIPE` or `ECONNRESET`.
 *
 * ⛔ **The helper used to iterate the socket, which couples the two.** The failed write tore down the
 * read, so the 401 already sitting in the receive buffer was discarded and replaced by the very error
 * that proved the 401 had been sent. `srsWebhookAuth.test.ts` posts a 200 KB body expecting a pre-parse
 * refusal, so it provokes this on every run, and only whether the write had drained first — a function
 * of machine load — decided whether the test passed.
 *
 * A large body rather than a small one, because the race needs the client's send to still be in flight
 * when the answer lands. A body that fits in one socket buffer completes before the server can reply
 * and reproduces nothing.
 */
describe('reading a status code when the peer hangs up mid-write', () => {
  const OVERSIZED_REQUEST = `POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 4000000\r\n\r\n${'x'.repeat(4_000_000)}`;

  /** A server that answers on the first byte it sees and destroys, ignoring the rest of the body. */
  async function serverRefusingBeforeTheBody(answer: string | null): Promise<number> {
    const server = net.createServer((socket) => {
      // The peer is mid-write when this destroys, so its own send fails too. Expected on both sides.
      socket.on('error', () => {});
      socket.once('data', () => {
        if (answer === null) {
          socket.destroy();
          return;
        }
        // ⚠️ `end`, not `write` then `destroy`, and the difference is not stylistic.
        //
        // `destroy()` discards whatever is still queued, so writing and destroying on the same tick
        // sends nothing and this server tests the no-answer case twice. Destroying from the write
        // callback is worse: the body is still arriving, so the socket closes with unread data in its
        // receive buffer, which is the case TCP answers with **RST** rather than FIN — and an RST
        // makes the peer discard bytes it has received but not yet read. The answer then vanishes at
        // random depending on whether the client got to it first, which is a flake and not a fixture.
        //
        // `end` sends the answer and then FIN, in order, so the client is guaranteed to receive it.
        // The client is still pushing megabytes into a peer that has closed, so its own write still
        // fails, which is the condition under test.
        socket.end(answer);
      });
    });
    servers.push(server);
    server.listen(0, LOOPBACK_HOST);
    await once(server, 'listening');
    return (server.address() as AddressInfo).port;
  }

  it('reads the status the peer sent before it hung up', async () => {
    const port = await serverRefusingBeforeTheBody('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');

    assert.equal(await readStatusCode(port, OVERSIZED_REQUEST), 401);
  });

  it('reads a 413 the same way, since which code is correct belongs to the caller', async () => {
    const port = await serverRefusingBeforeTheBody('HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\n\r\n');

    assert.equal(await readStatusCode(port, OVERSIZED_REQUEST), 413);
  });

  /**
   * ⭐ The assertion that keeps the tolerance honest. Swallowing `EPIPE` must not turn a server that
   * refused to answer at all into a pass: a body accepted in silence and a body refused with a status
   * are opposite outcomes, and only the second is what the callers assert.
   */
  it('still throws when the peer hangs up mid-write without answering', async () => {
    const port = await serverRefusingBeforeTheBody(null);

    await assert.rejects(() => readStatusCode(port, OVERSIZED_REQUEST), /before a status line/);
  });
});

/**
 * That a request announcing a body it never sends observes a pre-parse refusal, and cannot observe
 * anything else.
 *
 * The block above fixed how this side reads. It could not fix the loss underneath: when the server
 * closes with the request body still unread, TCP resets instead of finishing and the reset discards
 * the answer this side had already received. Against the real app that cost the 401 on 50 of 60
 * attempts at 4 MB, and rarely enough at the 200 KB `srsWebhookAuth.test.ts` used to post to read as
 * contention rather than as a defect.
 *
 * `withheldBodyRequest` removes the in-flight body, so there is nothing for the server to reset over.
 * These pin both halves of that: the answer arrives through the close pattern that used to lose it,
 * and no body goes out to put the loss back.
 */
describe('announcing a body and never sending it', () => {
  const DECLARED_BYTES = 200_000;
  const HEAD_END = '\r\n\r\n';
  const UNAUTHORIZED = 'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n';
  const TOO_LARGE = 'HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\n\r\n';

  const announcedRequest = (): string => withheldBodyRequest({ path: '/x', declaredBodyBytes: DECLARED_BYTES });

  function bodyBytesAfterHead(received: string): number {
    const headEnd = received.indexOf(HEAD_END);
    return headEnd === -1 ? 0 : Buffer.byteLength(received.slice(headEnd + HEAD_END.length));
  }

  const onTheHead =
    (answer: string) =>
    (received: string): string | null =>
      received.includes(HEAD_END) ? answer : null;

  const onlyOnceTheBodyIsWhole =
    (answer: string) =>
    (received: string): string | null =>
      bodyBytesAfterHead(received) >= DECLARED_BYTES ? answer : null;

  interface AnsweringServer {
    port: number;
    /** Everything the client sent, so a builder that quietly sends the body as well is visible here. */
    received(): string;
  }

  /**
   * A server that answers from whatever it has received so far.
   *
   * `hangUp` is `write` then `destroySoon`, which is how Node's HTTP server closes a `Connection:
   * close` response whose request body was never read. That is the exact close that discards the
   * answer when a body is in flight, so reading through it is the property worth pinning rather than
   * the gentler `end` the block above uses. `stayOpen` answers and keeps reading, which is the only
   * way to see what follows the head.
   */
  async function serverAnswering(
    answerFor: (received: string) => string | null,
    onAnswer: 'hangUp' | 'stayOpen',
  ): Promise<AnsweringServer> {
    let received = '';
    let answered = false;
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        received += String(chunk);
        const answer = answered ? null : answerFor(received);
        if (answer === null) {
          return;
        }
        answered = true;
        socket.write(answer);
        if (onAnswer === 'hangUp') {
          socket.destroySoon();
        }
      });
    });
    servers.push(server);
    server.listen(0, LOOPBACK_HOST);
    await once(server, 'listening');
    return { port: (server.address() as AddressInfo).port, received: () => received };
  }

  it('reads the status a server sent on the head alone', async () => {
    const { port } = await serverAnswering(onTheHead(UNAUTHORIZED), 'hangUp');

    assert.equal(await readStatusCode(port, announcedRequest()), 401);
  });

  it('reads a 413 the same way, since which code is correct belongs to the caller', async () => {
    // A gate that started answering the wrong code has to reach the caller as that code rather than
    // as a pass, or the tolerance that made this deterministic would launder a regression.
    const { port } = await serverAnswering(onTheHead(TOO_LARGE), 'hangUp');

    assert.equal(await readStatusCode(port, announcedRequest()), 413);
  });

  /**
   * ⭐ The guard on the builder itself. Every other test here passes just as well against a builder
   * that sends the body after announcing it, and that builder is the flake, so nothing above would
   * notice it coming back.
   */
  it('announces the length and then sends no body at all', async () => {
    const { port, received } = await serverAnswering(onTheHead(UNAUTHORIZED), 'stayOpen');

    assert.equal(await readStatusCode(port, announcedRequest()), 401);

    assert.match(received(), new RegExp(`Content-Length: ${DECLARED_BYTES}\r\n`), 'the length must be announced');
    assert.equal(bodyBytesAfterHead(received()), 0, 'a body going out anyway puts the RST loss straight back');
  });

  /**
   * ⭐ The assertion that keeps this honest as a test of a *pre-parse* refusal. A server that reads
   * the body before it answers is exactly the regression the callers exist to catch, and it must fail
   * them rather than resolve to anything at all.
   */
  it('gets no answer at all from a server that waits for the announced body', async () => {
    const { port } = await serverAnswering(onlyOnceTheBodyIsWhole(UNAUTHORIZED), 'stayOpen');

    await assert.rejects(() => readStatusCode(port, announcedRequest()), /no response/);
  });
});
