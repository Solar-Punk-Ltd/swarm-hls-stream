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
    }
  }

  for (const entry of allowlist) {
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
