import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { feedSlotPath, nextFeedRequest } from '@swarm-hls-stream/shared';

/**
 * The one media line in a preview's playlist, always absolute against the gateway.
 *
 * A preview playlist is handed to hls.js as a blob, and hls.js resolves a relative media line against
 * the playlist's own URL. Resolving `/bytes/<ref>` against `blob:http://viewer/<uuid>` returns
 * `blob:http:/bytes/<ref>`, measured against hls.js 1.6.15's own resolver: the page origin and the
 * blob id are both consumed, so nothing downstream can work out which gateway was meant. The line has
 * to name it here or it cannot be named at all.
 *
 * A bare reference is what the uploader writes, and what every manifest published since 2026-08-13
 * holds. The other two shapes come from content published before that, when `MANIFEST_ACCESS_URL`
 * could prepend either a full URL or a rooted path, and only the rooted one reached hls.js
 * unresolved because the caller used to pass it through untouched. All three are still handled,
 * since a recording keeps whatever its manifest was published with.
 */
export function previewSegmentUrl(uri: string, gatewayUrl: string): string {
  if (uri.startsWith('http://') || uri.startsWith('https://')) {
    return uri;
  }
  return uri.startsWith('/') ? `${gatewayUrl}${uri}` : `${gatewayUrl}/bytes/${uri}`;
}

/**
 * Where a stream card fetches the manifest it builds its thumbnail from.
 *
 * **A finished stream's catalog entry already carries the SOC index of its own final manifest**, set
 * by the uploader in `notifyStop`. Until now the client read that field in exactly one place and only
 * to sort by it, so every card resolved `/feeds/{owner}/{topic}` to search for a position it had
 * already been handed. Measured against the real catalog on 2026-08-05: the head lookup is **2647ms
 * at the median** against **4ms** for the slot, and the two returned byte-identical manifests for 12
 * entries out of 12, with the head resolving to exactly the published index every time. The previews
 * share a queue at concurrency 1, so those lookups are serial and ten cards is about 26 seconds of
 * them. See `docs/reviews/catalog-off-the-head-lookup.md`.
 *
 * A live entry has no index to give, because `notifyStart` publishes none, so it keeps the search.
 */
export function thumbnailManifestUrl(gatewayUrl: string, owner: string, rawTopic: string, index?: number): string {
  const topic = Topic.fromString(rawTopic);
  if (!isAddressableSlot(index)) {
    return `${gatewayUrl}/${nextFeedRequest(owner, topic, null).path}`;
  }
  return `${gatewayUrl}/${feedSlotPath(owner, topic, FeedIndex.fromBigInt(BigInt(index)))}`;
}

/**
 * Whether this is a slot number a feed can actually hold.
 *
 * The catalog is JSON pulled off the network and parsed unchecked, so this field is external input
 * however trusted its author. A negative, fractional or non-finite value throws inside `BigInt`, and
 * it would throw from a React effect while a card renders, taking out a preview that works today.
 * Falling back to the search is exactly what the code did before this function existed.
 */
function isAddressableSlot(index: number | undefined): index is number {
  return index !== undefined && Number.isSafeInteger(index) && index >= 0;
}
