/** The gateway is answering. The feed may still be waiting on the publisher, which is ordinary. */
export const FEED_STATE_LIVE = 'live';

/** The gateway is not answering at all, and attempts are being held off between retries. */
export const FEED_STATE_RECONNECTING = 'reconnecting';

/** The gateway is answering, but has not served the slot the player waits on, for a long run. */
export const FEED_STATE_STALLED = 'stalled';

/**
 * The gateway is answering, and serving what it is asked for, more slowly than the player consumes
 * it. Nothing has failed and the picture keeps stopping anyway.
 */
export const FEED_STATE_DEGRADED = 'degraded';

/**
 * The broadcaster ended the stream. The only terminal state here: the other three describe something
 * still being retried, and this one describes there being nothing left to retry.
 */
export const FEED_STATE_ENDED = 'ended';

export type FeedState =
  | typeof FEED_STATE_LIVE
  | typeof FEED_STATE_RECONNECTING
  | typeof FEED_STATE_STALLED
  | typeof FEED_STATE_DEGRADED
  | typeof FEED_STATE_ENDED;

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
 * How many consecutive polls may sit on an unserved slot before the feed is called stalled.
 *
 * Counted in polls rather than in seconds, because the poll is what observes the slot. Low enough to
 * reach a viewer while they are still watching, high enough that a viewer who has merely caught up
 * with the publisher stays quiet, since that viewer is refused on nearly every poll.
 *
 * ⚠️ **What this is worth in seconds is not what this comment used to claim.** It said hls.js
 * reloads "about once per target duration, which is 2 seconds here, so this is roughly a minute".
 * The uploader declares `ceil(segment duration)`, so the target is **1 second** at every segment
 * length below a second, which `playerConfig.ts` states correctly and this did not. At the shipping
 * profile thirty polls is therefore on the order of thirty seconds rather than sixty, and the
 * measured live slot-read rate suggests faster still.
 *
 * ⚠️ **The run happened, and it says the unit is the problem rather than the number.** Two recorded
 * uploader crashes, task #100 and `docs/bench/overlay-silence-during-a-crash-2026-08-07.md`. The
 * poll rate is not a constant and does not vary randomly: it collapses during exactly the stall this
 * counts. Feed reads went from a 264ms gap before the crash to **1064ms during the freeze**, because
 * each read takes about three times as long and the client also spaces unserved reads about four
 * times wider. So thirty polls is about **8 seconds while healthy and about 32 during a stall**, and
 * the delay before a viewer is told anything is a by-product rather than a decision.
 *
 * What that costs, measured: a 12.4 second freeze accumulated 13 polls and never reached this
 * threshold, so the viewer watched a dead picture for twelve seconds and was told nothing, while a
 * 54.9 second freeze in the same scenario was announced 14.4 seconds in.
 *
 * The number is still left where it is, and now for a different reason. It was chosen against how
 * long a viewer will sit through a frozen picture, which is a fact about viewers, and the fix
 * indicated is to denominate this in elapsed milliseconds on the unserved slot rather than to move
 * the count. That changes when the overlay appears on every deployment, so it is a product decision
 * and not a correction.
 */
export const UNSERVED_SLOT_POLL_LIMIT = 30;

/**
 * How many times the picture may stop inside {@link PLAYBACK_STALL_WINDOW_MS} before the stream is
 * called degraded.
 *
 * Counted from the viewer's own symptom rather than from a transfer time, which is what makes one
 * pair of numbers work across every profile. A read slow enough to matter is one the buffer stops
 * absorbing, and how slow that is depends on the segment length, the bitrate and the deployment. How
 * often the picture stops does not.
 *
 * ⭐ **Both numbers are measured rather than chosen**, by replaying every archived browser run's
 * rebuffer counter through candidate rules. Within a rolling twenty seconds and after the first
 * frame, the fourteen-minute collapse of `docs/bench/the-fourteen-minute-collapse-2026-08-07.md`
 * reaches 4 stalls, the one other run with viewer-visible degradation reaches 4, and the worst run a
 * viewer would call healthy reaches 1, including four separate clean hours. The next rule down, 3
 * stalls in fifteen seconds, fires 2786 seconds into one of those hours.
 *
 * On the collapse this is reached 9 seconds after the picture first stopped, against the six minutes
 * of silence that run actually shipped.
 */
export const PLAYBACK_STALL_BURST = 4;

/** The span the burst is counted over. See {@link PLAYBACK_STALL_BURST} for where the pair comes from. */
export const PLAYBACK_STALL_WINDOW_MS = 20_000;

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
  /** Whether the broadcaster published a manifest that ends the playlist. Never goes back to false. */
  hasEnded: boolean;
  /** When the picture last stopped, most recent last, trimmed by {@link recentStalls}. */
  stallsAtMs: readonly number[];
}

