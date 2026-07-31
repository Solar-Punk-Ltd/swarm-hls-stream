import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ALLOWED_ADVISORIES } from './allowlist.js';
import { evaluateAudit } from './evaluateAudit.js';
import { parseAuditReport } from './parseAuditReport.js';

const execFileAsync = promisify(execFile);

/** The report for this workspace is around 100 kB, so this is headroom rather than a limit anyone reaches. */
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

async function readAuditReport(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('pnpm', ['audit', '--json'], { maxBuffer: MAX_REPORT_BYTES });
    return stdout;
  } catch (error) {
    // pnpm audit exits non-zero whenever it finds anything at all, so a non-zero
    // exit is the ordinary case here and the report still arrives on stdout.
    // Empty stdout is the one that means the command itself never ran.
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string' && stdout.trim().length > 0) {
      return stdout;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const advisories = parseAuditReport(await readAuditReport());
  const failures = evaluateAudit(advisories, ALLOWED_ADVISORIES);

  if (failures.length === 0) {
    console.log(`Audit gate passed. ${advisories.length} advisories reported, every one of them allowlisted.`);
    return;
  }

  console.error(`Audit gate failed on ${failures.length} of ${advisories.length} reported advisories.`);
  for (const failure of failures) {
    console.error(`  [${failure.kind}] ${failure.ghsa} (${failure.packageName})`);
    console.error(`    ${failure.detail}`);
  }
  console.error('');
  console.error('Upgrade the dependency, or add the advisory to packages/audit-gate/src/allowlist.ts');
  console.error('with the reason it cannot be closed today.');
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`Audit gate could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
