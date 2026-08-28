/**
 * Refuse a test run that reported fewer tests than this package is known to have.
 *
 * ## The failure this exists for
 *
 * Measured 2026-08-27: five consecutive runs of this package's suite reported **1017, 987, 980, 996
 * and 1005 tests, every one of them with 0 failures and exit 0**. Set-diffing two full TAP captures by
 * top-level suite name showed each run dropping a different tail, and one of them listed a bare
 * filename as a test item. A run that could actually finish reported 1023 tests in 202 suites, so
 * repo-wide green had been a lottery over 96 to 100% of the suite, with nothing in the output saying
 * so. The floor below is higher than 1023 because this guard's own tests are in the count it guards.
 *
 * The cause was `--test-force-exit` in the package's `test` script. Two test files leaked timers and
 * their child processes never exited, so the flag was added to stop the run hanging. Force-exit then
 * terminated the runner before late-registering files had finished, and a file that never finished was
 * not counted, not reported, and not a failure. The leaks are closed now (see the trackers at the top
 * of `test/OmeHlsPuller.test.ts` and `test/OmeEngine.test.ts`) and the flag is gone.
 *
 * ## Why a floor rather than a fixed count
 *
 * Adding tests must never need a second commit, and truncation always shows up as fewer. A deliberate
 * removal does have to lower the number here, which is the point: it makes a shrinking suite a visible
 * line in a diff rather than a quiet drift, the same way `deploy/test/unusedExports.test.js` ratchets
 * unused exports.
 *
 * ## Why it reads a file rather than a pipe
 *
 * npm runs scripts through `sh`, which on Linux is dash and has no `pipefail`, so `tsx --test | node
 * this` would report this script's status and silently swallow a crashing runner. The package script
 * writes TAP to a file, then runs this with `&&`, so either failure fails the gate.
 */
import { readFileSync } from 'node:fs';

/**
 * The lowest counts a complete run may report. Raise them when the suite grows past them, and lower
 * them only when tests are deliberately removed.
 */
const FLOOR = {
  tests: Number(process.env.UPLOADER_TEST_FLOOR_TESTS ?? 1046),
  suites: Number(process.env.UPLOADER_TEST_FLOOR_SUITES ?? 204),
};

const tapPath = process.argv[2];

function refuse(message) {
  console.error(`\nassert-test-floor: ${message}`);
  process.exit(1);
}

if (!tapPath) {
  refuse('no TAP file given. Usage: node scripts/assert-test-floor.mjs <tap-file>');
}

let tap;
try {
  tap = readFileSync(tapPath, 'utf8');
} catch (error) {
  refuse(`cannot read the TAP output at ${tapPath}: ${error.message}`);
}

/** The last match, because a TAP stream carries one summary block per run and appends. */
function summaryCount(field) {
  const matches = [...tap.matchAll(new RegExp(`^# ${field} (\\d+)$`, 'gm'))];
  return matches.length === 0 ? null : Number(matches[matches.length - 1][1]);
}

const tests = summaryCount('tests');
const suites = summaryCount('suites');
const failed = summaryCount('fail');

if (tests === null || suites === null) {
  refuse(
    `the run printed no summary (no "# tests" line in ${tapPath}), which is what a runner killed ` +
      'before it finished looks like. Treating that as a pass is the whole defect this guards.',
  );
}

if (failed !== null && failed > 0) {
  refuse(`${failed} test(s) failed. The runner should have said so itself, so read ${tapPath}.`);
}

if (tests < FLOOR.tests || suites < FLOOR.suites) {
  refuse(
    `this run reported ${tests} tests in ${suites} suites, below the committed floor of ${FLOOR.tests} ` +
      `tests in ${FLOOR.suites} suites.\n` +
      '  Either the run was truncated, which is a broken gate rather than a green one, or tests were\n' +
      '  removed on purpose. If they were, lower the floor in scripts/assert-test-floor.mjs in the same\n' +
      '  commit that removes them.',
  );
}

console.log(`assert-test-floor: ${tests} tests in ${suites} suites, floor ${FLOOR.tests}/${FLOOR.suites}`);
