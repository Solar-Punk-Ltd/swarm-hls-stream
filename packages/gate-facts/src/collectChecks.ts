import { formatSuiteCounts, parseSuiteCounts } from './parseSuiteCounts.js';
import { describe, run } from './run.js';
import type { FactGroup } from './types.js';
import { packagesMissingTotals, packagesWithTests } from './workspacePackages.js';

interface AuditMetadata {
  info?: number;
  low?: number;
  moderate?: number;
  high?: number;
  critical?: number;
}

/**
 * Sum the findings `pnpm audit` reports, or say plainly that the report could not be read.
 *
 * A run that never reached the registry still writes valid JSON, of the shape
 * `{"error":{"code":"ECONNREFUSED"}}`, and exits non-zero. Defaulting a missing
 * `metadata.vulnerabilities` to `{}` sums that to zero and prints a clean line directly beneath the
 * audit gate's own pass message. The sibling `packages/audit-gate` throws on this exact input for
 * this exact reason, and two packages in one repository must not answer it differently.
 *
 * A non-zero exit is NOT itself the failure: `pnpm audit` exits non-zero whenever it finds anything
 * at all, which is the ordinary case here. The failure is a report with no counts in it.
 */
export function countAdvisoryFindings(report: string): { value: string; failed: boolean } {
  let parsed: { metadata?: { vulnerabilities?: AuditMetadata } };
  try {
    parsed = JSON.parse(report) as typeof parsed;
  } catch {
    return { value: 'could not parse the report', failed: true };
  }
  const vulnerabilities = parsed.metadata?.vulnerabilities;
  if (vulnerabilities === undefined) {
    return { value: 'the report carried no counts, so the audit did not run', failed: true };
  }
  // Findings, not advisories. One advisory reachable by two paths counts twice here and once in
  // the audit gate, and reading the two as the same number has already produced a wrong claim.
  const total = Object.values(vulnerabilities).reduce<number>((sum, n) => sum + (typeof n === 'number' ? n : 0), 0);
  return { value: String(total), failed: false };
}

/**
 * The whole-repository checks, collected once.
 *
 * `pnpm verify` already runs lint, typecheck, the tests and the format check, so the suite counts
 * are read out of that run rather than paid for a second time.
 */
export async function collectChecks(repoRoot: string): Promise<FactGroup> {
  const verifyArgs = ['verify'];
  const verify = await run('pnpm', verifyArgs);

  const buildArgs = ['build'];
  const build = await run('pnpm', buildArgs);

  const auditArgs = ['audit', '--json'];
  const audit = await run('pnpm', auditArgs);

  const gateArgs = ['audit:check'];
  const gate = await run('pnpm', gateArgs);

  const statusArgs = ['status', '--porcelain'];
  const status = await run('git', statusArgs);

  const suites = parseSuiteCounts(verify.stdout);
  const missing = packagesMissingTotals(
    packagesWithTests(repoRoot),
    suites.map((s) => s.packageName),
  );
  const advisories = countAdvisoryFindings(audit.stdout);
  const dirty = status.stdout.trim().length > 0;

  return {
    title: 'Checks',
    facts: [
      {
        // These four ran against the working tree, not against the head named in the header, so a
        // dirty tree means they describe something no commit contains.
        key: 'working tree',
        value: dirty ? `DIRTY, so the checks below describe an uncommitted state` : 'clean',
        command: describe('git', statusArgs),
        failed: dirty,
      },
      {
        key: 'pnpm verify',
        value: `exit ${verify.exitCode}`,
        command: describe('pnpm', verifyArgs),
        failed: verify.exitCode !== 0,
      },
      {
        key: 'pnpm build',
        value: `exit ${build.exitCode}`,
        command: describe('pnpm', buildArgs),
        failed: build.exitCode !== 0,
      },
      {
        key: 'suites',
        value: formatSuiteCounts(suites),
        command: describe('pnpm', verifyArgs),
        failed: suites.some((s) => s.failed > 0),
      },
      {
        key: 'packages that reported no total',
        // A package absent from the row above is the failure this artifact exists to prevent: the
        // reader counts the packages listed and sees a complete set, because nothing says otherwise.
        // Marked `known` because TEST-27 records the cause: `--test-force-exit` truncates the summary
        // under a pipe. Without `known` this row alone would make every run exit non-zero, and a new
        // failure would be indistinguishable from the one already accepted.
        value: missing.length === 0 ? 'none' : `${missing.length}: ${missing.join(', ')}`,
        command: describe('pnpm', verifyArgs),
        failed: missing.length > 0,
        known: missing.length > 0,
      },
      {
        key: 'advisory findings',
        value: advisories.value,
        command: describe('pnpm', auditArgs),
        failed: advisories.failed,
      },
      {
        key: 'audit gate',
        value: gate.exitCode === 0 ? gate.stdout.trim().split('\n').pop() || 'passed' : `FAILED, exit ${gate.exitCode}`,
        command: describe('pnpm', gateArgs),
        failed: gate.exitCode !== 0,
      },
    ],
  };
}
