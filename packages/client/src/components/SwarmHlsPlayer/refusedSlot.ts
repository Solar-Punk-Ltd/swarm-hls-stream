import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { feedSlotPath } from '@swarm-hls-stream/shared';

import { TimedResponse } from '@/utils/fetchWithTimeout';

import { UNSERVED_POLLS_PROBE_CEILING } from './feedState';

/**
 * A feed slot the publisher has not written yet, which is what a viewer who has caught up sees on
 * nearly every poll. Ordinary, so it is not logged as a failure and the next poll asks again.
 */
export const SLOT_NOT_WRITTEN_YET = 404;

/**
 * How many polls may sit on one refused slot before asking whether anything is behind it.
 *
 * Not zero, and that is the whole of the tuning. A reader riding the live edge is refused on plenty
 * of polls simply because the publisher has not written yet, and probing each one would add a
 * request per poll for every viewer in order to find nothing. Three polls is about a second at the
 * shipping profile, short against the nineteen and forty-six second stalls this is for, and long
 * enough that the ordinary refusal never reaches it: nine of the ten distinct refusals measured on
 * 2026-08-06 cleared within a single poll.
 */
export const UNSERVED_POLLS_BEFORE_PROBE = 3;

/**
 * How far past a refused slot to look, in order, stopping at the first slot that answers.
 *
 * **+1 is not a guess.** Of the seventy-four refused slots measured with something behind them,
 * seventy-three had it at +1, so the common case costs exactly one extra request. The one exception
 * was a hole four slots wide, which is why this carries on rather than giving up, and why it stops
 * at +8: nothing wider than that was seen, and every step costs a request on a gateway that is
 * already the reason the slot is missing.
 */
export const PROBE_DISTANCES = [1, 2, 4, 8] as const;

/** A response that arrived and was refused, as opposed to a transport failure or a timeout. */
export class ManifestFetchError extends Error {
  constructor(path: string, readonly status: number) {
    super(`Failed to fetch: ${path}`);
    this.name = 'ManifestFetchError';
  }
}

/**
 * Whether a failed read is only the publisher not having written the next slot yet.
 *
 * The ordinary answer for a viewer riding the live edge, and never a gateway fault. Everything else,
 * a transport error or a 5xx, is the gateway not answering.
 */
export function isSlotNotWrittenYet(error: unknown): boolean {
  return error instanceof ManifestFetchError && error.status === SLOT_NOT_WRITTEN_YET;
}

/**
 * Whether a run of refusals this long is worth asking a question about.
 *
 * Bounded at both ends. Below the first, a refusal is too likely to be the publisher's head to be
 * worth asking about. Above the second the feed has been asked on every poll and found nothing every
 * time, so what is missing is not within reach and asking again just costs four requests a poll for
 * as long as the page stays open. Both followers keep asking for the slot they need either way, so a
 * slot that becomes retrievable later is still picked up by the ordinary walk.
 *
 * @param unservedPolls The length of the unserved run this poll extends, which is what
 *   {@link FeedHealthTracker.recordUnservedSlot} returns.
 */
export function shouldProbePastRefusal(unservedPolls: number): boolean {
  return unservedPolls >= UNSERVED_POLLS_BEFORE_PROBE && unservedPolls < UNSERVED_POLLS_PROBE_CEILING;
}

/** A slot behind the refusal answered, and this is which one and what it carried. */
interface ProbeServed {
  readonly kind: 'served';
  readonly index: FeedIndex;
  readonly response: TimedResponse;
}

/** Every distance was refused too, so the refusal may really be the publisher's head. */
interface ProbeFoundNothing {
  readonly kind: 'nothing';
}

/** The gateway stopped answering during the probe, which is a fact about the gateway. */
interface ProbeGatewayFailed {
  readonly kind: 'gatewayFailed';
  readonly error: unknown;
}

type ProbeResult = ProbeServed | ProbeFoundNothing | ProbeGatewayFailed;

/**
 * Ask whether anything is behind the slot a follower is waiting on.
 *
 * ## What a 404 means here, measured
 *
 * A refused slot is read as the publisher's head, and on this deployment it usually is not.
 * Measured on 2026-08-06 beside a broadcast, by an instrument that asked past every refusal:
 * **seventy-four of seventy-six refused slots already had a served slot behind them**, and only
 * two were the head a 404 is meant to mean. The worst was refused for sixty-five consecutive polls
 * over nineteen seconds with something at +1 on every one of them, and the browser run before it
 * left a viewer frozen for forty-six seconds after the service was healthy again.
 * `docs/bench/what-is-behind-a-refused-slot-2026-08-06.md`.
 *
 * ## Why stepping over the refusal loses nothing
 *
 * Each slot carries a **full manifest window**, budgeted in bytes against one chunk, so the slot
 * that answers still names the segments the skipped one announced. This is the same property that
 * lets a fresh mount join at the publisher's head rather than replaying the feed.
 *
 * ## Why not the head lookup
 *
 * `GET /feeds/{owner}/{topic}` would answer this in one request and is the wrong request to make:
 * it measured 50 to 57% frozen at 1.0 to 7.0 seconds on this deployment against 46ms for an
 * explicit address, so recovering through it would pay the slowest request the deployment has, in
 * the one moment the gateway is already struggling. See `packages/shared/src/feedFollow.ts`.
 *
 * ## Why this stops at finding the slot
 *
 * ⛔ **The two followers are not equally free to be wrong about a refusal, which is why both make
 * this call and only one used to.** The single-rendition walk pays for a refusal it believed with a
 * slower poll, and the next poll asks again. On a ladder the same refusal is evidence in
 * {@link FeedHealthTracker.rungStoppedWhileOthersAdvance}, and a rung condemned there is handed to
 * `hls.removeLevel`, which has no undo inside the session. So the path where taking a 404 at face
 * value costs the least was the one checking, and the path where it costs a rung for the rest of the
 * broadcast was the one believing it.
 *
 * What a follower does with the slot is still its own, because what the slot has to be folded into
 * differs, so this returns the answer rather than applying it.
 *
 * @param missing The slot that was refused. The probe looks past it and never at it again.
 */
export async function probePastRefusal(
  fetchResource: (path: string) => Promise<TimedResponse>,
  owner: string,
  topic: Topic,
  missing: FeedIndex,
): Promise<ProbeResult> {
  for (const distance of PROBE_DISTANCES) {
    const index = FeedIndex.fromBigInt(missing.toBigInt() + BigInt(distance));

    try {
      const response = await fetchResource(feedSlotPath(owner, topic, index));
      return { kind: 'served', index, response };
    } catch (error) {
      // A refusal here is the ordinary answer and the reason the probe has more than one distance:
      // the slot may be inside the hole, or simply past the publisher. Anything else is the gateway
      // itself, which both followers already back off for.
      if (!isSlotNotWrittenYet(error)) {
        return { kind: 'gatewayFailed', error };
      }
    }
  }

  return { kind: 'nothing' };
}
