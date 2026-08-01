import { Express } from 'express';
import { once } from 'node:events';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * The one host every test server binds and every test client dials. Both come from here because the
 * two agreeing is a correctness property, not a formatting preference. See {@link listenOnLoopback}.
 */
export const LOOPBACK_HOST = '127.0.0.1';

export interface LoopbackServer {
  server: Server;
  /** Origin for the bound socket, e.g. `http://127.0.0.1:54321`. Derived from the bind, never rebuilt. */
  baseUrl: string;
}

/**
 * Binds an express app to a free port on the IPv4 loopback and hands back the origin that reaches it.
 *
 * The address family is the whole point. `app.listen(0)` with no host binds `::`, and the OS will
 * hand out an ephemeral port that another process already holds on IPv4, because with an IPv4 bind in
 * the way the IPv6 socket ends up v6-only and the two no longer conflict. A test that then dials
 * `http://127.0.0.1:<port>` reaches **that other process**, whose reply is not HTTP, so undici raises
 * `HPE_INVALID_CONSTANT: Response does not match the HTTP/1.1 protocol (Expected HTTP/)`.
 *
 * Measured on 2026-08-01: three failures across 280 suite runs, every one of them on port 57446,
 * which a desktop application on the machine was holding as `*:57446`. Binding that port the way this
 * helper does and dialling `127.0.0.1` answers 200 from the test's own server, while binding it the
 * old way and dialling the same URL reproduces the parser error on demand. See TEST-31.
 *
 * Returning the origin rather than the port is what keeps it fixed: a caller cannot reintroduce the
 * mismatch by writing the host out again.
 */
export async function listenOnLoopback(app: Express): Promise<LoopbackServer> {
  const server = app.listen(0, LOOPBACK_HOST);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return { server, baseUrl: `http://${LOOPBACK_HOST}:${port}` };
}
