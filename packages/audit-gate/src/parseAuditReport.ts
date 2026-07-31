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
      'pnpm audit returned JSON carrying no advisories map. A clean run still emits an empty one, so this is a broken report rather than a clean tree.',
    );
  }

  return Object.values(advisories as Record<string, unknown>).map(toAdvisory);
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
