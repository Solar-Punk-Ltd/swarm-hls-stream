/**
 * A path on the gateway as an absolute URL, whichever form the gateway was configured in.
 *
 * The gateway is either a URL, such as `http://localhost:1633`, or a rooted path on the viewer's own
 * origin. The second is what every deployed viewer is built with: `VITE_READER_BEE_URL=/bee`, so it
 * reaches Bee through its own nginx proxy (`deploy/Dockerfile.client`). Anything written into a
 * playlist has to be absolute, because hls.js resolves a playlist's lines against that playlist's own
 * URL, which in this client is a blob or a `swarm://` URI, and neither leads back to the page.
 *
 * `URL` ignores the origin when the gateway already names one, so an absolute gateway comes back
 * with only its trailing slashes normalised.
 */
export function absoluteGatewayUrl(gatewayUrl: string, path: string, origin: string): string {
  return new URL(`${gatewayUrl.replace(/\/+$/, '')}${path}`, origin).href;
}
