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

function countAdvisoryFindings(report: string): string {
  try {
    const parsed = JSON.parse(report) as { metadata?: { vulnerabilities?: AuditMetadata } };
    const vulnerabilities = parsed.metadata?.vulnerabilities ?? {};
    const total = Object.values(vulnerabilities).reduce<number>((sum, n) => sum + (typeof n === 'number' ? n : 0), 0);
    // Findings, not advisories. One advisory reachable by two paths counts twice here and once in
    // the audit gate, and reading the two as the same number has already produced a wrong claim.
    return String(total);
  } catch {
    return 'could not parse the report';
  }
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

  const suites = parseSuiteCounts(verify.stdout);
  const missing = packagesMissingTotals(
    packagesWithTests(repoRoot),
    suites.map((s) => s.packageName),
  );

  return {
    title: 'Checks',
    facts: [
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
        value: missing.length === 0 ? 'none' : `${missing.length}: ${missing.join(', ')}`,
        command: describe('pnpm', verifyArgs),
        failed: missing.length > 0,
      },
      { key: 'advisory findings', value: countAdvisoryFindings(audit.stdout), command: describe('pnpm', auditArgs) },
      {
        key: 'audit gate',
        value: gate.exitCode === 0 ? gate.stdout.trim().split('\n').pop() || 'passed' : `FAILED, exit ${gate.exitCode}`,
        command: describe('pnpm', gateArgs),
        failed: gate.exitCode !== 0,
      },
    ],
  };
}