const HEALTHY: TopicHealth = {
  gatewayFailures: 0,
  retryAtMs: 0,
  unservedSlotPolls: 0,
  hasEnded: false,
  stallsAtMs: [],
};

/** How long to hold off after `failures` consecutive failures, doubling and then flat at the cap. */
export function backoffDelayMs(failures: number): number {
  return Math.min(MANIFEST_RETRY_CAP_MS, MANIFEST_RETRY_BASE_MS * 2 ** (failures - 1));
}

/**
 * The stalls still inside the window, and never more of them than it takes to reach the burst.
 *
 * Both halves matter. The window is what makes this a burst rather than a lifetime total, so that a
 * stream which stalls four times in an hour is not described as struggling for the rest of the
 * session. The cap is what stops a stream that never recovers from accumulating a timestamp per
 * stall for as long as the tab is open, and it costs nothing: if more than a burst's worth sit in
 * the window, the most recent burst's worth are all in it too.
 */
function recentStalls(stallsAtMs: readonly number[], nowMs: number): readonly number[] {
  const inWindow = stallsAtMs.filter((at) => nowMs - at < PLAYBACK_STALL_WINDOW_MS);
  return inWindow.slice(-PLAYBACK_STALL_BURST);
}

/**
 * Whether an entry still says anything. Not the same question as whether the topic looks unwell: a
 * run of unserved slots reads as live until it is long enough to mean something, and dropping it
 * before then is dropping the count that decides when that is.
 */
function isWorthTracking(health: TopicHealth): boolean {
  return health.gatewayFailures > 0 || health.unservedSlotPolls > 0 || health.hasEnded || health.stallsAtMs.length > 0;
}

