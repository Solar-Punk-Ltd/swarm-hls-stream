import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { nextFeedRequest } from '@swarm-hls-stream/shared';

import { TimedResponse } from '@/utils/fetchWithTimeout';

import { parseManifest } from './playlist';

/**
 * How long a finished feed waits between asking whether its broadcaster has come back.
 *
 * ## Why a finished feed is asked anything at all
 *
 * A declared stream's feeds outlive its session. A broadcaster who stops and comes back continues the
 * same feeds at the next index, and the admin accepts `live` after `vod` (the uploader README, "The
 * ABR ladder in admin mode"). Until 2026-09-24 both followers stopped reading a feed for good once its
 * playlist carried ENDLIST. Measured live that day: all four rungs finalized at 18:41:57 UTC, the
 * broadcaster was back at 18:43:18, and a viewer who had watched it end was still paused on "This
 * broadcast has ended" fifteen minutes later, while a viewer who opened the page fresh played it live.
 *
 * ## What it costs
 *
 * One request per finished feed per interval, for as long as the page stays open, whether the viewer
 * watched the broadcast end or opened its recording afterwards. Every one that finds nothing is a
 * Swarm retrieval the gateway attempts and fails, so this is paid by the gateway rather than by the
 * viewer. At thirty seconds that is **0.033 requests a second** for a single rendition and **0.13**
 * for the four rung ladder, which watches every rung. The same ladder walked live asks 5.3 a second,
 * four rungs at the 750ms poll interval, so the watch is one fortieth of it. An hour on an old
 * recording costs 120 requests for a single rendition and 480 for the ladder.
 *
 * ## Why thirty seconds
 *
 * A broadcaster only reaches this after the uploader has already given up on them, which takes its
 * sixty second `ORPHAN_REAP_MS` at least, so a return is a new decision rather than a hiccup, and a
 * viewer who stays learns of the return within half that again. Asking faster would be paid on every
 * recording anybody watches, and almost none of those feeds is ever written again.
 *
 * ⚠️ **Not spread across viewers.** Every viewer who saw a broadcast end starts this watch within a
 * poll of the same moment, so their asks land together every interval, and so do their rejoins when
 * the broadcaster returns. `RequestJitter` exists for exactly that shape and is not applied here. Not
 * measured either way.
 */
export const FEED_RETURN_WATCH_INTERVAL_MS = 30_000;

/** Nothing is behind the finished playlist yet, or the gateway gave no usable answer about it. */
interface FeedStillFinished {
  readonly kind: 'stillFinished';
}

/** Another finished playlist is in the next slot, so the watch moves past it and keeps asking. */
interface FeedFinishedAgain {
  readonly kind: 'finishedAgain';
  readonly index: FeedIndex;
}

/** The next slot holds a playlist that is still open: the broadcaster has come back. */
interface FeedReturned {
  readonly kind: 'returned';
  readonly index: FeedIndex;
}

type FeedReturnAnswer = FeedStillFinished | FeedFinishedAgain | FeedReturned;

const STILL_FINISHED: FeedStillFinished = { kind: 'stillFinished' };

/**
 * Ask once whether anything was written after the playlist that finished a feed.
 *
 * The slot after it, by address, and never the feed head. The head lookup is the slowest request
 * this deployment has (see `probePastRefusal` in `refusedSlot.ts`), and a miss by address is one
 * chunk the gateway does not hold.
 *
 * Shared by both followers for the reason `probePastRefusal` is: what a read of the slot means is one
 * question, and what each follower does with the answer is its own.
 *
 * @param finishedAt The slot whose playlist finished the feed. Only the slot after it is read.
 */
export async function askWhetherFeedReturned(
  fetchResource: (path: string) => Promise<TimedResponse>,
  owner: string,
  topic: Topic,
  finishedAt: FeedIndex,
): Promise<FeedReturnAnswer> {
  const { path, index } = nextFeedRequest(owner, topic, finishedAt);

  let text: string;
  try {
    text = (await fetchResource(path)).text;
  } catch {
    // A refusal is the ordinary answer for a broadcast that stays over, and a gateway that did not
    // answer says nothing about the broadcaster either way. Neither is recorded anywhere: the feed is
    // ended, which outranks both, and the next interval asks again.
    return STILL_FINISHED;
  }

  const parsed = parseManifest(text);
  if (parsed.segments.length === 0) {
    // A 200 that is not a playlist, a captive portal for one. Read as the broadcaster, it would
    // restart a viewer into the recording that is still the newest thing on the feed.
    return STILL_FINISHED;
  }
  return parsed.isFinalized ? { kind: 'finishedAgain', index } : { kind: 'returned', index };
}

/**
 * A slow watch on one finished feed, for its broadcaster coming back.
 *
 * Held by whichever follower saw the feed finish, `LadderFeedPoller` for a rung and `ManifestFetcher`
 * for a single rendition, and stopped by that follower's own teardown. What a return means to each is
 * its own, so it is handed back through `onReturned` rather than recorded here.
 */
export class FeedReturnWatch {
  private isStopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly fetchResource: (path: string) => Promise<TimedResponse>,
    private readonly owner: string,
    private readonly topic: Topic,
    /** The slot whose playlist finished the feed. Moves forward past any finished playlist after it. */
    private finishedAt: FeedIndex,
    /** Called once, when the feed is found open again, and never after {@link stop}. */
    private readonly onReturned: () => void,
    private readonly intervalMs: number = FEED_RETURN_WATCH_INTERVAL_MS,
  ) {}

  /** Asks for the first time one interval from now. The broadcaster has only just finished. */
  start(): void {
    this.askAfterInterval();
  }

  /**
   * Ends the watch at once. The timer is cancelled rather than left to fire into nothing, and a read
   * already in flight is dropped when it lands, since nothing can cancel the request itself.
   */
  stop(): void {
    this.isStopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private askAfterInterval(): void {
    if (this.isStopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.ask();
    }, this.intervalMs);
  }

  private async ask(): Promise<void> {
    const answer = await askWhetherFeedReturned(this.fetchResource, this.owner, this.topic, this.finishedAt);

    // Re-checked after the await, for the reason `LadderFeedPoller.advance` gives about responses that
    // land after a teardown. An answer that outlived its watch belongs to a session that is gone.
    if (this.isStopped) {
      return;
    }

    if (answer.kind === 'returned') {
      this.isStopped = true;
      this.onReturned();
      return;
    }
    if (answer.kind === 'finishedAgain') {
      this.finishedAt = answer.index;
    }
    this.askAfterInterval();
  }
}
