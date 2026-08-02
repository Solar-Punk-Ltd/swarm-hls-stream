/** The gateway is answering. The feed may still be waiting on the publisher, which is ordinary. */
export const FEED_STATE_LIVE = 'live';

/** The gateway is not answering at all, and attempts are being held off between retries. */
export const FEED_STATE_RECONNECTING = 'reconnecting';

/** The gateway is answering, but has not served the slot the player waits on, for a long run. */
export const FEED_STATE_STALLED = 'stalled';

export type FeedState = typeof FEED_STATE_LIVE | typeof FEED_STATE_RECONNECTING | typeof FEED_STATE_STALLED;

export type FeedStateListener = (state: FeedState) => void;

/**
 * How long to wait before asking a failing gateway again, after its first failure. Doubles per
 * consecutive failure up to {@link MANIFEST_RETRY_CAP_MS}.
 *
 * One target duration, so a single flake costs at most one poll cycle rather than a visible pause.
 * The deadline is stamped when the request failed, not when it was issued, so a request that spent
 * time before failing pushes the next poll that much further inside the window. Only a run of
 * failures actually slows the polling down.
 */
export const MANIFEST_RETRY_BASE_MS = 2_000;

/**
 * The longest gap between attempts on a failing gateway. A viewer whose gateway comes back has to
 * find out within a length of time they would sit through, and thirty seconds is that. It also
 * bounds the load a page full of stalled players puts on a gateway that is already struggling.
 */
export const MANIFEST_RETRY_CAP_MS = 30_000;

/**
 * How many consecutive polls may sit on an unserved slot before the feed is called stalled. hls.js
 * reloads a live playlist about once per target duration, which is 2 seconds here, so this is
 * roughly a minute of a feed that is not advancing. Low enough to reach a viewer while they are
 * still watching, high enough that a viewer who has merely caught up with the publisher stays quiet.
 */
export const UNSERVED_SLOT_POLL_LIMIT = 30;

/**
 * How many topics may be tracked at once.
 *
 * Only topics in trouble are held, and a topic is dropped the moment its gateway answers, so this
 * is a backstop rather than a working limit: what accumulates otherwise is topics a viewer left
 * while they were failing, which nothing would ever come back to clear. Evicts the least recently
 * updated, which is the one furthest from being watched.
 */
export const TRACKED_TOPIC_LIMIT = 32;

interface TopicHealth {
  /** Consecutive failures to reach the gateway at all. */
  gatewayFailures: number;
  /** The clock reading before which no further attempt should be made. */
  retryAtMs: number;
  /** Consecutive polls spent on a slot the gateway answered for, but had nothing in. */
  unservedSlotPolls: number;
}

const HEALTHY: TopicHealth = { gatewayFailures: 0, retryAtMs: 0, unservedSlotPolls: 0 };

/** How long to hold off after `failures` consecutive failures, doubling and then flat at the cap. */
export function backoffDelayMs(failures: number): number {
  return Math.min(MANIFEST_RETRY_CAP_MS, MANIFEST_RETRY_BASE_MS * 2 ** (failures - 1));
}

/**
 * Whether an entry still says anything. Not the same question as whether the topic looks unwell: a
 * run of unserved slots reads as live until it is long enough to mean something, and dropping it
 * before then is dropping the count that decides when that is.
 */
function isWorthTracking(health: TopicHealth): boolean {
  return health.gatewayFailures > 0 || health.unservedSlotPolls > 0;
}

function stateOfHealth(health: TopicHealth | undefined): FeedState {
  if (!health) {
    return FEED_STATE_LIVE;
  }
  if (health.gatewayFailures > 0) {
    return FEED_STATE_RECONNECTING;
  }
  if (health.unservedSlotPolls >= UNSERVED_SLOT_POLL_LIMIT) {
    return FEED_STATE_STALLED;
  }
  return FEED_STATE_LIVE;
}

/**
 * Whether each topic's gateway is answering, and how long to leave a failing one alone.
 *
 * Separate from the fetcher and from the manifest state because it has to outlive both. The player
 * tears its topic down and rebuilds it on every restart, and a fatal network error is what triggers
 * a restart, so the outage that this describes is also what destroys anything scoped to a mount.
 * Held here, the signal survives the restart it caused, and a viewer sees one continuous message
 * instead of the overlay flickering off and on.
 *
 * The two counters are opposite cases wearing similar shapes and are deliberately not merged: an
 * unserved slot means the publisher is behind the viewer and must be polled at full cadence, a
 * failure means the gateway is not answering and must not be.
 */
export class FeedHealthTracker {
  private readonly topics = new Map<string, TopicHealth>();
  private readonly listeners = new Map<string, Set<FeedStateListener>>();

  /**
   * @param now A monotonic clock. `Date.now` is not one: a system clock correction during an outage
   *   moves every deadline already scheduled against it, either releasing the backoff at once or
   *   holding it for as long as the correction was large.
   */
  constructor(private readonly now: () => number = () => performance.now()) {}

  state(topicId: string): FeedState {
    return stateOfHealth(this.topics.get(topicId));
  }

