export type AdvisorySeverity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

/**
 * One entry of the `advisories` map in `pnpm audit --json`, narrowed to the
 * fields the gate reads. pnpm keys that map by its own numeric advisory id, so
 * the GHSA carried inside the entry is what an allowlist entry matches on.
 */
export interface Advisory {
  ghsa: string;
  packageName: string;
  severity: AdvisorySeverity;
  title: string;
  patchedVersions: string;
}

/**
 * An advisory that is present on purpose. An entry claims the exposure has been
 * looked at, not that it is harmless, and the gate fails on an entry that stops
 * matching so the list cannot outlive the reason it was written for.
 */
export interface AllowedAdvisory {
  ghsa: string;
  packageName: string;
  /**
   * The advisory as it read when the exception was written. The reason below was
   * argued against these two and nothing else rechecks it, so the gate treats a
   * change in either as the exception needing a fresh look. Without this the
   * elliptic entry's "upstream has shipped nothing to move to" stays green on
   * the day upstream ships something.
   */
  reviewedSeverity: AdvisorySeverity;
  reviewedPatchedVersions: string;
  reason: string;
}

export type GateFailureKind =
  | 'unreviewed'
  | 'stale-exception'
  | 'package-mismatch'
  | 'duplicate-exception'
  | 'advisory-changed';

export interface GateFailure {
  kind: GateFailureKind;
  ghsa: string;
  packageName: string;
  detail: string;
}
