/** What one package's test run reported. A package that printed no recognisable total has no entry at all. */
interface SuiteCount {
  packageName: string;
  tests: number;
  /** Absent when the package's total does not say, as the uploader's floor line does not. */
  passed?: number;
  failed: number;
  /** Present only when the package's total names it, which only the uploader's floor line does. */
  suites?: number;
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
 * The uploader sends node's TAP reporter, which carries the totals, to `.test-summary.tap` and only the
 * dot reporter to stdout. What does reach this output is the line its `scripts/assert-test-floor.mjs`
 * prints once a run holds the floor, `assert-test-floor: 1826 tests in 331 suites, floor 1092/211`. The
 * script prints that line only when no test failed. A refusal names its counts in other words, and pnpm
 * prefixes it into this stream from stderr, so the words around the counts are part of the match.
 */
const FLOOR_TOTAL = /^(\S+)\s+test:\s+assert-test-floor:\s+(\d+)\s+tests\s+in\s+(\d+)\s+suites,\s+floor\s+\S+\s*$/;

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
    const created: SuiteCount = { packageName: name, tests: 0, failed: 0 };
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

    const floor = FLOOR_TOTAL.exec(line);
    if (floor) {
      const entry = forPackage(floor[1]);
      entry.tests = Number(floor[2]);
      entry.suites = Number(floor[3]);
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

/** A total that names no pass count reads as the tests it ran, never as a pass count nobody reported. */
function formatSuiteCount(c: SuiteCount): string {
  const total = c.passed === undefined ? `${c.tests} tests` : `${c.passed}/${c.tests}`;
  const suites = c.suites === undefined ? '' : ` in ${c.suites} suites`;
  const failed = c.failed > 0 ? ` (${c.failed} FAILED)` : '';
  return `${c.packageName} ${total}${suites}${failed}`;
}

/** Renders as the description should quote it, so a mismatch is a string comparison rather than arithmetic. */
export function formatSuiteCounts(counts: SuiteCount[]): string {
  if (counts.length === 0) {
    return 'no package reported a total';
  }
  return counts.map(formatSuiteCount).join(', ');
}