  /**
   * Watch one topic. The current state arrives immediately, before this returns.
   *
   * Replaying is the point rather than a convenience. A subscriber arrives after a mount, and a
   * player mounting into an outage that is already under way is the common case, not the rare one:
   * it is what a restart is.
   */
  subscribe(topicId: string, listener: FeedStateListener): () => void {
    const forTopic = this.listeners.get(topicId) ?? new Set<FeedStateListener>();
    forTopic.add(listener);
    this.listeners.set(topicId, forTopic);
    this.notify(listener, this.state(topicId));

    return () => {
      forTopic.delete(listener);
      if (forTopic.size === 0) {
        this.listeners.delete(topicId);
      }
    };
  }

  /** How much of this topic's backoff is left to wait out. Zero when there is nothing to wait for. */
  backoffRemainingMs(topicId: string): number {
    const health = this.topics.get(topicId);
    if (!health) {
      return 0;
    }
    return Math.max(0, health.retryAtMs - this.now());
  }

  /**
   * A gateway that answered with a failure, or did not answer. Counted apart from an unserved slot:
   * this one gets asked less often, because asking a gateway that is down every two seconds for as
   * long as the tab is open helps nobody and adds load to something already struggling.
   */
  recordGatewayFailure(topicId: string): void {
    this.update(topicId, (health) => {
      const gatewayFailures = health.gatewayFailures + 1;
      return {
        gatewayFailures,
        retryAtMs: this.now() + backoffDelayMs(gatewayFailures),
        unservedSlotPolls: health.unservedSlotPolls,
      };
    });
  }

  /**
   * The gateway is reachable, whether or not it had the thing that was asked for.
   *
   * Deliberately narrower than {@link recordGatewayResponse}, and the distinction is the whole of
   * why both exist. Reaching the gateway says nothing about whether the feed is advancing: the feed
   * endpoint answers with the publisher's last update, so it answers identically for a broadcast in
   * progress and one that stopped an hour ago. Anything that clears the unserved run on the strength
   * of reaching the gateway erases a stall the player has already reported, and the path that would
   * do it is the one every restart takes.
   */
  recordGatewayReachable(topicId: string): void {
    this.update(topicId, (health) => ({ ...health, gatewayFailures: 0, retryAtMs: 0 }));
  }

  /** A slot was served. Forgets both runs, since serving one ends either. */
  recordGatewayResponse(topicId: string): void {
    this.update(topicId, () => null);
  }

  /**
   * The gateway answered, for a slot it had nothing in. The ordinary case for a viewer who has
   * caught up with the publisher, and the reason this does not set a backoff.
   *
   * It does clear one. An answer is an answer whatever it carries, so this ends a run of failures
   * exactly as {@link recordGatewayReachable} does. Carrying the failure count through instead left
   * a single earlier flake pinning the topic to `reconnecting` for as long as the publisher stayed
   * quiet, which is precisely when `stalled` is the thing worth saying.
   *
   * @returns The length of the run this poll extends.
   */
  recordUnservedSlot(topicId: string): number {
    let polls = 0;
    this.update(topicId, (health) => {
      polls = health.unservedSlotPolls + 1;
      return { gatewayFailures: 0, retryAtMs: 0, unservedSlotPolls: polls };
    });
    return polls;
  }

  /** Forget a topic, or all of them. */
  clear(topicId?: string): void {
    if (topicId === undefined) {
      const forgotten = [...this.topics.keys()];
      this.topics.clear();
      this.publishAll(forgotten);
      return;
    }
    this.update(topicId, () => null);
  }

  private update(topicId: string, change: (health: TopicHealth) => TopicHealth | null): void {
    const before = this.state(topicId);
    const next = change(this.topics.get(topicId) ?? HEALTHY);

    // Deleted before every write as well as instead of one, so that a re-insert moves the topic to
    // the end of the map and eviction below takes the least recently updated rather than the oldest.
    this.topics.delete(topicId);
    if (next !== null && isWorthTracking(next)) {
      this.topics.set(topicId, next);
      this.evictOverflow();
    }

    const after = this.state(topicId);
    if (after !== before) {
      this.publish(topicId, after);
    }
  }

  private evictOverflow(): void {
    const evicted: string[] = [];
    while (this.topics.size > TRACKED_TOPIC_LIMIT) {
      const oldest = this.topics.keys().next();
      if (oldest.done) {
        break;
      }
      this.topics.delete(oldest.value);
      evicted.push(oldest.value);
    }
    this.publishAll(evicted);
  }

  /**
   * Say that these topics are back to live, because forgetting one is a state change like any other.
   *
   * Published after the map has finished changing rather than inside the loop, so that a listener
   * which records against this tracker cannot resize the map halfway through a scan of it.
   */
  private publishAll(topicIds: string[]): void {
    for (const topicId of topicIds) {
      this.publish(topicId, FEED_STATE_LIVE);
    }
  }

  private publish(topicId: string, state: FeedState): void {
    for (const listener of this.listeners.get(topicId) ?? []) {
      this.notify(listener, state);
    }
  }

  /**
   * One listener's throw is its own. Without this the throw travels back up the promise chain that
   * reported the gateway answering, is caught by the handler for the gateway not answering, and is
   * recorded as the failure it is the opposite of.
   */
  private notify(listener: FeedStateListener, state: FeedState): void {
    try {
      listener(state);
    } catch (error) {
      console.error('Feed state listener threw:', error);
    }
  }
}
