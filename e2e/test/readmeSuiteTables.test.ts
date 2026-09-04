import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The four directories the README documents, each as its own table. */
const FAMILIES = ['preflight', 'scenarios', 'service', 'viewer'] as const;

/**
 * That the README's tables name every suite this package holds, and name nothing else.
 *
 * ## ⛔⛔⛔ Why a test rather than a habit
 *
 * Nothing under `suites/` runs in continuous integration, so the README is the only place an
 * operator learns a suite exists, and it is the file a reviewer reads to decide what a sitting will
 * cover. On 2026-09-05 a review found it missing both drain suites, two viewer suites and one
 * preflight gate, while three documents gave three different counts of the same thing, and a
 * coverage row claimed a sitting that had already run had not. Every one of those was a number or a
 * list kept by hand in prose, next to the code that had moved.
 *
 * ⭐ Stated in both directions on purpose. A row with no file is a suite an operator would go looking
 * for, and a file with no row is a suite nobody knows to run, which for this feature means an
 * arming, a batch the owner paid for and a broadcast.
 */
describe('the README names every suite, and every suite has a README row', () => {
  const readme = readFileSync(join(E2E_DIR, 'README.md'), 'utf8');

  function filesIn(family: string): string[] {
    return readdirSync(join(E2E_DIR, 'suites', family))
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => name.slice(0, -'.test.ts'.length))
      .sort();
  }

  function rowsFor(family: string): string[] {
    const rows = readme.match(new RegExp(`^\\|\\s*\`${family}/([a-z0-9-]+)\``, 'gm')) ?? [];
    return rows.map((row) => row.slice(row.indexOf('/') + 1, row.lastIndexOf('`'))).sort();
  }

  for (const family of FAMILIES) {
    it(`documents every ${family} suite`, () => {
      const missing = filesIn(family).filter((name) => !rowsFor(family).includes(name));

      assert.deepEqual(
        missing,
        [],
        `no README row names ${missing.map((name) => `suites/${family}/${name}.test.ts`).join(', ')}, ` +
          'so nobody reading that file learns the suite exists',
      );
    });

    it(`names no ${family} suite that is not there`, () => {
      const strangers = rowsFor(family).filter((name) => !filesIn(family).includes(name));

      assert.deepEqual(
        strangers,
        [],
        `the README names ${strangers.map((name) => `${family}/${name}`).join(', ')}, which this package does not hold`,
      );
    });
  }
});
