/**
 * How long the gateway goes on refusing a segment, timed without holding up the collection loop.
 *
 * The in-loop version of this could not reach the answer. Waiting inside the loop costs the loop its
 * pace, and the loop's pace is what keeps the reader at the live edge, so the budget had to stay
 * around two seconds. A 10-minute run then found 19 of 84 segments still refused after two full
 * seconds of asking, which places the answer above the only window that measurement could see.
 *
 * So the asking moves off the loop. A refusal hands its reference here and the loop carries on.
 *
 * **The load this adds is the design constraint, not an afterthought.** At four segments a second and
 * a fifth of them refused, an unbounded watcher that rechecks twice a second would put tens of
 * requests a second on the same gateway the run is measuring, and the reading would describe a
 * gateway nobody deploys. `concurrency` caps the watchers and `recheckMs` caps their rate, so the
 * worst case is `concurrency / recheckMs` requests a second and is known before the run starts.
 *
 * A refusal arriving with every slot busy is **not watched and is counted**, because a distribution
 * over whatever happened to fit, reported as though it covered everything, is the failure this whole
 * directory exists to avoid.
 */

export interface UnservedResolution {
  ref: string;
  /** Milliseconds from the refusal to the ask that worked, or null if none did inside the budget. */
  resolvedAfterMs: number | null;
  asks: number;
}

export interface UnservedWatchOptions {
  /** How long to keep asking before giving up on one segment. */
  budgetMs: number;
  /** How long to wait between asks. With `concurrency`, this bounds the load added. */
  recheckMs: number;
  /** How many segments may be watched at once. Refusals arriving past this are counted, not queued. */
  concurrency: number;
}

/** Asks the gateway for a segment once. Resolves if it served it, rejects if it did not. */
export type AskOnce = (ref: string) => Promise<void>;

export class UnservedSegmentWatch {
  private readonly running = new Set<Promise<void>>();
  private readonly results: UnservedResolution[] = [];
  private unwatchedCount = 0;

  constructor(
    private readonly ask: AskOnce,
    private readonly options: UnservedWatchOptions,
    /** Injected so a test drives the clock rather than waiting out a real budget. */
    private readonly now: () => number = () => Date.now(),
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /**
   * Start timing a refusal, or count it as unwatched when every slot is busy.
   *
   * Returns nothing and never rejects: the caller is the collection loop, and a watcher that could
   * throw into it would make measuring the run a way to lose it.
   */
  observe(ref: string): void {
    if (this.running.size >= this.options.concurrency) {
      this.unwatchedCount += 1;
      return;
    }
    const watching = this.timeOne(ref).catch(() => undefined);
    this.running.add(watching);
    void watching.finally(() => this.running.delete(watching));
  }

  /** Let the watchers still asking finish, so a run does not report a half-collected distribution. */
  async settle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running]);
    }
  }

  get resolutions(): readonly UnservedResolution[] {
    return this.results;
  }

  /** Refusals that arrived with every slot busy, so the distribution above does not cover them. */
  get unwatched(): number {
    return this.unwatchedCount;
  }

  private async timeOne(ref: string): Promise<void> {
    const refusedAtMs = this.now();
    const deadlineMs = refusedAtMs + this.options.budgetMs;
    let asks = 0;

    // Ask before waiting, not after. Sleeping first made one whole recheck interval the smallest
    // number this could ever report, which at the shipped 1000ms is the same 1 second the report
    // uses as its threshold: every resolution was overstated by an interval, and a segment that was
    // already there was indistinguishable from one that took a second to arrive. See task #103.
    while (this.now() < deadlineMs) {
      asks += 1;
      try {
        await this.ask(ref);
        this.results.push({ ref, resolvedAfterMs: this.now() - refusedAtMs, asks });
        return;
      } catch {
        // Still refused, which is the ordinary case this exists to time.
      }
      await this.wait(this.options.recheckMs);
    }

    this.results.push({ ref, resolvedAfterMs: null, asks });
  }
}
