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
 * ⚠️ Two limits, and they now point the same way. Inherited: if THREE die at once the middle sits
 * among the dead and none of them reads as dead. Ruled 2026-09-01: past
 * {@link MAX_RUNGS_DROPPED_AT_ONCE} nothing is dropped anyway. Both say a ladder losing most of
 * itself is a broadcast ending rather than rungs failing, which is not this class's job.
 *
 * ## ⚠️ Where the two rules now differ, and why the client does not follow
 *
 * Deciding that a rung has STOPPED is still the client's rule exactly, all three properties included.
 * Deciding when it may come BACK is not, since 2026-09-24. The client never takes a rung back: hls.js
 * cannot restore a level it removed, so a rung the player dropped stays dropped for that viewer's
 * session. This rule took a rung back on the first segment it delivered, and a rung whose uploads are
 * being refused still delivers one now and then, which is how the master flipped 793 times on
 * 2026-09-23. So a rung that fell behind while its uploads were being refused is held out until it
 * lands {@link RUNG_READMIT_AFTER_SEGMENTS} segments in a row. A rung that fell behind with nothing
 * refused, such as a transcoder that stopped and came back, still returns on its first segment.
 *
 * The client needs no counterpart. Its removal cannot flap, a viewer who joins later reads this rule's
 * master, and the client could not apply the rule anyway: it sees whether a rung's feed advances, never
 * an upload being refused.
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

/**
 * How many segments in a row a rung whose uploads were being refused must land before the master
 * offers it again.
 *
 * ⛔⛔⛔ Measured live 2026-09-23. 1080p's postage batch was full, so most of its uploads were refused
 * and one landed now and then. The rule took the rung back on each one that landed and dropped it again
 * {@link RUNG_DEATH_LAG_SEGMENTS} of the ladder's segments later, and between 16:17 and 20:14 the
 * master was rewritten 793 times, flipping between three rungs and four about every 18 seconds, and
 * every rewrite was a catalog write too.
 *
 * Twice {@link RUNG_DEATH_LAG_SEGMENTS}, because taking a rung back is the costlier of the two mistakes.
 * A viewer offered a rung that freezes them waits out the player's failover, while a rung kept out a
 * little longer only means one quality is not offered for a few more seconds. So readmission asks for
 * twice the evidence a drop does, and it bounds the flapping as well: a rung that still has one upload
 * in every eight refused never comes back. In time it is eight segments of whatever length the
 * deployment cuts, which on the 2 s segments that ladder ran is sixteen seconds of clean uploads.
 */
export const RUNG_READMIT_AFTER_SEGMENTS = 2 * RUNG_DEATH_LAG_SEGMENTS;

/**
 * How many rungs may be dropped at once before the right conclusion is that the broadcast ended.
 *
 * ⛔⛔⛔ Owner ruling, 2026-09-01, after the first sitting with the failover armed. The uploader was
 * killed in V7 so every rung stopped, and the player concluded three of the four had individually
 * failed and deleted them: hls.js raised a fatal `levelSwitchError` and the whole player destroyed
 * and restarted itself. Rungs do not stop at the same instant, because each drains whatever it was
 * already holding and the queues differ, so a rung that drains further pushes the middle reference
 * up past rungs that stopped with less in hand.
 *
 * One is the whole of the feature: **one quality dies and the others carry on**. A second going
 * quiet is not two independent failures, it is the source going away, and the answer to that is to
 * wait and recover rather than to take the ladder apart.
 *
 * ⚠️ Its honest cost, which the owner accepted: if two rungs genuinely fail separately during one
 * broadcast, the second dead one is kept and a viewer on it can freeze.
 */
export const MAX_RUNGS_DROPPED_AT_ONCE = 1;

/**
 * The subset of `stopped` that may actually be acted on.
 *
 * ⛔ The limit lives here rather than in {@link LadderLiveness.hasStopped}, because "has this rung
 * stopped" and "may we drop it" are different questions. Two dead rungs really have stopped, and a
 * caller reporting on the ladder should still be told so.
 */
