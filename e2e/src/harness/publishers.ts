/**
 * One rung's routing, exactly as the uploader's `/health` reports it.
 *
 * Mirrors `PublisherRoute` in `packages/stream-uploader/src/libs/BeePublisherPool.ts`. The batch is
 * already truncated there and the url already has any credential removed, so neither is safe to
 * treat as a value that can be dialed or spent with, only compared and displayed.
 */
export interface PublisherRoute {
  rung: string;
  url: string;
  batch: string;
}

/** A Bee node the deployment publishes through, and how the suite reaches it from the host. */
export interface PublisherNode {
  /** Every rung routed to this node, in the order `/health` listed them. */
  rungs: string[];
  /** As the uploader has it configured. */
  url: string;
  batch: string;
  /** The port on the deployment host that reaches this node's bee API. */
  port: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Group a `/health` routing into the nodes behind it, each with a port the suite can dial.
 *
 * The url on a route is the one the **uploader** dials. The suite dials from the deployment host, so
 * the two coincide only when the nodes are on the host network. A split deployment is: each per-rung
 * bee runs `network_mode: host` and its url carries the real host port. An unsplit one usually is
 * not, because `bee-uploader` is a compose service name that resolves inside the container network
 * and nowhere else, and the host port is a separate thing the deploy publishes.
 *
 * Hence two rules and no third. A loopback url carries its own port. A single node named any other
 * way is the unsplit deployment, and `deployPort` is the port the deploy published for it. Anything
 * else is refused, because a preflight that guessed would read one node's chequebook and report it
 * under another node's name.
 */
export function nodesBehind(routes: readonly PublisherRoute[] | undefined, deployPort: number): PublisherNode[] {
  if (routes === undefined || routes.length === 0) {
    throw new Error(
      'the uploader did not report its publisher routing on /health. An empty answer is not a ' +
        'deployment with no publishers, it is a deployment that cannot say, and the two must not be ' +
        'read the same way. Redeploy the uploader: `publishers` was added to the health body when the ' +
        'per-rung split landed, and a build without it cannot be checked for which node carries what.',
    );
  }

  const byUrl = new Map<string, PublisherNode>();
  for (const route of routes) {
    const existing = byUrl.get(route.url);
    if (existing) {
      existing.rungs.push(route.rung);
      continue;
    }
    byUrl.set(route.url, { rungs: [route.rung], url: route.url, batch: route.batch, port: 0 });
  }

  const nodes = [...byUrl.values()];
  return nodes.map((node) => ({ ...node, port: portOf(node, nodes.length, deployPort) }));
}

function portOf(node: PublisherNode, nodeCount: number, deployPort: number): number {
  const parsed = parseUrl(node.url);

  if (LOOPBACK_HOSTS.has(parsed.hostname)) {
    if (parsed.port === '') {
      throw new Error(
        `the node carrying ${node.rungs.join(', ')} names no port (${node.url}), so there is nothing ` +
          "to dial. bee's default is 1633 but assuming it would have the suite read whatever answers " +
          'on that port, which on a slotted deployment is another profile’s node.',
      );
    }
    return Number(parsed.port);
  }

  if (nodeCount === 1) {
    return deployPort;
  }

  throw new Error(
    `the node carrying ${node.rungs.join(', ')} cannot be reached from the deployment host: ` +
      `${node.url} resolves inside the container network, and with ${nodeCount} nodes there is no one ` +
      'published port to fall back to. Run the per-rung bee nodes on the host network, which is what ' +
      'docker-compose.host.yml already does, so their urls carry the port the host can dial.',
  );
}

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`a publisher route on /health is not a url: "${url}"`);
  }
}
