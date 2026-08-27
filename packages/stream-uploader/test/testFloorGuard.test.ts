import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The gate that stops this suite silently shrinking, tested by making it refuse.
 *
 * `scripts/assert-test-floor.mjs` exists because five consecutive runs of this package reported 1017,
 * 987, 980, 996 and 1005 tests with 0 failures and exit 0, each dropping a different tail. A number
 * written into a script is not a control until something proves it refuses, so every branch that must
 * exit non-zero is driven here, and the exit code is what is read rather than the message.
 *
 * The floor is injected through the environment, the way `deploy/test/unusedExports.test.js` injects
 * its baseline, so these fixtures stay independent of whatever the committed floor happens to be.
 */

const GUARD = new URL('../scripts/assert-test-floor.mjs', import.meta.url).pathname;

interface GuardRun {
  status: number;
  output: string;
}

function runGuard(tap: string | null, floor = { tests: 100, suites: 10 }): GuardRun {
  const dir = mkdtempSync(join(tmpdir(), 'test-floor-'));
  const tapPath = join(dir, 'summary.tap');
  if (tap !== null) {
    writeFileSync(tapPath, tap);
  }

  const result = spawnSync(process.execPath, [GUARD, tapPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      UPLOADER_TEST_FLOOR_TESTS: String(floor.tests),
      UPLOADER_TEST_FLOOR_SUITES: String(floor.suites),
    },
  });

  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

function summary({ tests, suites, fail = 0 }: { tests: number; suites: number; fail?: number }): string {
  return ['# Subtest: something', 'ok 1 - something', `# tests ${tests}`, `# suites ${suites}`, `# fail ${fail}`].join(
    '\n',
  );
}

describe('the test-count floor guard (AJP)', () => {
  it('passes a run that reports at least the floor', () => {
    const { status, output } = runGuard(summary({ tests: 100, suites: 10 }));

    assert.equal(status, 0, `a complete run was refused: ${output}`);
    assert.match(output, /100 tests in 10 suites/, `the guard must say what it counted: ${output}`);
  });

  it('REFUSES with exit 1 when fewer tests ran than the floor', () => {
    const { status, output } = runGuard(summary({ tests: 99, suites: 10 }));

    assert.equal(status, 1, 'a truncated run was accepted, which is the defect this guards');
    assert.match(output, /99 tests in 10 suites/, `the refusal must name what it saw: ${output}`);
  });

  // The count held while a whole file's worth of suites vanished, which is how truncation actually
  // presented: one run lost three top-level suites and stayed inside 2% on the test count.
  it('REFUSES with exit 1 when suites are missing even though the test count holds', () => {
    const { status } = runGuard(summary({ tests: 100, suites: 9 }));

    assert.equal(status, 1, 'a run missing whole suites was accepted');
  });

  /**
   * The exact shape of the original defect: a runner killed before it finished writes no summary at
   * all. Reading that as a pass is what turned a broken gate into a green one for weeks.
   */
  it('REFUSES with exit 1 when the run printed no summary at all', () => {
    const { status, output } = runGuard('# Subtest: something\nok 1 - something\n');

    assert.equal(status, 1, 'a run that never printed a summary was accepted as a pass');
    assert.match(output, /no summary/, `the refusal must say the summary was missing: ${output}`);
  });

  it('REFUSES with exit 1 when the TAP file is not there', () => {
    const { status } = runGuard(null);

    assert.equal(status, 1, 'a missing TAP file was accepted');
  });

  it('REFUSES with exit 1 when the run counted failures, whatever the runner exited with', () => {
    const { status } = runGuard(summary({ tests: 100, suites: 10, fail: 1 }));

    assert.equal(status, 1, 'a run with failures was accepted because the count was high enough');
  });

  it('takes the last summary in the file, since a TAP stream appends one block per run', () => {
    const twoRuns = `${summary({ tests: 400, suites: 40 })}\n${summary({ tests: 99, suites: 10 })}`;

    assert.equal(runGuard(twoRuns).status, 1, 'an earlier, larger summary masked the truncated run that followed');
  });
});
