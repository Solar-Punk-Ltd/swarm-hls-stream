import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const E2E_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUITES_DIR = join(E2E_DIR, 'suites');

/**
 * Every suite must read its config at module scope, because a `describe` that throws exits 0.
 *
 * ⛔ Measured 2026-08-27, with isolated fixtures on this Node. A throw inside a `describe` callback
 * prints `not ok` and is then counted as `# tests 0`, `# fail 0`, and the process **exits 0**. That
 * holds in a multi-file run beside passing suites, which is the shape `pnpm e2e:run` actually has.
 * The runner's counters and its exit code track `it()` cases and nothing else.
 *
 * Every suite here opens with `loadConfig()`, which throws on a bad profile, an unusable publish key,
 * an out-of-range port slot or an unknown `E2E_EXPECT_ABR`. Sixteen of nineteen called it inside the
 * `describe`, so any of those made the whole run report success having deployed nothing. Thrown
 * during import instead, it fails the file and the run.
 *
 * ## Why column zero is a sound test for module scope
 *
 * Crude on its face, and reliable here for one reason: `pnpm verify` ends with `prettier --check`
 * over every tracked file, so indentation is not a matter of taste in this repo. A statement at
 * column zero is at module scope and a nested one is indented, or prettier fails first.
 */
describe('every e2e suite reads its config where a throw can fail the run', () => {
  const suiteFiles = testFilesUnder(SUITES_DIR);

  it('finds the suites at all, so an empty sweep cannot pass as a clean one', () => {
    assert.ok(suiteFiles.length > 10, `expected the suite tree, found ${suiteFiles.length} files`);
  });

  it('calls loadConfig at module scope in every one of them', () => {
    const nested = suiteFiles.filter((path) => callsLoadConfigIndented(readFileSync(path, 'utf8')));

    assert.deepEqual(
      nested.map((path) => relative(E2E_DIR, path)),
      [],
      'these call loadConfig inside a describe, where a throw prints "not ok" and still exits 0. ' +
        'Move the call above the describe.',
    );
  });

  it('would notice, so this is not a check that passes on anything', () => {
    assert.ok(callsLoadConfigIndented('describe("x", () => {\n  const cfg = loadConfig();\n});\n'));
    assert.ok(!callsLoadConfigIndented('const cfg = loadConfig();\n\ndescribe("x", () => {});\n'));
  });

  /** A mention in a docstring is not a call, so the parenthesis is part of what is matched. */
  it('reads a doc comment naming loadConfig as prose rather than as a call', () => {
    assert.ok(!callsLoadConfigIndented(' * loadConfig is read at module scope, not in the describe.\n'));
  });
});

function callsLoadConfigIndented(source: string): boolean {
  return source.split('\n').some((line) => /^\s+/.test(line) && line.includes('loadConfig('));
}

function testFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...testFilesUnder(path));
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}
