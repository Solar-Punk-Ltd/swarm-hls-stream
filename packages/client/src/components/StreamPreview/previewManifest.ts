import type { Segment } from '@swarm-hls-stream/shared';

import { isMasterPlaylist, masterVariants, parseManifest } from '@/components/SwarmHlsPlayer/playlist';
import { fetchWithTimeout, TimedResponse } from '@/utils/fetchWithTimeout';
import { thumbnailManifestUrl } from '@/utils/thumbnailManifest';

/** The catalog entry fields a stream card reads its preview manifest by. */
export interface PreviewEntry {
  owner: string;
  topic: string;
  /** The SOC index of this stream's final manifest, published by the uploader on a finished stream. */
  index?: number;
}

/**
 * The manifest a preview takes its frame from, following one level of indirection.
 *
 * A ladder's catalog topic is its master playlist, which has no segments in it — so a thumbnail
 * taken straight from the feed would find nothing and every ABR stream would show the placeholder
 * image. The lowest rung is the cheapest frame to fetch and is listed first.
 *
 * The response is returned alongside the segments because `previewSourceFrom` needs it: an empty
 * playlist and a 404 page parse to the same empty segment list, and only the status tells them
 * apart. It is the response the segments were read from, which on a ladder is the rung's rather than
 * the master's.
 *
 * @param fetcher injected only by tests, production always uses the global.
 */
export async function fetchPreviewManifest(
  gatewayUrl: string,
  entry: PreviewEntry,
  signal: AbortSignal,
  fetcher?: typeof fetch,
): Promise<{ res: TimedResponse; segments: Segment[] }> {
  const res = await fetchWithTimeout(thumbnailManifestUrl(gatewayUrl, entry.owner, entry.topic, entry.index), {
    signal,
    fetcher,
  });
  if (!isMasterPlaylist(res.text)) {
    return { res, segments: parseManifest(res.text).segments };
  }

  const [variant] = masterVariants(res.text);
  if (!variant) {
    return { res, segments: [] };
  }

  // No index for the rung. The catalog entry's `index` addresses the final manifest of the *catalog*
  // topic, which on a ladder is the master, so this rung pays the head lookup the top level no
  // longer does. The rungs carry their own indices in `Rendition.index`, which this component is not
  // handed.
  const rung = await fetchWithTimeout(thumbnailManifestUrl(gatewayUrl, variant.owner || entry.owner, variant.topic), {
    signal,
    fetcher,
  });
  return { res: rung, segments: parseManifest(rung.text).segments };
}
