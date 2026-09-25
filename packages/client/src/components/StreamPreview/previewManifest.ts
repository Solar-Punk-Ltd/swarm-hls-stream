import type { Segment } from '@swarm-hls-stream/shared';

import { isMasterPlaylist, masterVariants, parseManifest } from '@/components/SwarmHlsPlayer/playlist';
import { Rendition, STREAM_STATUS_VOD, StreamState } from '@/types/stream';
import { fetchWithTimeout, TimedResponse } from '@/utils/fetchWithTimeout';
import { thumbnailManifestUrl } from '@/utils/thumbnailManifest';

/** The catalog entry fields a stream card reads its preview manifest by. */
export interface PreviewEntry {
  owner: string;
  topic: string;
  /** The SOC index of this stream's final manifest, published by the uploader on a finished stream. */
  index?: number;
  state?: StreamState;
  /** A ladder's rungs. On a finished entry each rung that recorded names its final slot in `index`. */
  renditions?: readonly Rendition[];
}

/**
 * The manifest a preview takes its frame from, following one level of indirection.
 *
 * A ladder's catalog topic is its master playlist, which has no segments in it, so a thumbnail taken
 * straight from the feed would find nothing and every ABR stream would show the placeholder image.
 * The lowest rung is the cheapest frame to fetch and is listed first.
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

  const rung = await fetchWithTimeout(
    thumbnailManifestUrl(
      gatewayUrl,
      variant.owner || entry.owner,
      variant.topic,
      finishedRungIndex(entry, variant.topic),
    ),
    { signal, fetcher },
  );
  return { res: rung, segments: parseManifest(rung.text).segments };
}

/**
 * Where a finished ladder recorded this rung's final playlist, or undefined to search the feed.
 *
 * ⛔ The entry's own `index` addresses the master, so a rung read without its own slot pays a head
 * lookup, and a head lookup grows with the feed. On 2026-09-24 a 10.1 hour recording's lookup ran
 * past the preview's 10 second limit and its card stayed blank, while the entry named the rung's
 * slot all along. The master's variant URI carries the rendition's own topic verbatim, so the rung
 * is found by topic rather than by position.
 *
 * A live entry keeps the search: its rungs are still being written, so a slot would be an old
 * playlist rather than the newest one.
 */
function finishedRungIndex(entry: PreviewEntry, rungTopic: string): number | undefined {
  if (entry.state !== STREAM_STATUS_VOD) {
    return undefined;
  }
  return entry.renditions?.find((rendition) => rendition.topic === rungTopic)?.index;
}

/**
 * Changes exactly when the rung slots a card would read change, so an effect can depend on it
 * rather than on the renditions array, which the catalog poll hands back fresh every time.
 */
export function rungSlotsKey(entry: Pick<PreviewEntry, 'state' | 'renditions'>): string {
  if (entry.state !== STREAM_STATUS_VOD || !entry.renditions) {
    return '';
  }
  return entry.renditions.map((rendition) => `${rendition.topic}@${rendition.index ?? ''}`).join('|');
}
