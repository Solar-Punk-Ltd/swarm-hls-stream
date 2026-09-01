/**
 * Which rungs of a ladder are still being produced, so the master playlist stops advertising one
 * that is not.
 *
 * ## Why this exists
 *
 * The master feed names every rendition a viewer may choose. When a rung stops being produced the
 * master goes on naming it, so a viewer joining afterwards is offered a quality with nothing behind
 * it. Observed 2026-08-31: `[MasterFeedWriter] Master ... written with 4 rung(s): 360p, 480p, 720p,
 * 1080p` logged repeatedly *after* `[SRS] Rung unpublished: live/stream_1080p`.
 *
 * The player has its own defence and it works, so this is no longer the whole of the harm: a viewer
 * who picks the dead rung is moved off it within about seven seconds. What is left is those seven
 * seconds, for every viewer who joins during an outage, on a stream that could simply not have
 * offered it.
 *
 * ## ⛔⛔⛔ The rule is the CLIENT'S rule, ported deliberately and not reinvented
 *
 * `packages/client/src/components/SwarmHlsPlayer/feedState.ts` took **eight attempts** to get this
 * right, and every regression is recorded there. Writing a second, independent rule here would be
 * choosing to make those mistakes again in a place where they are harder to see. Three properties
 * carry over, and each one is a fix for a specific live failure:
 *
 * 1. **Segments, never a clock.** Four attempts judged a rung by how long it had been quiet and
 *    three of them shipped a fault. A clock runs during intervals in which nothing could have been
 *    produced, so it measures the outage rather than the rung. A count of delivered segments cannot:
 *    a whole broadcast stopping freezes every rung's count and leaves the comparison where it was.
 * 2. **The reference is a middle rung, never the leader.** A maximum lets any single rung condemn
 *    every other one, because it takes one rung running ahead for the whole rest of the ladder to be
 *    "behind" by however far it ran. The upper middle, so that two rungs dying together are both
 *    still judged against the two that live.
 * 3. **The lag is measured from where the ladder was when this rung last delivered**, not between
 *    cumulative totals. Rungs are separate transcodes writing separate feeds at slightly different
 *    speeds, so cumulative counts drift apart without bound for reasons that are nobody's fault.
 *
 * ⚠️ Its honest limit, inherited: on a four rung ladder, if THREE die at once the middle sits among
 * the dead and none of them is called dead. That is a broadcast falling apart rather than a rung
 * failing, and it is not this class's job.
 */

/**
 * How many segments the ladder may deliver past a rung before the master stops advertising it.
 *
 * Deliberately the same four as the client's `RUNG_DEATH_LAG_SEGMENTS`. A healthy rung is never more
 * than one or two behind the middle, because the rungs of one ladder are cut by one encoder on one
 * keyframe cadence; four is twice the widest healthy gap. **If one of these moves the other must
 * move with it**, or the master and the player will disagree about which rungs exist.
 */
export const RUNG_DEATH_LAG_SEGMENTS = 4;

/** Below this there is no middle rung to measure against, and a viewer has nowhere to go anyway. */
const MIN_RUNGS_TO_COMPARE = 2;

/**
 * Tracks how far each rung of one ladder has got, and answers which of them are still producing.
 *
 * One instance per ladder. Rungs are named by the ladder's own rung names (`1080p`, `720p`), which
 * is what a `Rendition` carries and what the per-rung metrics are labelled with.
 */
export class LadderLiveness {
  private readonly delivered = new Map<string, number>();

  /** Where the ladder's reference stood when this rung last delivered. */
  private readonly referenceAtLastDelivery = new Map<string, number>();

  /**
   * One segment reached Swarm on this rung.
   *
   * The reference is stamped **after** this rung's own count has moved, so a rung that has just
   * delivered reads as level with the ladder rather than one segment behind it.
   */
  public recordDelivered(rung: string): void {
    this.delivered.set(rung, (this.delivered.get(rung) ?? 0) + 1);
    this.referenceAtLastDelivery.set(rung, this.reference([...this.delivered.keys()]));
  }

  /**
   * How far the ladder has moved on since this rung last delivered.
   *
   * Zero for a ladder too small to have a middle, and zero for a rung that has never delivered:
   * a rung that has not started yet is not a rung that has stopped, and the master should keep
   * offering it until it has had a chance.
   */
  public lagOf(rung: string, rungs: readonly string[]): number {
    if (rungs.length < MIN_RUNGS_TO_COMPARE) {
      return 0;
    }
    const sinceOwnLast = this.referenceAtLastDelivery.get(rung);
    if (sinceOwnLast === undefined) {
      return 0;
    }
    return Math.max(0, this.reference(rungs) - sinceOwnLast);
  }

  /** Whether the ladder has delivered {@link RUNG_DEATH_LAG_SEGMENTS} segments this rung has not. */
  public hasStopped(rung: string, rungs: readonly string[]): boolean {
    return this.lagOf(rung, rungs) >= RUNG_DEATH_LAG_SEGMENTS;
  }

  /**
   * The upper middle of what the ladder's rungs have delivered.
   *
   * Upper rather than lower so two rungs dying together are both still judged against the two that
   * live. `Math.floor(length / 2)` on an ascending sort is the upper middle for an even count, which
   * is the case a four rung ladder is.
   */
  private reference(rungs: readonly string[]): number {
    const progress = rungs.map((rung) => this.delivered.get(rung) ?? 0).sort((a, b) => a - b);
    return progress[Math.floor(progress.length / 2)] ?? 0;
  }
}

/** Named so a caller reads as filtering renditions rather than as knowing about rung names. */
export interface NamedRendition {
  readonly name: string;
}

/**
 * The renditions a master should advertise: everything except a rung the ladder has left behind.
 *
 * ⛔ Never returns empty while it was given something. A master naming no renditions is not a
 * degraded ladder, it is an unplayable stream, and the last rung standing is still the only thing a
 * viewer can be offered. The same floor the client draws with `MIN_LEVELS_TO_DROP_ONE`.
 */
export function advertisableRenditions<T extends NamedRendition>(
  renditions: readonly T[],
  liveness: LadderLiveness,
): T[] {
  const names = renditions.map((rendition) => rendition.name);
  const live = renditions.filter((rendition) => !liveness.hasStopped(rendition.name, names));

  return live.length === 0 ? [...renditions] : live;
}
