/**
 * How long a master rewrite that did not reach the feed waits before a delivery may try it again.
 *
 * A rewrite is a master feed write, with a catalog feed write behind it where a catalog owns the
 * ladder, both on serialised queues, and each already spends ten seconds retrying inside itself.
 * Deliveries arrive several a second on a four rung ladder, so retrying on the next one would put a
 * continuous stream of attempts onto a node that has just proved it cannot take one. Longer than that
 * inner window, so a failing writer is asked once per period rather than back to back, and short
 * enough that a rung death is corrected well inside one broadcast rather than at the next transition,
 * which a steady broadcast never produces.
 */
export const MASTER_REWRITE_RETRY_MS = 30_000;

/**
 * When a ladder's master may be rewritten because the set of rungs producing it changed, and what a
 * rewrite that did not land costs.
 *
 * ## ⛔⛔⛔ Shared by both ladder registries rather than written twice
 *
 * Every rule below is a fix for a measured live failure, recorded at length on
 * `StreamCatalog.republishIfLadderShapeChanged`, and this class is that bookkeeping lifted out
 * unchanged so the admin registry runs it rather than a second copy of it. `LadderLiveness` states the
 * same principle about the player's rung-death rule it ports: a second, independent version of a rule
 * that took several attempts to get right is a decision to make those mistakes again somewhere they
 * are harder to see.
 *
 * ⛔ **{@link recordAdvertised} takes only shapes the feed actually took.** A shape a rewrite was
 * merely attempted for belongs in the in-flight mark instead: recording it as advertised is how a
 * master that never landed stopped anything from ever trying again, which left a viewer joining a
 * steady broadcast offered a dead rung for the rest of it.
 *
 * ⛔ **The in-flight mark is what keeps a burst of deliveries across one transition to a single
 * write**, and it is cleared per shape rather than per group: a transition inside the write window
 * starts a rewrite for the newer shape that overwrites the mark, and clearing that one on the older
 * rewrite's way out let the next delivery queue the newer shape a second time.
 */
export class MasterRewriteSchedule {
  /** The last ladder shape that reached the feed, by group, as a joined list of rung names. */
  private readonly advertised = new Map<string, string>();

  /** The shape a rewrite is in flight for, by group, and absent while none is. */
  private readonly inFlight = new Map<string, string>();

  /** Per group, the reading before which a rewrite that did not land is not attempted again. */
  private readonly retryAt = new Map<string, number>();

  /**
   * @param now a monotonic reading in milliseconds. Monotonic rather than a date so a clock
   * adjustment cannot move a hold-off's deadline, and injected so a test can step it rather than wait
   * out {@link MASTER_REWRITE_RETRY_MS}.
   */
  constructor(private readonly now: () => number) {}

  /**
   * Whether a rewrite to `shape` should start, marking it in flight when it answers true.
   *
   * The caller must pair a `true` with exactly one {@link endRewrite} for the same shape, however the
   * rewrite ends.
   */
  public beginRewrite(group: string, shape: string): boolean {
    if (this.advertised.get(group) === shape || this.inFlight.get(group) === shape) {
      return false;
    }
    const retryAt = this.retryAt.get(group);
    if (retryAt !== undefined && this.now() < retryAt) {
      return false;
    }
    this.inFlight.set(group, shape);
    return true;
  }

  /** A shape a viewer can now resolve, because everything naming it reached the feed. */
  public recordAdvertised(group: string, shape: string): void {
    this.advertised.set(group, shape);
  }

  /** A rewrite that landed: the shape is advertised, and the group is off hold-off. */
  public rewriteLanded(group: string, shape: string): void {
    this.recordAdvertised(group, shape);
    this.retryAt.delete(group);
  }

  /**
   * A rewrite that wrote nothing, so no delivery may try this group again for a period.
   *
   * Resolving without writing is held off exactly like throwing, because both are conditions that
   * persist — a ladder with no entry to rewrite, or nothing left to name — and asking again on the
   * next segment would ask several times a second for the rest of the broadcast.
   */
  public holdOff(group: string): void {
    this.retryAt.set(group, this.now() + MASTER_REWRITE_RETRY_MS);
  }

  /** This rewrite's own in-flight mark, and only its own. */
  public endRewrite(group: string, shape: string): void {
    if (this.inFlight.get(group) === shape) {
      this.inFlight.delete(group);
    }
  }
}

/** The shape of a ladder as this schedule compares them: its rung names, in order, joined. */
export function ladderShape(rungs: readonly string[]): string {
  return rungs.join(',');
}
