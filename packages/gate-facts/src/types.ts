/**
 * One measurement a pull request description is allowed to quote, carrying the command that
 * produced it so a reader can re-derive it without being told how.
 *
 * `value` is a string even for counts, because the artifact is compared textually against a
 * description and a number that renders two ways compares as two values.
 */
export interface Fact {
  key: string;
  value: string;
  command: string;
  /** Set when the measurement itself is bad news, which is what makes the command exit non-zero. */
  failed?: boolean;
  /**
   * A `failed` row for a defect already registered and accepted.
   *
   * It is still rendered and still marked, but it does not make the command exit non-zero. Without
   * this the exit code says the same thing on every run, and a new failure becomes indistinguishable
   * from the one already being lived with. That is this project's most-repeated defect and it went in
   * with the commit that added the first known-failing row.
   */
  known?: boolean;
}

/** A group of facts sharing a heading in the rendered artifact. */
export interface FactGroup {
  title: string;
  facts: Fact[];
}

/**
 * A measurement too slow for a reviewer to reproduce, declared by the author instead of collected.
 *
 * These exist because the alternative is worse: a claims auditor that reproduces a twelve-minute
 * mutation run spends twelve minutes, and one that silently trusts an unmarked number cannot tell
 * a stale figure from a fresh one. Marking it makes UNVERIFIABLE the correct verdict rather than a
 * failure to try.
 */
export interface AuthorMeasured {
  key: string;
  value: string;
  /** How the author obtained it, so a reviewer who does choose to spend the time knows what to run. */
  method: string;
}

export interface GateFacts {
  /** The head as resolved, so a block generated against an older commit is detectable rather than plausible. */
  head: string;
  base: string;
  /** Whether `head` was supplied on the command line rather than derived from the repository. */
  headSupplied: boolean;
  groups: FactGroup[];
  authorMeasured: AuthorMeasured[];
}

/**
 * A collector could not take its measurement.
 *
 * Thrown rather than returned, because the whole point of this artifact is that a measurement which
 * did not happen must never render as a measurement that came back clean. A fresh clone has no local
 * `feat/ai-hardening`, so every `git` call against it fails, and the first version of this package
 * reported that as a change touching zero files, zero source lines and no surfaces, then exited 0.
 */
export class CollectionError extends Error {
  constructor(command: string, detail: string) {
    super(`\`${command}\` did not run: ${detail}`);
    this.name = 'CollectionError';
  }
}
