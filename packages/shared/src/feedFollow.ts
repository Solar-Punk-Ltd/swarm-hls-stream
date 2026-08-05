/**
 * Which request follows a sequential Swarm feed, so that everything reading one asks the same way.
 *
 * **This exists because two implementations of it drifted and cost the project every latency figure
 * it had.** The player resolves the feed head once, on mount, and then walks explicit slot addresses.
 * The bench resolved the head on every single poll. Measured on 2026-08-04 against a feed advancing
 * one slot per second, `GET /feeds/{owner}/{topic}` was 50 to 57% frozen with responses of 1.0 to 7.0
 * seconds, while explicit-address reads of the same chunks on the same node were 0.2% frozen at 46ms.
 * So the two ways of following a feed are not interchangeable, the bench was on the slow one, and
 * every "frozen share" this project published described the instrument. See
 * `docs/bench/feed-reader-ab.md`.
 *
 * The paths are relative, because the player and the bench each hold their own gateway base URL.
 */

import { FeedIndex, Identifier, Topic } from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';

/**
 * The chunk identifier of one feed slot.
 *
 * Reimplemented rather than imported: bee-js has exactly this function in `feed/identifier`, but its
 * export map exposes only the package root and the root does not re-export it.
 */
export function makeFeedIdentifier(topic: Topic, index: FeedIndex): Identifier {
  return new Identifier(Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), index.toUint8Array())));
}

/** Resolves whichever update is newest, at the cost of a lookup that cannot keep up with a live feed. */
export interface FeedHeadRequest {
  readonly kind: 'head';
  readonly path: string;
}

/** Names one update by address, which is where a follower stays once it knows where it is. */
export interface FeedSlotRequest {
  readonly kind: 'slot';
  readonly path: string;
  readonly index: FeedIndex;
}

export type FeedRequest = FeedHeadRequest | FeedSlotRequest;

/**
 * What to ask the gateway for next, given the newest slot this follower has already read.
 *
 * A null index means nothing is known yet, which is a fresh mount or a restart, and is the only case
 * that costs a head lookup. Overloaded so that a caller holding an index gets that guarantee from the
 * type rather than from reading this.
 */
export function nextFeedRequest(owner: string, topic: Topic, knownIndex: null): FeedHeadRequest;
export function nextFeedRequest(owner: string, topic: Topic, knownIndex: FeedIndex): FeedSlotRequest;
export function nextFeedRequest(owner: string, topic: Topic, knownIndex: FeedIndex | null): FeedRequest;
export function nextFeedRequest(owner: string, topic: Topic, knownIndex: FeedIndex | null): FeedRequest {
  if (knownIndex === null) {
    return { kind: 'head', path: `feeds/${owner}/${topic.toString()}` };
  }
  const index = knownIndex.next();
  return { kind: 'slot', path: `soc/${owner}/${makeFeedIdentifier(topic, index).toString()}`, index };
}

/**
 * The feed slot a gateway says it resolved a read to, from the response headers.
 *
 * **The header is hexadecimal and zero-padded**, which is worth stating because every index under
 * sixteen reads as a plausible decimal and the two only diverge later: `0000000000000022` is 34.
 *
 * Null rather than an error when the header is absent or unreadable, because every caller has
 * something better to do than fail. A follower that cannot read it falls back to a head lookup, which
 * is slow rather than wrong.
 *
 * Lives here rather than beside either caller because both the client and the bench need it and they
 * need it to agree. The last time a feed-reading rule existed twice, the two copies diverged and the
 * instrument was reported as the product for weeks. See `nextFeedRequest` above.
 */
export function resolvedFeedIndex(headers: Headers): number | null {
  const raw = headers.get('swarm-feed-index');
  if (raw === null || !/^[0-9a-fA-F]+$/.test(raw.trim())) {
    return null;
  }
  return Number.parseInt(raw.trim(), 16);
}
