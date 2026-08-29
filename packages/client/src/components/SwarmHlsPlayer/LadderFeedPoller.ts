import { Topic } from '@ethersphere/bee-js';
import { extractFeedIndex, nextFeedRequest } from '@swarm-hls-stream/shared';

import { TimedResponse } from '@/utils/fetchWithTimeout';

import { FeedHealthTracker } from './feedState';
import { isSlotNotWrittenYet, ManifestStateManager } from './ManifestManagement';
import { parseManifest } from './playlist';

/**
 * Keeps every rung of a ladder at the live edge, whether or not it is the one playing.
 *
 * A Swarm feed is walked one SOC at a time: to reach index N you have to ask for N-1 first. While
 * hls.js drives that walk, it only ever advances the level it is currently playing — it does not
 * poll the playlists of levels it is not using. A rung switched away from therefore stops
 * advancing, and coming back to it two minutes later leaves it eighty indices behind, catching up
 * at one index per playlist refresh. That is minutes to reach live, which is not a switch.
 *
 * So the walk is inverted: this owns it for all four rungs at once, on its own clock, and the
 * loader becomes a read of whatever state is already there. The cost is four small SOC lookups per
 * segment interval instead of one — negligible next to the segments themselves, and it is what
 * makes a switch cost nothing.
 */
const DEFAULT_POLL_INTERVAL_MS = 750;

/**
 * How many indices one pass may consume before yielding.
 *
 * A rung that has fallen behind should catch up as fast as the gateway will serve it, but an
 * unbounded loop over a gateway that answers everything would never yield to the other rungs.
 */
const MAX_CATCH_UP_PER_PASS = 25;

/**
 * Consecutive misses before saying so. A miss is the normal case — it means the next segment has
 * not been published yet — so the first several are silent, and only a run long enough to mean
 * "this feed has stopped, or the gateway is broken" is worth a line in the console.
 */
const MISSES_BEFORE_WARNING = 20;

interface PolledTopic {
  topic: Topic;
  hexTopic: string;
  /** The topic the overlay watches, carried so the last rung to finalize can end it. Null for a walk started without one. */
  group: string | null;
  stopped: boolean;
  /** Whether this rung's playlist carried ENDLIST, as opposed to being stopped by a teardown. */
  finalized: boolean;
  ready: Promise<void>;
  markReady: () => void;
  misses: number;
  /** Set while the rung is waiting out a poll interval, so stopping does not have to wait for it. */
  wake?: () => void;
}

export class LadderFeedPoller {
  private polled = new Map<string, PolledTopic>();

  constructor(
    private readonly stateManager: ManifestStateManager,
    private readonly fetchResource: (path: string) => Promise<TimedResponse>,
    private readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
    /**
     * Shared with the single-rendition path, so a rung read reaching or losing the gateway records
     * against the same tracker the overlay reads. Defaults to a private tracker so a directly built
     * poller still runs, but only a poller wired to the shared one reaches a viewer.
     */
    private readonly feedHealth: FeedHealthTracker = new FeedHealthTracker(),
    /**
     * The jittered backoff this rung's gateway has earned, honoured before each pass. Zero by
     * default, so a directly built poller keeps polling at {@link pollIntervalMs}; the fetcher wires
     * this to the same feed health and jitter the single-rendition path backs off through.
     */
    private readonly backoffMs: (hexTopic: string) => number = () => 0,
  ) {}

  public start(owner: string, topics: Topic[], groupHexTopic: string | null = null): void {
    for (const topic of topics) {
      const hexTopic = topic.toString();
      if (this.polled.has(hexTopic)) {
        continue;
      }

      let markReady = () => {};
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });

      const entry: PolledTopic = {
        topic,
        hexTopic,
        group: groupHexTopic,
        stopped: false,
        finalized: false,
        ready,
        markReady,
        misses: 0,
      };
      this.polled.set(hexTopic, entry);

