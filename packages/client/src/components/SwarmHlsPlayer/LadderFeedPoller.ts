import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { extractFeedIndex, nextFeedRequest } from '@swarm-hls-stream/shared';

import { TimedResponse } from '@/utils/fetchWithTimeout';

import { FeedReturnWatch } from './feedReturn';
import { FeedHealthTracker } from './feedState';
import { ManifestStateManager } from './ManifestManagement';
import { parseManifest } from './playlist';
import { isSlotNotWrittenYet, probePastRefusal, shouldProbePastRefusal } from './refusedSlot';

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
  /**
   * Whether this rung's playlist carried ENDLIST, as opposed to being stopped by a teardown. False
   * again once its broadcaster is found back, so a sibling finishing late cannot end the group anew.
   */
  finalized: boolean;
  /**
   * Asking for the slot after the playlist that finished this rung, until its broadcaster comes back.
   * Null while the rung is being followed, and again once the watch has had its answer.
   */
  returnWatch: FeedReturnWatch | null;
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
    /**
     * This poller's own cadence, and the clock anything waiting on a rung has to be sized against.
     * Public because {@link ManifestFetcher} bounds its wait for a rung's first playlist in polls
     * rather than in milliseconds, so a deployment that slows this slows that wait with it.
     */
    public readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
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
    /**
     * The wait before each ask a finished rung makes for its broadcaster, called once per ask so every
     * wait is drawn afresh. The fetcher wires it to its own jitter, the way it wires {@link backoffMs}.
     * Left out, each rung's watch draws through its own default, which spreads the same way.
     */
    private readonly returnWatchWaitMs?: () => number,
  ) {}

  public start(owner: string, topics: Topic[], groupHexTopic: string | null = null): void {
    // Before the walks, so a rung that fails on its very first pass already has a group to report
    // it against. The overlay subscribes to the group and to nothing else.
    if (groupHexTopic !== null) {
      this.feedHealth.trackGroup(
        groupHexTopic,
        topics.map((topic) => topic.toString()),
      );
    }

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
        returnWatch: null,
        ready,
        markReady,
        misses: 0,
      };
      this.polled.set(hexTopic, entry);

      void this.walk(owner, entry);
    }
  }

  public stop(topics: Topic[]): void {
    const groups = new Set<string>();

    for (const topic of topics) {
      const hexTopic = topic.toString();
      const entry = this.polled.get(hexTopic);
      if (entry) {
        if (entry.group !== null) {
          groups.add(entry.group);
        }
        entry.stopped = true;
        // Cut the wait short rather than letting a torn-down player hold a timer, and unblock
        // anything still awaiting a rung that will now never bootstrap. A finished rung's watch is
        // the one timer left once its walk has ended, so it goes the same way.
        entry.wake?.();
        entry.returnWatch?.stop();
        entry.returnWatch = null;
        entry.markReady();
        this.polled.delete(hexTopic);
      }
    }

    // Recomputed from what is still walking rather than untracked wholesale. A rung that has
    // stopped records nothing, so leaving it in the membership would read as a healthy rung and
    // hold the overlay down over an outage the remaining rungs are reporting. Untracking the whole
    // group instead is just as wrong: a source torn down and rebuilt starts its new rungs before it
    // stops the old ones, and the group has to keep reporting across that.
    for (const group of groups) {
      const stillWalking = [...this.polled.values()]
        .filter((entry) => entry.group === group)
        .map((entry) => entry.hexTopic);
      if (stillWalking.length === 0) {
        this.feedHealth.untrackGroup(group);
      } else {
        this.feedHealth.trackGroup(group, stillWalking);
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
   * ⛔ **Waited out in slices rather than in one committed timer, and that is the fix rather than a
   * detail.** A rung that has reached the cap used to schedule a single timer for the whole of it,
   * and nothing but a teardown cancels a scheduled timer. So the rung could not find out the fault
   * was over: not from its own reads, because it was making none, and not from the tracker either,
   * however loudly the rungs beside it were being served. Every release path in
   * {@link FeedHealthTracker} was already writing an answer this loop had stopped reading.
   *
   * Measured 2026-08-29, live, on the four rung ladder: three unrelated faults each froze the
   * picture for 58.5 to 59.0 seconds, an **eight second** writer-bee pause included, which is fifty
   * seconds of a client holding off a gateway that had come back.
   *
   * A slice is the poll interval, so no new number is introduced and none is needed: the rung
   * already runs at that cadence when it is healthy, and re-reading a local map that often costs a
   * timer and no request at all. It is also the tightest useful slice, since a hold released between
   * two of a healthy rung's own polls is released sooner than anything could act on it.
   *
   * ⛔ **The wait is drawn once and counted down here, and the tracker is asked something else.**
   * What `backoffMs` returns is not a deadline but a fresh draw: it is wired to `RequestJitter`,
   * which randomises a quarter off the top on every call so that viewers who lost one gateway in the
   * same instant do not all return in the next one. Re-reading it per slice re-rolls that, taking
   * the separation between two viewers from a quarter of the whole backoff down to a quarter of one
   * slice. So each slice asks the unjittered question instead, which is the one that matters here:
   * not how long, but whether the hold still stands.
   */
  private async honourBackoff(entry: PolledTopic): Promise<void> {
    let remainingMs = this.backoffMs(entry.hexTopic);
    while (remainingMs > 0 && !entry.stopped) {
      // Never zero, or a poll interval of zero would stop the countdown converging and hold the
      // rung here for good, where before it merely span.
      const sliceMs = Math.max(1, Math.min(remainingMs, this.pollIntervalMs));
      await this.pauseFor(entry, sliceMs);
      remainingMs -= sliceMs;

      if (this.feedHealth.backoffRemainingMs(entry.hexTopic) === 0) {
        return;
      }
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
        const unservedPolls = this.recordFailure(entry, error);
        if (unservedPolls === null || !shouldProbePastRefusal(unservedPolls)) {
          break;
        }
        if (!(await this.stepPastRefusal(owner, entry, next))) {
          break;
        }
        steps++;
        continue;
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

      if (!this.ingest(owner, entry, text, next)) {
        return steps;
      }

      this.stateManager.setIndex(entry.hexTopic, next);
      // A slot actually arrived, which is the only thing that ends an unserved run. Narrower than
      // the reachable record above and deliberately so: reaching the gateway says nothing about
      // whether any publisher is still writing.
      this.feedHealth.recordGatewayResponse(entry.hexTopic);
      steps++;
    }

    return steps;
  }

  /**
   * Take whatever {@link probePastRefusal} found behind the slot this rung is waiting on.
   *
   * ⛔⛔⛔ **A rung pays for a refusal it believes with the rung, and the single-rendition walk pays
   * for one with a slower poll.** A 404 leaves the rung unserved, and once the ladder has delivered
   * `RUNG_DEATH_LAG_SEGMENTS` segments this rung did not,
   * {@link FeedHealthTracker.rungStoppedWhileOthersAdvance} calls it dead and `attachRungFailover`
   * hands it to `hls.removeLevel`, which has no undo inside the session. So the walk where a refusal
   * costs one poll had been asking what was behind it since 2026-08-06, and the walk where the same
   * refusal costs a rung for the rest of the broadcast took it at face value. An outside reviewer
   * watched 720p leave a ladder that way with all of its media on Swarm.
   *
   * @returns Whether the rung stepped forward, which is also whether this pass may ask for another
   *   slot.
   */
  private async stepPastRefusal(owner: string, entry: PolledTopic, missing: FeedIndex): Promise<boolean> {
    const found = await probePastRefusal(this.fetchResource, owner, entry.topic, missing);
    if (found.kind === 'gatewayFailed') {
      this.recordFailure(entry, found.error);
      return false;
    }
    if (found.kind === 'nothing') {
      return false;
    }

    // The same three records a served slot earns on the ordinary path above, in the same order and
    // for the same reasons. `recordGatewayResponse` is the one that matters most here: it is what
    // ends the unserved run and resets this rung's reading of how far the ladder has got, so a rung
    // that was one request away from its media is not condemned for the gap it just stepped over.
    this.feedHealth.recordGatewayReachable(entry.hexTopic);
    entry.misses = 0;

    if (entry.stopped || !this.ingest(owner, entry, found.response.text, found.index)) {
      return false;
    }

    this.stateManager.setIndex(entry.hexTopic, found.index);
    this.feedHealth.recordGatewayResponse(entry.hexTopic);
    return true;
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

    if (!this.ingest(owner, entry, text, index)) {
      return false;
    }

    this.stateManager.setIndex(entry.hexTopic, index);
    // This session's first read found the rung open, so an end still recorded against it or its group
    // was left by an earlier session and is over. Forgotten without announcing a return. See
    // `FeedHealthTracker.forgetStaleEnd`.
    this.feedHealth.forgetStaleEnd(entry.hexTopic);
    if (entry.group !== null) {
      this.feedHealth.forgetStaleEnd(entry.group);
    }
    return true;
  }

  /**
   * Returns false once this rung is finalized and there is nothing further to walk.
   *
   * @param index The slot `text` was read from, which is where a finished rung's watch starts.
   */
  private ingest(owner: string, entry: PolledTopic, text: string, index: FeedIndex): boolean {
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
      this.watchForReturn(owner, entry, index);
    }

    if (!shouldContinue) {
      entry.stopped = true;
    }

    return shouldContinue;
  }

  /**
   * Keep asking whether the broadcaster has come back to a rung whose playlist just finished.
   *
   * ⛔ **A finished playlist is the end of a session, not of the feed.** A declared stream's rungs keep
   * their topics for the life of the declaration, so a broadcaster who stops and comes back continues
   * every rung at the next index. This walk used to stop on ENDLIST for good, which left a viewer who
   * had watched the end on "This broadcast has ended" until they reloaded. Measured live 2026-09-24,
   * for fifteen minutes past the return.
   *
   * The walk itself still ends here: this viewer's copy of the playlist is finished and nothing can
   * be appended to it. What comes back is joined by the player's restart, which bootstraps every rung
   * at the live edge again. See {@link FeedReturnWatch} for what the watch asks and what it costs.
   */
  private watchForReturn(owner: string, entry: PolledTopic, finishedAt: FeedIndex): void {
    entry.returnWatch?.stop();
    entry.returnWatch = new FeedReturnWatch(
      this.fetchResource,
      owner,
      entry.topic,
      finishedAt,
      () => this.recordReturn(entry),
      this.returnWatchWaitMs,
    );
    entry.returnWatch.start();
  }

  /**
   * The broadcaster is back on this rung, so the rung and the ladder it belongs to have not ended.
   *
   * Both are told. A ladder's end is recorded once against its group, which is what the overlay and
   * the player listen on, and the group's return is also what ends the wait every rung sat through
   * before the end, whichever rung was found back first. See
   * {@link FeedHealthTracker.recordFeedResumed}.
   */
  private recordReturn(entry: PolledTopic): void {
    entry.returnWatch = null;
    entry.finalized = false;
    this.feedHealth.recordFeedResumed(entry.hexTopic);
    if (entry.group !== null) {
      this.feedHealth.recordFeedResumed(entry.group);
    }
  }

  /**
   * The ended overlay listens on the group topic and finalization arrives one rung at a time, so the
   * last rung to finalize is what ends the group. The single-rendition walk records both against the
   * same topic and needs none of this.
   *
   * All rungs rather than any: one finalized rung beside live ones is a rung retired, not a broadcast
   * over. This was the uploader's own rule too until 2026-09-24, when it learned to finish a ladder
   * without a rung whose stop failed. That mark lives in the catalog, which this poller never reads,
   * so on such a ladder the dead rung never finalizes here and a live viewer is not shown the end.
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
   *
   * @returns How long a run of refusals this poll extends, which is what decides whether it is worth
   *   asking what is behind the slot, or null when the read failed for a reason that is not a
   *   refusal and there is therefore nothing to ask about.
   */
  private recordFailure(entry: PolledTopic, error: unknown): number | null {
    this.recordMiss(entry, error);
    if (isSlotNotWrittenYet(error)) {
      // ⛔ Without this the `stalled` state is dead code on a ladder. The single-rendition walk has
      // always recorded it; this one never did, so a publisher that stopped left the viewer's own
      // gateway healthy, nothing counted, and the overlay stayed down over a frozen picture.
      return this.feedHealth.recordUnservedSlot(entry.hexTopic);
    }
    this.feedHealth.recordGatewayFailure(entry.hexTopic);
    return null;
  }

  private recordMiss(entry: PolledTopic, error: unknown): void {
    entry.misses++;
    if (entry.misses === MISSES_BEFORE_WARNING) {
      console.warn(
        `Feed ${entry.hexTopic} has not advanced in ${entry.misses} attempts. The stream may have ` +
          `ended, or the gateway may be unreachable.`,
        error,
      );
    }
  }
}
