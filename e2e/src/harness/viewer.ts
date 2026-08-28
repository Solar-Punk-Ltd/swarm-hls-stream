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
  /** Present on a ladder entry: one per rung, each with its own session topic. */
  renditions?: { name: string; topic: string }[];
}

/**
 * Whether an entry belongs to a broadcast identified by its announced session topics.
 *
 * A single-rendition entry's own `topic` is the session topic. A ladder entry's own `topic` is the
 * MASTER feed's, which is the ladder group and survives engine deaths and recoveries, so the session
 * identity lives in the rung topics under `renditions`. Matching on `entry.topic` alone therefore
 * finds single-rendition broadcasts and is blind to ladders (found live 2026-08-27, twice).
 */
export function entryCarriesTopic(entry: CatalogEntry, topics: ReadonlySet<string>): boolean {
  if (topics.has(entry.topic)) {
    return true;
  }
  return (entry.renditions ?? []).some((rendition) => topics.has(rendition.topic));
}

/** Feed location = signer address (owner) + the hashed `swarm-stream` list topic. */
export interface CatalogFeed {
  owner: string;
  topicHex: string;
}

/** Both `[StreamCatalog]` log variants print `owner=<40hex> … topicHex=<64hex>` in that order. */
const RE_CATALOG_FEED = /\[StreamCatalog\][^\n]*owner=([0-9a-f]{40})[^\n]*topicHex=([0-9a-f]{64})/g;

/**
 * How much further back to look when the recent log holds no catalog line.
 *
 * The feed location does not change for the life of the deployment, so any line ever written names
 * it. A shallow tail finds one whenever a broadcast has just run, which is the case inside a full
 * suite: each scenario publishes, so the next one's discovery is cheap. Run a scenario on its own
 * against a deployment that has been idle for hours and the last line has scrolled away, and the
 * suite failed before reaching anything it meant to test.
 */
const DEEP_TAIL_MULTIPLIER = 50;

/** Discover the catalog feed (owner + hashed topic) from the uploader's own StreamCatalog log lines. */
export async function discoverCatalogFeed(host: Host, cfg: E2EConfig, tail: number = 1000): Promise<CatalogFeed> {
  const container = containerName(cfg, 'stream-uploader');
  const lastMatch = (text: string) => [...text.matchAll(RE_CATALOG_FEED)].at(-1);

  const match =
    lastMatch(await host.logs(container, tail)) ?? lastMatch(await host.logs(container, tail * DEEP_TAIL_MULTIPLIER));
  if (!match) {
    throw new Error(
      `no [StreamCatalog] owner/topicHex line in the last ${tail * DEEP_TAIL_MULTIPLIER} lines of ${container} ` +
        '— cannot locate the catalog feed. The uploader has never announced a stream, or its log has rotated.',
    );
  }
  return { owner: match[1], topicHex: match[2] };
}

/**
 * Fetch + parse the catalog the viewer sees, resolved through the bee-gateway feed endpoint.
 *
 * ⛔ Validated at this boundary: mid-restart the gateway answers its own JSON error envelope, which
 * parses fine and is not a catalog. Cast through, `.find` on it took scenario I down as a TypeError
 * instead of a retry. Thrown instead, the callers' existing catch-to-empty reads it as "not yet".
 */
export async function fetchCatalog(host: Host, cfg: E2EConfig, feed: CatalogFeed): Promise<CatalogEntry[]> {
  const body = await host.localJson<unknown>(cfg.ports.beeGatewayApi, `/feeds/${feed.owner}/${feed.topicHex}`, 8);
  if (!Array.isArray(body)) {
    throw new Error(`the catalog feed answered with a non-array: ${JSON.stringify(body)?.slice(0, 200)}`);
  }
  return body as CatalogEntry[];
}
