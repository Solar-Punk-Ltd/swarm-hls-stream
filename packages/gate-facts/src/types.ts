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
  /** Set when the measurement could not be taken, in which case `value` says why rather than lying with a zero. */
  failed?: boolean;
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
  head: string;
  base: string;
  groups: FactGroup[];
  authorMeasured: AuthorMeasured[];
}
