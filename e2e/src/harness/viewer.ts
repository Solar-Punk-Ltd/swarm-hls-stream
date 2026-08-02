import { containerName, type E2EConfig } from '../config.js';

import type { Host } from './host.js';

/**
 * Viewer-facing helpers: read the stream catalog the client's StreamBrowser loads, resolved through
 * the bee-GATEWAY (not the uploader's private bee). This is the true player-visible layer — the same
 * `GET /feeds/{owner}/{topic}` the client makes. The catalog feed's owner + hashed topic are
 * discovered from the uploader's own logs so nothing is hard-coded to one deployment's stream key.
 */

export type StreamState = 'live' | 'vod';

/** One entry in the stream catalog JSON the uploader publishes and the client renders. */
export interface CatalogEntry {
  title: string;
  owner: string;
  topic: string;
  state: StreamState;
  index: number;
  duration?: number;
  mediatype: string;
  timestamp: number;
}

/** Feed location = signer address (owner) + the hashed `swarm-stream` list topic. */
export interface CatalogFeed {
  owner: string;
  topicHex: string;
}

/** Both `[StreamCatalog]` log variants print `owner=<40hex> … topicHex=<64hex>` in that order. */
const RE_CATALOG_FEED = /\[StreamCatalog\][^\n]*owner=([0-9a-f]{40})[^\n]*topicHex=([0-9a-f]{64})/g;

/** Discover the catalog feed (owner + hashed topic) from the uploader's own StreamCatalog log lines. */
export async function discoverCatalogFeed(host: Host, cfg: E2EConfig, tail: number = 1000): Promise<CatalogFeed> {
  const text = await host.logs(containerName(cfg, 'stream-uploader'), tail);
  const match = [...text.matchAll(RE_CATALOG_FEED)].at(-1);
  if (!match) {
    throw new Error('no [StreamCatalog] owner/topicHex line in the uploader logs — cannot locate the catalog feed');
  }
  return { owner: match[1], topicHex: match[2] };
}

/** Fetch + parse the catalog the viewer sees, resolved through the bee-gateway feed endpoint. */
export async function fetchCatalog(host: Host, cfg: E2EConfig, feed: CatalogFeed): Promise<CatalogEntry[]> {
  return host.localJson<CatalogEntry[]>(cfg.ports.beeGatewayApi, `/feeds/${feed.owner}/${feed.topicHex}`, 8);
}
