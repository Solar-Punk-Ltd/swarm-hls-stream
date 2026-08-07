import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { feedSlotPath, nextFeedRequest } from '@swarm-hls-stream/shared';

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
