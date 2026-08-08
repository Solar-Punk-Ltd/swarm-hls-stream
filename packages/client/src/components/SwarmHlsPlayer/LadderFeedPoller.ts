import { Topic } from '@ethersphere/bee-js';

import { extractFeedIndex, makeFeedIdentifier } from '@/utils/bee';

import { ManifestStateManager } from './ManifestState';
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
  stopped: boolean;
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
    private readonly fetchResource: (path: string) => Promise<Response>,
    private readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ) {}

  public start(owner: string, topics: Topic[]): void {
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
        stopped: false,
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
      const advanced = await this.advance(owner, entry);

      if (entry.stopped) {
        return;
      }

      // Anything consumed this pass means more may already be waiting, so try again straight
      // away; only an empty pass is worth sleeping on.
      if (advanced === 0) {
        await this.pause(entry);
      }
    }
  }

  private pause(entry: PolledTopic): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.wake = undefined;
        resolve();
      }, this.pollIntervalMs);

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
      const next = current.next();
      const identifier = makeFeedIdentifier(entry.topic, next).toString();

      let response: Response;
      try {
        response = await this.fetchResource(`soc/${owner}/${identifier}`);
      } catch (error) {
        this.recordMiss(entry, error);
        break;
      }

      entry.misses = 0;

      if (!this.ingest(entry, await response.text())) {
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
    let response: Response;
    try {
      response = await this.fetchResource(`feeds/${owner}/${entry.hexTopic}`);
    } catch (error) {
      this.recordMiss(entry, error);
      return false;
    }

    entry.misses = 0;
    const text = await response.text();
    const index = extractFeedIndex(response);

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

    if (!shouldContinue) {
      entry.stopped = true;
    }

    return shouldContinue;
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
