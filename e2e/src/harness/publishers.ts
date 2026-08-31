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

/**
 * The compose service carrying each rung's Bee node.
 *
 * ⛔⛔⛔ THE E2E SIDE HAD NO NAME FOR THESE AT ALL UNTIL 2026-08-31, WHICH IS WHY A FAULT COULD ONLY
 * EVER REACH `bee-uploader`. `SERVICES` in `../config.ts` listed one bee publisher, so a suite that
 * wanted to take a rung's node down had nothing to ask for. On a four-node stage that made
 * `scenarios/bee-outage-long` fail against a rung whose node was never touched, and made
 * `scenarios/bee-outage-short` **pass while testing nothing**, which is the worse of the two.
 *
 * ⚠️ Mirrors `RUNG_PORT_VARS` in `deploy/scripts/bee-publishers.sh`, the same topology in the
 * deployment's own language. `test/publishers.test.ts` refuses the two drifting apart, because a map
 * that disagrees with the deployment names a container that is not there and a fault that silently
 * does nothing is indistinguishable from one the product survived.
 *
 * 360p is on the shared `bee-uploader` deliberately: the catalog and every ladder master go through
 * the coordinator, which is the lowest rung.
 */
export const BEE_SERVICE_BY_RUNG: Readonly<Record<string, string>> = {
  '360p': 'bee-uploader',
  '480p': 'bee-uploader-480p',
  '720p': 'bee-uploader-720p',
  '1080p': 'bee-uploader-1080p',
};

/**
 * The rung name a single-node deployment reports, out of `SINGLE_PUBLISHER` in the uploader's pool.
 *
 * Not a rung at all: it means one node carries everything, so it maps to the shared service.
 */
const EVERY_RUNG = 'all';

/**
 * The lowest rung, which rides the shared `bee-uploader`.
 *
 * `AbrLadder.rungs()` sorts ascending by height, so this is the pool's coordinator, and the catalog
 * and every ladder master go through it.
 */
const COORDINATOR_RUNG = '360p';

/**
 * Every compose service that would have to go down to take this routing's publishing with it.
 *
 * ⛔ Resolved per NODE and never per rung, which is the correction that mattered. A rung does not
 * name a container: two rungs routed to one port are one Bee node, and mapping each rung separately
 * would name a second container that is carrying nothing, so a fault would stop a node the routing
 * never used while leaving the one it did.
 *
 * The shared `bee-uploader` is identified by carrying the coordinator rung or by carrying everything,
 * because that is what the unsplit stage and the split stage's lowest rung both are.
 *
 * ⛔ Refuses rather than returning the services it does know. A fault reaching three nodes of four is
 * the defect this exists to end, and a partial list is exactly how it would come back.
 */
export function publisherServices(nodes: readonly PublisherNode[]): string[] {
  if (nodes.length === 0) {
    throw new Error(
      'asked which services carry a publisher routing with no nodes in it. An empty routing ' +
        'establishes nothing, so it is refused rather than answered with an empty fault.',
    );
  }

  const services: string[] = [];
  for (const node of nodes) {
    const service = serviceCarrying(node);
    if (!services.includes(service)) {
      services.push(service);
    }
  }
  return services;
}

/** The one container behind a node, or a refusal naming why this topology cannot be resolved. */
function serviceCarrying(node: PublisherNode): string {
  if (node.rungs.includes(EVERY_RUNG) || node.rungs.includes(COORDINATOR_RUNG)) {
    return BEE_SERVICE_BY_RUNG[COORDINATOR_RUNG];
  }
  if (node.rungs.length === 1) {
    const service = BEE_SERVICE_BY_RUNG[node.rungs[0]];
    if (service === undefined) {
      throw new Error(
        `rung '${node.rungs[0]}' on ${node.url} has no Bee service in BEE_SERVICE_BY_RUNG, so a ` +
          'fault cannot reach it. Adding a rung means adding its service there, its compose service ' +
          'in deploy/docker-compose.yml, and its ports in deploy/scripts/_lib.sh.',
      );
    }
    return service;
  }
  throw new Error(
    `${node.url} carries ${node.rungs.join(', ')} and none of them is the coordinator, so which ` +
      'container is behind it cannot be worked out from the rung names alone. A fault aimed by ' +
      'guess would stop a node this routing does not use. Name the topology in BEE_SERVICE_BY_RUNG.',
  );
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

  // ⛔ Grouped by `host:port` rather than by the url string. Two rungs can name one node with and
  // without a trailing slash, or with userinfo on one of them, and grouping on the raw string would
  // read that as two nodes: the funding preflight would then read one chequebook twice, and
  // `judgeCost` would count that node's spend twice while dividing by the run's bytes once.
  const byNode = new Map<string, PublisherNode>();
  for (const route of routes) {
    const key = parseUrl(route.url).host;
    const existing = byNode.get(key);
    if (existing) {
      existing.rungs.push(route.rung);
      continue;
    }
    byNode.set(key, { rungs: [route.rung], url: route.url, batch: route.batch, port: 0 });
  }

  const nodes = [...byNode.values()];
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