      void this.walk(owner, entry);
    }
  }

  public stop(topics: Topic[]): void {
    for (const topic of topics) {
      const hexTopic = topic.toString();
      const entry = this.polled.get(hexTopic);
      if (entry) {
        entry.stopped = true;
        // Cut the wait short rather than letting a torn-down player hold a timer, and unblock
        // anything still awaiting a rung that will now never bootstrap.
        entry.wake?.();
        entry.markReady();
        this.polled.delete(hexTopic);
      }
    }
  }

  public isPolling(hexTopic: string): boolean {
    return this.polled.has(hexTopic);
  }

  /** Resolves once this rung has been read at least once, so its playlist is not empty. */
  public ready(hexTopic: string): Promise<void> {
    return this.polled.get(hexTopic)?.ready ?? Promise.resolve();
  }

  private async walk(owner: string, entry: PolledTopic): Promise<void> {
    while (!entry.stopped) {
      // Before the pass, not after it. A gateway recorded as failing has earned a backoff, so a dead
      // gateway is polled at 2s then 4s then 8s up to the cap rather than flat at the poll interval
      // times every rung, which was around 160 requests per 30s against a gateway already down.
      // Nothing here relaxes that: a rung whose siblings are also failing has nothing to release it.
      await this.honourBackoff(entry);
      if (entry.stopped) {
        return;
      }

      let advanced = 0;

      // Nothing thrown in here may end the walk. A rung whose loop dies is not merely stale, it is
      // unrecoverable for the session: it stays in `polled`, so nothing re-starts it, and anything
      // awaiting its `ready()` waits for a promise that will never settle — which for the loader
      // means an hls.js level request that never succeeds and never fails. Reading a truncated
      // body, or a gateway that drops the Swarm-Feed-Index header, is enough to get there.
      try {
        advanced = await this.advance(owner, entry);
      } catch (error) {
        this.recordFailure(entry, error);
      }

      if (entry.stopped) {
        return;
      }

      // Anything consumed this pass means more may already be waiting, so try again straight
      // away; only an empty pass is worth sleeping on.
      if (advanced === 0) {
        await this.pauseFor(entry, this.pollIntervalMs);
      }
    }
  }

  /**
   * The backoff the shared tracker has set for this rung's gateway, waited out interruptibly.
   *
   * ⛔ **Re-read every slice rather than committed once, and that is the fix rather than a detail.**
   * A rung that has reached the cap has scheduled one timer for the whole of it, and nothing but a
   * teardown cancels a scheduled timer. So the rung cannot find out the fault is over: not from its
   * own reads, because it is not making any, and not from the tracker either, however loudly the
   * rungs beside it are being served. Every release path in {@link FeedHealthTracker} was already
   * writing an answer this loop had stopped reading.
   *
   * Measured 2026-08-29, live, on the four rung ladder: three unrelated faults each froze the
   * picture for 58.5 to 59.0 seconds, an **eight second** writer-bee pause included, which is fifty
   * seconds of a client holding off a gateway that had come back.
   *
   * A slice is the poll interval, so no new number is introduced and none is needed: the rung
   * already runs at that cadence when it is healthy, and re-reading a local map that often costs a
   * timer and no request at all. It is also the tightest useful slice, since a hold released between
   * two of a healthy rung's own polls is released sooner than anything could act on it.
   */
  private async honourBackoff(entry: PolledTopic): Promise<void> {
    let owedMs = this.backoffMs(entry.hexTopic);
    while (owedMs > 0 && !entry.stopped) {
      await this.pauseFor(entry, Math.min(owedMs, this.pollIntervalMs));
      owedMs = this.backoffMs(entry.hexTopic);
    }
  }

  /** Sleeps `ms`, or until `stop` wakes the rung, so a torn-down player never holds the timer. */
  private pauseFor(entry: PolledTopic, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.wake = undefined;
        resolve();
      }, ms);

      entry.wake = () => {
        clearTimeout(timer);
        entry.wake = undefined;
        resolve();
      };
    });
  }

  private async advance(owner: string, entry: PolledTopic): Promise<number> {
    if (!this.stateManager.getIndex(entry.hexTopic)) {
      return (await this.bootstrap(owner, entry)) ? 1 : 0;
    }

    let steps = 0;
    while (steps < MAX_CATCH_UP_PER_PASS && !entry.stopped) {
      const current = this.stateManager.getIndex(entry.hexTopic)!;
      // Which request follows is `nextFeedRequest`'s to decide, on the same input, for everything in
      // this repository that reads a feed. See `packages/shared/src/feedFollow.ts`.
      const { path, index: next } = nextFeedRequest(owner, entry.topic, current);

      let response: TimedResponse;
      try {
        response = await this.fetchResource(path);
      } catch (error) {
        this.recordFailure(entry, error);
        break;
      }

      // The gateway answered, whatever it carried, so a run of failures against it is over. Narrower
      // than "a slot was served" on purpose, exactly as the single-rendition path's reachable record
      // is: it clears the backoff without erasing an unserved-slot run the walk is still riding.
      this.feedHealth.recordGatewayReachable(entry.hexTopic);
      entry.misses = 0;
      const text = response.text;

      // Re-checked after every await, not just at the top of the loop. Teardown clears this
      // topic's state synchronously right after stopping the walk, so a response still in flight
      // would otherwise land afterwards and recreate what was cleared — leaving a stale index
      // behind that the next session would resume from instead of bootstrapping to the live edge.
      if (entry.stopped) {
        return steps;
      }

      if (!this.ingest(entry, text)) {
        return steps;
      }

      this.stateManager.setIndex(entry.hexTopic, next);
      steps++;
    }

    return steps;
  }

  /**
   * Jumps straight to the feed's newest index rather than walking up to it.
   *
   * This is the only place a rung is allowed to skip indices: the walk that follows must be
   * contiguous, because a gap in an EVENT playlist is a gap in the timeline hls.js buffers.
   */
  private async bootstrap(owner: string, entry: PolledTopic): Promise<boolean> {
    let response: TimedResponse;
    try {
      response = await this.fetchResource(nextFeedRequest(owner, entry.topic, null).path);
    } catch (error) {
      this.recordFailure(entry, error);
      return false;
    }

    this.feedHealth.recordGatewayReachable(entry.hexTopic);
    entry.misses = 0;
    const text = response.text;
    const index = extractFeedIndex(response.headers);

    if (entry.stopped) {
      return false;
    }

    if (!this.ingest(entry, text)) {
      return false;
    }

    this.stateManager.setIndex(entry.hexTopic, index);
    return true;
  }

  /** Returns false once this rung is finalized and there is nothing further to walk. */
  private ingest(entry: PolledTopic, text: string): boolean {
    const parsed = parseManifest(text);
    const shouldContinue = this.stateManager.updateManifest(
      entry.hexTopic,
      parsed.headers,
      parsed.segments,
      parsed.isFinalized,
    );

    if (this.stateManager.hasSegments(entry.hexTopic)) {
      entry.markReady();
    }

    if (parsed.isFinalized) {
      entry.finalized = true;
      this.recordGroupEndedIfComplete(entry.group);
    }

    if (!shouldContinue) {
      entry.stopped = true;
    }

    return shouldContinue;
  }

  /**
   * The ended overlay listens on the group topic and finalization arrives one rung at a time, so the
   * last rung to finalize is what ends the group. The single-rendition walk records both against the
   * same topic and needs none of this.
   *
   * All rungs rather than any, mirroring the uploader's own rule (a ladder goes to VOD only once
   * every announced rung has finalized): one finalized rung beside live ones is a rung retired, not
   * a broadcast over.
   */
  private recordGroupEndedIfComplete(group: string | null): void {
    if (group === null) {
      return;
    }
    const rungs = [...this.polled.values()].filter((entry) => entry.group === group);
    if (rungs.length > 0 && rungs.every((entry) => entry.finalized)) {
      this.feedHealth.recordFeedEnded(group);
    }
  }

  /**
   * A failed rung read, recorded against the local miss counter and, when it is a real gateway
   * fault, the shared feed health.
   *
   * A 404 is only the next slot not being published yet, the ordinary case for a viewer at the live
   * edge, so it earns no backoff, exactly as the single-rendition walk treats it. Anything else, a
   * transport error or a 5xx, is the gateway not answering: it earns the backoff {@link honourBackoff}
   * waits out and turns the overlay to reconnecting. Recording every 404 as a fault would back off
   * every caught-up viewer on nearly every poll.
   */
  private recordFailure(entry: PolledTopic, error: unknown): void {
    this.recordMiss(entry, error);
    if (!isSlotNotWrittenYet(error)) {
      this.feedHealth.recordGatewayFailure(entry.hexTopic);
    }
  }

  private recordMiss(entry: PolledTopic, error: unknown): void {
    entry.misses++;
    if (entry.misses === MISSES_BEFORE_WARNING) {
      console.warn(
        `Feed ${entry.hexTopic} has not advanced in ${entry.misses} attempts; the stream may have ` +
          `ended or the gateway may be unreachable.`,
        error,
      );
    }
  }
}
