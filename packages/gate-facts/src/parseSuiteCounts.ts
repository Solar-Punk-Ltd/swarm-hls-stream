/** What one package's test run reported, or null where the runner printed no recognisable total. */
export interface SuiteCount {
  packageName: string;
  tests: number;
  passed: number;
  failed: number;
}

/**
 * `pnpm -r test` prefixes every line with the package directory, so one stream carries every
 * package's totals interleaved.
 */
const TAP_TOTAL = /^(\S+)\s+test:\s+#\s+(tests|pass|fail)\s+(\d+)\s*$/;

/**
 * Vitest reports its own way and never prints the TAP totals, so a parser that only reads `# tests`
 * silently drops the one package that does not use `node:test`. Dropping it is worse than failing,
 * because the artifact then shows four packages where the repository has five and nothing says which
 * is missing.
 */
const VITEST_TOTAL = /^(\S+)\s+test:\s+Tests\s+(\d+)\s+passed\s+\((\d+)\)\s*$/;

/**
 * Read per-package totals out of a whole-workspace test run.
 *
 * Returns one entry per package that reported a total, in first-seen order. A package that ran but
 * printed nothing recognisable is absent rather than zeroed, so a caller can tell "no tests ran"
 * from "the reporter changed shape".
 */
export function parseSuiteCounts(output: string): SuiteCount[] {
  const byPackage = new Map<string, SuiteCount>();

  const forPackage = (name: string): SuiteCount => {
    const existing = byPackage.get(name);
    if (existing) {
      return existing;
    }
    const created: SuiteCount = { packageName: name, tests: 0, passed: 0, failed: 0 };
    byPackage.set(name, created);
    return created;
  };

  for (const line of output.split('\n')) {
    const vitest = VITEST_TOTAL.exec(line);
    if (vitest) {
      const entry = forPackage(vitest[1]);
      entry.passed = Number(vitest[2]);
      entry.tests = Number(vitest[3]);
      continue;
    }

    const tap = TAP_TOTAL.exec(line);
    if (!tap) {
      continue;
    }
    const entry = forPackage(tap[1]);
    const count = Number(tap[3]);
    if (tap[2] === 'tests') {
      entry.tests = count;
    } else if (tap[2] === 'pass') {
      entry.passed = count;
    } else {
      entry.failed = count;
    }
  }

  return [...byPackage.values()];
}

/** Renders as the description should quote it, so a mismatch is a string comparison rather than arithmetic. */
export function formatSuiteCounts(counts: SuiteCount[]): string {
  if (counts.length === 0) {
    return 'no package reported a total';
  }
  return counts
    .map((c) => `${c.packageName} ${c.passed}/${c.tests}${c.failed > 0 ? ` (${c.failed} FAILED)` : ''}`)
    .join(', ');
}