function stateOfHealth(health: TopicHealth | undefined, nowMs: number): FeedState {
  if (!health) {
    return FEED_STATE_LIVE;
  }
  // First, and deliberately. A gateway going down after the broadcast finished does not make the
  // broadcast unfinished, and a feed that stops advancing because it ended is not stalled.
  if (health.hasEnded) {
    return FEED_STATE_ENDED;
  }
  if (health.gatewayFailures > 0) {
    return FEED_STATE_RECONNECTING;
  }
  if (health.unservedSlotPolls >= UNSERVED_SLOT_POLL_LIMIT) {
    return FEED_STATE_STALLED;
  }
  // Last of the four, because it is the least specific. Each of the others names why the picture
  // stopped, and this one only names that it did, so a viewer whose gateway has gone away entirely
  // would be told the smaller half of the truth.
  if (recentStalls(health.stallsAtMs, nowMs).length >= PLAYBACK_STALL_BURST) {
    return FEED_STATE_DEGRADED;
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
   * What subscribers were last told, for topics not currently live.
   *
   * The comparison that decides whether to publish cannot be made by reading the state twice around
   * a change, because one of the four states is a function of the clock as well as of the entry: a
   * burst of stalls that ages out changes the state with nothing recorded. Read that way the state
   * before the change is already the state after it, so the one transition nothing else can announce
   * is the one that gets swallowed, and the overlay stays up until the next real fault.
   *
   * Holds only topics in a non-live state, so it is bounded by the same limit the entries are.
   */
  private readonly lastPublished = new Map<string, FeedState>();

  /**
   * @param now A monotonic clock. `Date.now` is not one: a system clock correction during an outage
   *   moves every deadline already scheduled against it, either releasing the backoff at once or
   *   holding it for as long as the correction was large.
   */
  constructor(private readonly now: () => number = () => performance.now()) {}

  state(topicId: string): FeedState {
    return stateOfHealth(this.topics.get(topicId), this.now());
  }

  /**
   * How many stalls are held against a topic right now.
   *
   * Read by tests only, and there because the bound on {@link recentStalls} is otherwise invisible:
   * a stream that stalls without pause reports the same state whether four timestamps are kept or
   * four hundred thousand.
   */
  stallsRecorded(topicId: string): number {
    return this.topics.get(topicId)?.stallsAtMs.length ?? 0;
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
        ...health,
        gatewayFailures,
        retryAtMs: this.now() + backoffDelayMs(gatewayFailures),
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
   *
   * ⭐ **Every topic held off stops waiting, whichever one was proven.** One gateway serves every
   * feed this tracker holds, so a read getting through is the same evidence a segment arriving is.
   * A viewer on the four rung ladder holds five entries, each backing off on its own count, and
   * leaving four of them asleep while the fifth is demonstrably being served is four rungs of
   * nothing to switch to. Measured 2026-08-29: three unrelated faults under a watching ladder viewer
   * each froze the picture for 58.5 to 59.0 seconds, an eight second writer-bee pause included.
   *
   * What the other topics do **not** get is their failure counts back, because a named read proves
   * two different things about two different sets. That the gateway answers is proven for everyone.
   * That *this* feed reads cleanly is proven only where it was read. So the count stands: the
   * overlay keeps saying reconnecting rather than flickering once per sibling poll, a rung that
   * fails again returns to the wait it had earned rather than to the base, and the walk loop's own
   * poll interval is left as the floor on how often a rung with a fault of its own can ask.
   *
   * @param topicId The feed whose own read proved it, or omitted when the proof was not a feed read
   *   at all. A segment is fetched by chunk address rather than against any feed, so there is no
   *   topic to credit and every held one is forgiven outright.
   */
  recordGatewayReachable(topicId?: string): void {
    // Snapshotted because writing to a topic rewrites the entry being walked: `update` deletes
    // before it writes, so that eviction takes the least recently updated rather than the oldest.
    for (const held of [...this.topics.keys()]) {
      if (held === topicId) {
        continue;
      }
      if (topicId === undefined) {
        this.forgetFailures(held);
      } else {
        this.endHold(held);
      }
    }

    if (topicId !== undefined) {
      this.forgetFailures(topicId);
    }
  }

  /** Back to healthy as far as reaching the gateway goes: nothing counted against it, nothing owed. */
  private forgetFailures(topicId: string): void {
    this.update(topicId, (health) => ({ ...health, gatewayFailures: 0, retryAtMs: 0 }));
  }

  /**
   * Free to attempt now, with everything it has already failed still counted against it.
   *
   * Guarded rather than written unconditionally, because this runs for every held topic on every
   * successful read. An unguarded write would rewrite an entry that did not change, which moves it
   * to the end of the eviction order and makes the least recently *updated* topic no longer the one
   * furthest from being watched.
   */
  private endHold(topicId: string): void {
    if ((this.topics.get(topicId)?.retryAtMs ?? 0) === 0) {
      return;
    }
    this.update(topicId, (health) => ({ ...health, retryAtMs: 0 }));
  }

  /**
   * A slot was served. Forgets both runs, since serving one ends either.
   *
   * An ended broadcast is kept rather than forgotten. Forgetting it would read as `live` again, and
   * the last thing a finished stream does is serve the manifest that finished it.
   *
   * ⭐ A run of playback stalls is kept for the opposite reason: serving a slot does not disprove it.
   * Through the whole of the fourteen-minute collapse the gateway kept serving, 384 slots against 34
   * empty ones after the onset, while the picture stopped every couple of seconds. Clearing the
   * stalls here would make the state that run exists to add unreachable on the run itself.
   */
  recordGatewayResponse(topicId: string): void {
    this.update(topicId, (health) => ({ ...HEALTHY, hasEnded: health.hasEnded, stallsAtMs: health.stallsAtMs }));
  }

  /** The picture stopped, after having started. See {@link PLAYBACK_STALL_BURST}. */
  recordPlaybackStall(topicId: string): void {
    const stalledAtMs = this.now();
    this.update(topicId, (health) => ({
      ...health,
      stallsAtMs: recentStalls([...health.stallsAtMs, stalledAtMs], stalledAtMs),
    }));
  }

  /** The broadcaster published a manifest that ends the playlist. Terminal, and not a fault. */
  recordFeedEnded(topicId: string): void {
    this.update(topicId, (health) => ({ ...health, hasEnded: true }));
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
      return { ...health, gatewayFailures: 0, retryAtMs: 0, unservedSlotPolls: polls };
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
    const changed = change(this.topics.get(topicId) ?? HEALTHY);
    // Aged out here as well as when a stall is recorded, so that the entry stops being worth
    // tracking on the first poll after its window empties. Nothing schedules a re-read, and nothing
    // needs to: the fetcher records against this on every poll, so a topic whose only remaining
    // reason to be held is a burst that has expired is dropped within a poll of expiring.
    const next = changed === null ? null : { ...changed, stallsAtMs: recentStalls(changed.stallsAtMs, this.now()) };

    // Deleted before every write as well as instead of one, so that a re-insert moves the topic to
    // the end of the map and eviction below takes the least recently updated rather than the oldest.
    this.topics.delete(topicId);
    if (next !== null && isWorthTracking(next)) {
      this.topics.set(topicId, next);
      this.evictOverflow();
    }

    this.publish(topicId, this.state(topicId));
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

  /** Says a state once. A subscriber hearing the same thing twice reads as a second fault. */
  private publish(topicId: string, state: FeedState): void {
    if ((this.lastPublished.get(topicId) ?? FEED_STATE_LIVE) === state) {
      return;
    }
    if (state === FEED_STATE_LIVE) {
      this.lastPublished.delete(topicId);
    } else {
      this.lastPublished.set(topicId, state);
    }

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
