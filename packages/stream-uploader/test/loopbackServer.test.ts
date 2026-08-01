import express from 'express';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { after, describe, it } from 'node:test';

import { listenOnLoopback, LOOPBACK_HOST } from './helpers/loopbackServer.js';

/**
 * TEST-31, pinned deterministically rather than statistically.
 *
 * The failure it closes was a one-in-roughly-ninety full-suite run answering `TypeError: fetch
 * failed` from a test helper, and the two lenses that saw it never named it. It was not flaky
 * timing: the helper bound `::` via `app.listen(0)` and dialled `127.0.0.1`, so when the OS handed
 * out an ephemeral port that another process on the machine already held on IPv4, the request went
 * to that other process. Its reply is not HTTP, which is the `HPE_INVALID_CONSTANT` undici raised.
 *
 * A hunt can only ever say "it did not happen again this time", so the hazard is reconstructed here
 * instead. The squatter below is what the real conflict was, reduced to its essentials: something
 * holding the IPv4 wildcard on a port and answering in a protocol that is not HTTP.
 */
describe('listenOnLoopback binds the family it dials (TEST-31)', () => {
  const servers: net.Server[] = [];
  const squatterSockets: net.Socket[] = [];

  // Synchronous and destructive on purpose. Awaiting `close()` hangs here: the client that dialled a
  // squatter keeps its socket, so the server waits for a connection nothing will end, and the run
  // reports the whole suite cancelled with every test inside it passing.
  after(() => {
    for (const socket of squatterSockets) {
      socket.destroy();
    }
    for (const server of servers) {
      server.close();
    }
  });

  /** Holds the IPv4 wildcard on `port` and greets every caller in a protocol that is not HTTP. */
  async function squatOnIpv4(port: number): Promise<void> {
    const squatter = net.createServer((socket) => {
      squatterSockets.push(socket);
      socket.end('NOT-HTTP the squatter answered\r\n');
    });
    servers.push(squatter);
    squatter.listen(port, '0.0.0.0');
    await once(squatter, 'listening');
  }

  /** A port nothing holds, found by binding zero and giving it straight back. */
  async function reserveFreePort(): Promise<number> {
    const probe = net.createServer();
    probe.listen(0, '0.0.0.0');
    await once(probe, 'listening');
    const { port } = probe.address() as AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    return port;
  }

  function makeApp(): express.Express {
    const app = express();
    app.get('/probe', (_req, res) => res.json({ reached: 'the test server' }));
    return app;
  }

  /**
   * Binds, or reports that this platform will not let the conflict exist.
   *
   * The hazard needs an OS that allows an IPv6 bind to coexist with an IPv4 bind on the same port,
   * which is what makes the port look free to one and taken by the other. macOS allows it, which is
   * where this was measured. Linux, and therefore CI, refuses the second bind outright with
   * EADDRINUSE, so the two sockets can never both exist and the hazard cannot arise at all.
   *
   * Detected by attempting the bind rather than by reading `process.platform`, because the property
   * that matters is the bind behaviour and not the name of the operating system.
   */
  async function listenOrConflictRefused(app: express.Express, port: number, host?: string) {
    const server = host === undefined ? app.listen(port) : app.listen(port, host);
    try {
      await once(server, 'listening');
      servers.push(server);
      return server;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EADDRINUSE') {
        throw error;
      }
      server.close();
      return null;
    }
  }

  const CONFLICT_REFUSED = 'this platform refuses to bind both families on one port, so the hazard cannot arise here';

  /**
   * The hazard itself. If this stops reproducing, the assertion below it is no longer evidence of
   * anything, so it is asserted rather than assumed: an unqualified `listen` must be reachable on
   * IPv6 and must NOT be the thing answering on IPv4 while a squatter holds that address.
   */
  it('reproduces the failure that the old unqualified listen allowed', async (t) => {
    const port = await reserveFreePort();
    await squatOnIpv4(port);

    const server = await listenOrConflictRefused(makeApp(), port);
    if (!server) {
      t.skip(CONFLICT_REFUSED);
      return;
    }

    assert.equal(
      (server.address() as AddressInfo).address,
      '::',
      'an unqualified listen no longer binds IPv6, so this test no longer reproduces the hazard it exists to pin',
    );

    const overIpv6 = await fetch(`http://[::1]:${port}/probe`);
    assert.deepEqual(await overIpv6.json(), { reached: 'the test server' }, 'the server must be up on its own family');

    await assert.rejects(
      () => fetch(`http://${LOOPBACK_HOST}:${port}/probe`),
      (error: Error) => {
        // `Error.cause` is ES2022 and this project's test lib predates it, so the shape is declared
        // here rather than read off the built-in type.
        const { cause } = error as Error & { cause?: { code?: string } };
        assert.equal(
          cause?.code,
          'HPE_INVALID_CONSTANT',
          `dialling IPv4 reached something, but not the squatter this test set up: ${String(cause?.code)}`,
        );
        return true;
      },
      'binding IPv6 and dialling IPv4 reached the test server, so the port conflict was not set up',
    );
  });

  it('reaches its own server on a port another process holds on IPv4', async (t) => {
    const port = await reserveFreePort();
    await squatOnIpv4(port);

    // Bound the way every helper in this suite now binds, on the exact port the squatter holds.
    const server = await listenOrConflictRefused(makeApp(), port, LOOPBACK_HOST);
    if (!server) {
      t.skip(CONFLICT_REFUSED);
      return;
    }

    const response = await fetch(`http://${LOOPBACK_HOST}:${port}/probe`);

    assert.deepEqual(
      await response.json(),
      { reached: 'the test server' },
      'a squatter on the IPv4 wildcard answered instead of the test server',
    );
  });

  // What makes every caller of the helper immune, given the two tests above: it binds the family it
  // dials. Asserting the round trip alone would not catch a regression, because an unqualified bind
  // still answers its own dial on any port nothing else is holding, which is almost every port.
  it('binds the same family its origin dials', async () => {
    const { server, baseUrl } = await listenOnLoopback(makeApp());
    servers.push(server);

    const response = await fetch(`${baseUrl}/probe`);

    assert.equal(
      (server.address() as AddressInfo).family,
      'IPv4',
      `the helper bound a different family from the ${LOOPBACK_HOST} its origin dials, which is the TEST-31 hazard`,
    );
    assert.ok(
      baseUrl.startsWith(`http://${LOOPBACK_HOST}:`),
      `the origin dials a host the helper did not bind: ${baseUrl}`,
    );
    assert.deepEqual(await response.json(), { reached: 'the test server' });
  });
});
