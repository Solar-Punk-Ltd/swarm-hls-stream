import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { nextFeedRequest, resolvedFeedIndex } from '@swarm-hls-stream/shared';

import { fetchWithTimeout, TimedResponse } from './fetchWithTimeout';

/**
 * How far a single read will walk forward before giving up and finishing on the next one.
 *
 * A bound rather than a limit anyone should hit. It exists because a follower that advances one slot
 * per poll has a catch-up rate equal to its poll rate, so a reader that falls behind never recovers.
 * Walking while the slots keep answering fixes that, and this caps what one poll can spend doing it.
 *
 * Thirty two is far more than a five second poll can fall behind on a catalog that gains a slot per
 * broadcast, and small enough that a pathological feed cannot hold the page for a minute.
 */
const MAX_WALK_PER_READ = 32;

/**
 * A slot the publisher has not written yet, which is the ordinary answer on a catalog that is idle.
 *
 * Named for the same reason `ManifestFetcher` names it: it is the one status that means "there is
 * nothing more", and every other status means the gateway could not answer. Reading them as the same
 * thing is what let a broken gateway render as an empty catalog.
 */
const SLOT_NOT_WRITTEN_YET = 404;

/** A response that arrived and was refused, as opposed to a transport failure or a timeout. */
export class CatalogFetchError extends Error {
  constructor(url: string, readonly status: number) {
    super(`Catalog feed request to ${url} was refused with ${status}`);
    this.name = 'CatalogFetchError';
  }
}

/**
 * Follows the app catalog feed by walking slots rather than resolving its head on every poll.
 *
 * The catalog is polled every five seconds forever and gains a slot per broadcast lifecycle event,
 * and it is never reset. Resolving the head each time costs a lookup that gets slower as the feed
 * grows: measured on this deployment at about 1s on a one slot feed, 4s at twenty, and 5s at a
 * thousand, against **4ms** for a slot read by explicit address. Past a few hundred events the poll
 * no longer fits inside its own interval and the catalog is never not in flight.
 *
 * So the head is resolved **once**, on the first read, and every read after that asks for the slot
 * after the one it holds. That is the same thing the player does, through the same shared helper, and
 * routing both through `nextFeedRequest` is deliberate: the last time this rule existed twice the two
 * copies diverged.
 *
 * **A miss is cheap, which is what makes this work for a mostly idle feed.** A walking reader asks
 * for a slot that does not exist yet on almost every poll, since broadcasts are rare. Measured
 * 2026-08-05: that 404 costs 4ms at the median, indistinguishable from a hit. It has a real tail,
 * about one in twenty taking 1.4s, which is invisible at a five second cadence and is the reason
 * `MAX_WALK_PER_READ` exists rather than an unbounded walk. See `docs/bench/feed-miss-cost.md`.
 */
export class CatalogFeedReader {
  private index: FeedIndex | null = null;

  constructor(
    private readonly owner: string,
    private readonly topic: Topic,
    private readonly fetcher: typeof fetchWithTimeout = fetchWithTimeout,
  ) {}

  /** The slot this reader has read, or null before its first successful read. Diagnostics and tests. */
  public getIndex(): FeedIndex | null {
    return this.index;
  }

  /**
   * Forgets the position, so the next read resolves the head again.
   *
   * Needed because the gateway can change under this reader. A different node has its own view of the
   * feed, and walking from an index established against the old one would ask for slots that node may
   * not have, which reads as a catalog that has stopped rather than one being followed from the wrong
   * place.
   */
  public reset(): void {
    this.index = null;
  }

  /**
   * The newest catalog body, or null when there is nothing newer than the last read.
   *
   * Null rather than a repeat of the previous body, so a caller can skip re-rendering an unchanged
   * list. Both existing callers already ignore a non-array, so null is inert for them.
   */
  public async read(gatewayUrl: string, signal?: AbortSignal): Promise<string | null> {
    if (this.index === null) {
      return this.readHead(gatewayUrl, signal);
    }

    // A local cursor rather than reading `this.index` each turn. Assigning the field from a request
    // whose own type is derived from that field is circular, and TypeScript widens it to `any` rather
    // than refusing, so the overload that guarantees a slot request would have been silently lost.
    let cursor: FeedIndex = this.index;
    let newest: string | null = null;

    for (let step = 0; step < MAX_WALK_PER_READ; step++) {
      const request = nextFeedRequest(this.owner, this.topic, cursor);

      let response: TimedResponse;
      try {
        response = await this.fetcher(`${gatewayUrl}/${request.path}`, { signal });
      } catch (error) {
        // A throw is not the same shape as a refusal and must not lose what the walk already read.
        // `this.index` is committed per slot, inside this loop, while the body is only handed back
        // after it, so letting the rejection out drops a snapshot this walk successfully fetched
        // *and* keeps the index that consumed it. The next poll then asks for the slot after the one
        // it threw away, and since each slot carries the whole catalog rather than a delta, a
        // broadcast announced only in that slot is never offered to this reader again.
        //
        // Reached by a gateway going slow rather than answering: `fetchWithTimeout` rejects on a
        // transport failure and on its own timeout, and returns `ok: false` only for an HTTP status.
        // A hit and the miss that ends the walk are different requests, and a miss has a measured
        // tail of about 1.4s at the 95th percentile, so "one slot answered, the next one hung" is
        // the ordinary shape of this rather than an exotic one. See `docs/bench/feed-miss-cost.md`.
        //
        // Rethrown only when there is nothing to salvage, so a walk that failed on its first step
        // still reaches the caller as the error it is instead of reading as an idle catalog.
        if (newest === null) {
          throw error;
        }
        return newest;
      }

      if (response.status === SLOT_NOT_WRITTEN_YET) {
        // The expected case on an idle catalog, and the cheap one. The walk stops rather than
        // retrying here, since the poll comes round again.
        break;
      }
      if (!response.ok) {
        // Every other status is the gateway failing, and is raised for the same reason a throw is:
        // the browse page decides between "Could not reach this gateway" and "No streams here yet"
        // by whether this rejected, so a refusal that returned quietly always chose the second.
        // Salvaged first, on the same rule the throw path uses, since each slot carries the whole
        // catalog and a body already fetched is not worth discarding for a later step's failure.
        if (newest !== null) {
          return newest;
        }
        throw new CatalogFetchError(`${gatewayUrl}/${request.path}`, response.status);
      }
      cursor = request.index;
      this.index = cursor;
      newest = response.text;
    }
    return newest;
  }

  /**
   * The one slow read, paid once per reader rather than once per poll.
   *
   * The index comes from the response header rather than from counting, because the gateway is the
   * only thing that knows which slot it resolved to. Without it this reader would have to keep
   * resolving the head, which is the cost being removed.
   */
  private async readHead(gatewayUrl: string, signal?: AbortSignal): Promise<string | null> {
    const request = nextFeedRequest(this.owner, this.topic, null);
    const response = await this.fetcher(`${gatewayUrl}/${request.path}`, { signal });
    // A catalog nobody has broadcast to has no head, which is nothing to show rather than a fault.
    if (response.status === SLOT_NOT_WRITTEN_YET) {
      return null;
    }
    if (!response.ok) {
      throw new CatalogFetchError(`${gatewayUrl}/${request.path}`, response.status);
    }

    const resolved = resolvedFeedIndex(response.headers);
    // A body without a usable index is still the catalog, so it is returned. The position stays null
    // and the next read resolves the head again, which is slow rather than wrong.
    if (resolved !== null) {
      this.index = FeedIndex.fromBigInt(BigInt(resolved));
    }
    return response.text;
  }
}
