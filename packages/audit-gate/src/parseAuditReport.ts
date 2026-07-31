import { Advisory, AdvisorySeverity } from './types.js';

const SEVERITIES: readonly string[] = ['info', 'low', 'moderate', 'high', 'critical'];

const MAX_QUOTED_OUTPUT = 200;

/**
 * Turns raw `pnpm audit --json` stdout into the advisories the gate reasons
 * about. Every shape that is not a report throws, because an unreadable run and
 * a clean tree must never arrive at the same verdict.
 */
export function parseAuditReport(raw: string): Advisory[] {
  let report: unknown;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error(`pnpm audit did not return JSON. It printed: ${raw.slice(0, MAX_QUOTED_OUTPUT)}`);
  }

  const advisories = (report as { advisories?: unknown } | null)?.advisories;
  if (advisories === null || typeof advisories !== 'object') {
    throw new Error(
      `pnpm audit returned JSON carrying no advisories map. A clean run still emits an empty one, so this is a broken report rather than a clean tree. It printed: ${raw.slice(
        0,
        MAX_QUOTED_OUTPUT,
      )}`,
    );
  }

  const entries = Object.values(advisories as Record<string, unknown>);
  assertReportIsWhole(
    report,
    entries.reduce<number>((total, entry) => total + countFindings(entry), 0),
  );
  return entries.map(toAdvisory);
}

/**
 * `metadata.vulnerabilities` counts findings and not advisories, so an advisory
 * reported against two resolved versions of the same package contributes two.
 * That has to be compared like for like: the first version of this check summed
 * the map instead and refused a healthy tree the moment one appeared.
 */
function countFindings(entry: unknown): number {
  const findings = (entry as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(findings)) {
    throw new Error(
      'pnpm audit reported an advisory with no findings array, so it cannot be reconciled against the vulnerability counts.',
    );
  }
  return findings.length;
}

/**
 * pnpm fills `metadata.vulnerabilities` before anything filters the map, so the
 * two disagreeing means advisories were removed from the report on the way out.
 * `pnpm.auditConfig` does exactly that, and it does not route them through
 * `muted` either, which stays empty, so the count is the only surviving evidence.
 */
function assertReportIsWhole(report: unknown, reportedFindings: number): void {
  const counts = (report as { metadata?: { vulnerabilities?: unknown } } | null)?.metadata?.vulnerabilities;
  if (counts === null || typeof counts !== 'object') {
    throw new Error(
      'pnpm audit returned a report with no metadata.vulnerabilities, so there is nothing to check the advisories map against.',
    );
  }

  const counted = Object.values(counts as Record<string, unknown>).reduce<number>(
    (total, value) => total + (typeof value === 'number' ? value : 0),
    0,
  );

  if (counted !== reportedFindings) {
    throw new Error(
      `pnpm audit counted ${counted} vulnerabilities but its advisories describe ${reportedFindings}. Something suppressed advisories after they were counted, and the usual cause is a pnpm.auditConfig.ignoreGhsas or ignoreCves entry in package.json. Record accepted exposure in the allowlist instead, where it carries a reason and stops matching when it stops being true.`,
    );
  }
}

function toAdvisory(entry: unknown): Advisory {
  if (entry === null || typeof entry !== 'object') {
    throw new Error(`pnpm audit reported an advisory that is not an object: ${JSON.stringify(entry)}`);
  }

  const raw = entry as Record<string, unknown>;

  const ghsa = raw.github_advisory_id;
  if (typeof ghsa !== 'string' || ghsa.length === 0) {
    throw new Error(
      `pnpm audit reported an advisory with no GHSA id, which nothing can be matched against: ${JSON.stringify(
        raw,
      ).slice(0, MAX_QUOTED_OUTPUT)}`,
    );
  }

  const packageName = raw.module_name;
  if (typeof packageName !== 'string' || packageName.length === 0) {
    throw new Error(`${ghsa} arrived with no module_name, so there is no package to hold an allowlist entry against.`);
  }

  const severity = raw.severity;
  if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) {
    throw new Error(`${ghsa} against ${packageName} carries a severity this gate does not know: ${String(severity)}`);
  }

  return {
    ghsa,
    packageName,
    severity: severity as AdvisorySeverity,
    title: typeof raw.title === 'string' ? raw.title : '(untitled)',
    patchedVersions: typeof raw.patched_versions === 'string' ? raw.patched_versions : '(no patched range reported)',
  };
}