function actionable<T>(stopped: readonly T[]): readonly T[] {
  return stopped.length > MAX_RUNGS_DROPPED_AT_ONCE ? [] : stopped;
}

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
   * Segments landed in a row since this rung last had an upload refused, for every rung that has had
   * one refused and has not yet landed {@link RUNG_READMIT_AFTER_SEGMENTS} since.
   */
  private readonly landedSinceRefusal = new Map<string, number>();

  /** Rungs the ladder left behind while their uploads were being refused, held out until they recover. */
  private readonly heldOut = new Set<string>();

  /**
   * One segment reached Swarm on this rung.
   *
   * The reference is stamped **after** this rung's own count has moved, so a rung that has just
   * delivered reads as level with the ladder rather than one segment behind it.
   */
  public recordDelivered(rung: string): void {
    this.delivered.set(rung, (this.delivered.get(rung) ?? 0) + 1);
    this.referenceAtLastDelivery.set(rung, this.reference([...this.delivered.keys()]));
    this.countLandedAfterRefusal(rung);
    this.holdOutRefusedRungsLeftBehind();
  }

  /**
   * One segment of this rung spent its whole retry window and never reached Swarm.
   *
   * A count of events, like every other input here, and never a clock: it is the other half of
   * {@link recordDelivered}, and together they say whether this rung's uploads are working.
   */
  public recordUploadFailed(rung: string): void {
    this.landedSinceRefusal.set(rung, 0);
    this.holdOutRefusedRungsLeftBehind();
  }

  private countLandedAfterRefusal(rung: string): void {
    const landed = this.landedSinceRefusal.get(rung);
    if (landed === undefined) {
      return;
    }
    if (landed + 1 < RUNG_READMIT_AFTER_SEGMENTS) {
      this.landedSinceRefusal.set(rung, landed + 1);
      return;
    }
    this.landedSinceRefusal.delete(rung);
    this.heldOut.delete(rung);
  }

  /**
   * Hold out every rung whose uploads are being refused and that the ladder has now left
   * {@link RUNG_DEATH_LAG_SEGMENTS} behind, which is the moment the ordinary rule drops it.
   *
   * ⛔ Only once it is that far behind, never on a refusal alone. A rung that has one upload refused
   * and keeps pace with the ladder never falls behind, and dropping it for that one segment would take
   * a working quality away from every viewer.
   */
  private holdOutRefusedRungsLeftBehind(): void {
    const known = [...this.delivered.keys()];
    for (const rung of this.landedSinceRefusal.keys()) {
      if (this.lagOf(rung, known) >= RUNG_DEATH_LAG_SEGMENTS) {
        this.heldOut.add(rung);
      }
    }
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

  /**
   * Whether the ladder has delivered {@link RUNG_DEATH_LAG_SEGMENTS} segments this rung has not, or it
   * is held out because its uploads were being refused when that happened and it has not recovered.
   */
  public hasStopped(rung: string, rungs: readonly string[]): boolean {
    return this.lagOf(rung, rungs) >= RUNG_DEATH_LAG_SEGMENTS || this.heldOut.has(rung);
  }

  /**
   * The rungs this ladder has seen deliver that have not since stopped, in delivery order.
   *
   * ⛔ Judged against the rungs this tracker knows about rather than against a caller's list, so it
   * can answer before anyone has handed it a rendition set. That is what lets the segment path ask
   * "has the shape of this ladder changed" on every delivery without reading the catalog feed.
   */
  public liveRungs(): string[] {
    const known = [...this.delivered.keys()];
    const dropped = actionable(known.filter((rung) => this.hasStopped(rung, known)));

    return known.filter((rung) => !dropped.includes(rung));
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
interface NamedRendition {
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
  const dropped = actionable(renditions.filter((rendition) => liveness.hasStopped(rendition.name, names)));
  const live = renditions.filter((rendition) => !dropped.includes(rendition));

  return live.length === 0 ? [...renditions] : live;
}
