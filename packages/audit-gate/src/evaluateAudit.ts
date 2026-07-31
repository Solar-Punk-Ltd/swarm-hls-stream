import { Advisory, AllowedAdvisory, GateFailure } from './types.js';

/**
 * Decides whether a report is acceptable. An advisory nobody has written down
 * fails, and so does an allowlist entry that no longer matches anything: without
 * the second rule a list stops describing the tree the moment a dependency moves,
 * and every exception in it becomes permanent by default.
 */
export function evaluateAudit(advisories: readonly Advisory[], allowlist: readonly AllowedAdvisory[]): GateFailure[] {
  const failures: GateFailure[] = [];
  const allowedByGhsa = new Map<string, AllowedAdvisory>();

  for (const entry of allowlist) {
    const malformed = describeMalformedEntry(entry);
    if (malformed) {
      failures.push({
        kind: 'malformed-exception',
        ghsa: entry.ghsa,
        packageName: entry.packageName,
        detail: malformed,
      });
      continue;
    }

    const existing = allowedByGhsa.get(entry.ghsa);
    if (existing) {
      failures.push({
        kind: 'duplicate-exception',
        ghsa: entry.ghsa,
        packageName: entry.packageName,
        detail: `Allowlisted twice, once for ${existing.packageName} and once for ${entry.packageName}. Only one of the two would decide the verdict and the other would be ignored in silence.`,
      });
      continue;
    }
    allowedByGhsa.set(entry.ghsa, entry);
  }

  const reportedGhsas = new Set<string>();

  for (const advisory of advisories) {
    const allowed = allowedByGhsa.get(advisory.ghsa);
    if (!allowed) {
      failures.push({
        kind: 'unreviewed',
        ghsa: advisory.ghsa,
        packageName: advisory.packageName,
        detail: `${advisory.severity}: ${advisory.title}. Patched in ${advisory.patchedVersions}.`,
      });
      continue;
    }

    reportedGhsas.add(advisory.ghsa);

    if (allowed.packageName !== advisory.packageName) {
      failures.push({
        kind: 'package-mismatch',
        ghsa: advisory.ghsa,
        packageName: advisory.packageName,
        detail: `Allowed for ${allowed.packageName} but reported against ${advisory.packageName}, which is not the exposure that was reviewed.`,
      });
      continue;
    }

    const drift = describeDrift(allowed, advisory);
    if (drift) {
      failures.push({
        kind: 'advisory-changed',
        ghsa: advisory.ghsa,
        packageName: advisory.packageName,
        detail: `${drift} The exception was argued against how the advisory read then, so re-read the reason before updating the entry.`,
      });
    }
  }

  // Only entries that survived validation, so one bad line produces one failure
  // rather than also being reported as stale for never having matched.
  for (const entry of allowedByGhsa.values()) {
    if (!reportedGhsas.has(entry.ghsa)) {
      failures.push({
        kind: 'stale-exception',
        ghsa: entry.ghsa,
        packageName: entry.packageName,
        detail: `No longer reported against ${entry.packageName}. Delete the entry so the list keeps describing the tree it is supposed to describe.`,
      });
    }
  }

  return failures;
}

const GHSA_PATTERN = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;

/**
 * Names why an entry is not usable, or nothing when it is well formed. These
 * used to be asserted only by this package's own tests, which the `verify` job
 * runs and the `audit` job does not, so a malformed exception passed the very
 * job that depends on it.
 */
function describeMalformedEntry(entry: AllowedAdvisory): string | undefined {
  if (!GHSA_PATTERN.test(entry.ghsa)) {
    return `"${entry.ghsa}" is not a GHSA id, so it can never match a reported advisory and the exception is inert.`;
  }
  if (entry.packageName.trim().length === 0) {
    return 'Names no package, so there is nothing to check the reported advisory against.';
  }
  if (entry.reason.trim().length === 0) {
    return 'Carries no reason. The reason is the whole substance of an exception and nothing else records why this is accepted.';
  }
  return undefined;
}

/**
 * Names what moved under an exception, or nothing when the advisory still reads
 * the way it did when the exception was written. A widened patched range is the
 * one that matters most: it is how "no release fixes this" turns into a fix
 * being available, silently.
 */
function describeDrift(allowed: AllowedAdvisory, advisory: Advisory): string | undefined {
  const changes: string[] = [];

  if (allowed.reviewedSeverity !== advisory.severity) {
    changes.push(`severity was ${allowed.reviewedSeverity} when reviewed and reads ${advisory.severity} now`);
  }

  if (allowed.reviewedPatchedVersions !== advisory.patchedVersions) {
    changes.push(
      `patched range was ${allowed.reviewedPatchedVersions} when reviewed and reads ${advisory.patchedVersions} now`,
    );
  }

  return changes.length > 0 ? `Its ${changes.join(', and its ')}.` : undefined;
}
