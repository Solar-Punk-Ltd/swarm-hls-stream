import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'deploy/scripts/browser-cpu.sh');

/**
 * What the browser cost in CPU while an arm ran, and whether that reading was taken at all.
 *
 * ⛔⛔⛔ THIS IS THE PROCESS-TREE TOTAL AND NOT A SATURATION READING, and the two answer different
 * questions. `docker stats` reports the container's whole cgroup, which is every Chrome process the
 * arm started: browser, GPU, renderers, utilities and the service worker weeb-3 serves HLS through.
 * That is the right number for "what does this viewer cost". It CANNOT say whether weeb-3 is out of
 * CPU, because the node is one JS thread by construction and a container at 30% of twelve cores can
 * still be a viewer whose single thread is pegged. `chrome-cpu.mjs` explains that at length and takes
 * the main-thread reading over CDP. Nothing here does, and no figure from here may be quoted as one.
 *
 * ⛔⛔ EVERY ASSERTION ON A SAMPLE'S VALUE IS PRECEDED BY ONE ON THE COUNT. Gate lesson AHU: a `for`
 * over an empty list is an `if` that defaults to true, and that is exactly how a floor check that
 * polled a file nobody wrote survived two paid sittings and a passing test.
 */

const cleanups = [];

after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

/**
 * A sandbox with a stubbed `docker stats` answering with the CPU percentages given, in order.
 *
 * `absent` models the container not being there: `docker stats` writes nothing to stdout and fails,
 * which is what happens for every sample taken before the arm's container starts.
 */
function sandbox({ percentages = ['120.50%'], absent = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-cpu-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const callLog = join(dir, 'docker-calls.txt');
  writeFileSync(callLog, '');
  const answersFile = join(dir, 'answers.txt');
  writeFileSync(answersFile, `${percentages.join('\n')}\n`);

  // ⛔ POSIX sh and not node. A node stub costs about 400ms to start on this machine, so a sampler on
  // a 50ms interval took ONE sample in half a second and the count assertions failed for a reason
  // that had nothing to do with the script under test. A stub slower than the interval it is being
  // used to measure cannot measure that interval.
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
[ "$1" = stats ] || exit 0
taken=$(wc -l < ${JSON.stringify(callLog)} | tr -d ' ')
echo "$*" >> ${JSON.stringify(callLog)}
if [ ${absent ? 1 : 0} -eq 1 ]; then
  echo 'Error response from daemon: No such container' >&2
  exit 1
fi
total=$(wc -l < ${JSON.stringify(answersFile)} | tr -d ' ')
i=$((taken + 1))
[ "$i" -gt "$total" ] && i="$total"
sed -n "\${i}p" ${JSON.stringify(answersFile)}
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);

  return { dir, bin, callLog };
}

/**
 * Drive the real script the way an arm does: source it, sample, stop, then summarise.
 *
 * ⛔⛔ It WAITS FOR THE FIRST SAMPLE rather than sleeping a fixed span and hoping. One iteration costs
 * about 0.4s here and far more when the rest of the suite is running beside it, so a fixed sleep made
 * the sample count a function of machine load. A timing test that fails on a busy machine gets its
 * threshold raised until it cannot fail at all, and the arithmetic it was guarding goes untested. The
 * arithmetic is tested below with no timing in it whatsoever.
 */
async function sampleAnArm(box, { intervalS = '0.05', container = 'byte-source-browser' } = {}) {
  const log = join(box.dir, 'run.log');
  const series = join(box.dir, 'cpu.txt');
  // ⛔ Every shell variable reference is escaped. An unescaped ${...} here is read by JavaScript, not
  // by bash, and a `${LOG}` meant for the script under test is a ReferenceError in this file.
  const script = `
set -u
LOG=${JSON.stringify(log)}
say() { printf '%s\\n' "$*" >> "\${LOG}"; }
BROWSER_CONTAINER_NAME=${JSON.stringify(container)}
BROWSER_CPU_INTERVAL_S=${JSON.stringify(intervalS)}
. ${JSON.stringify(SCRIPT)}
start_browser_cpu ${JSON.stringify(series)} arm01
for _ in $(seq 1 200); do
  [ -s ${JSON.stringify(series)} ] && break
  sleep 0.1
done
stop_browser_cpu
summarize_browser_cpu ${JSON.stringify(series)} arm01
`;
  await run('bash', ['-c', script], { env: { ...process.env, PATH: `${box.bin}:${process.env.PATH}` } });

  // A sampler that declined never creates the series at all, which is a different state from one that
  // created it and wrote nothing. Both are "no samples" to a caller, and neither may read as zero.
  // `calls` separates a third state from both: a stub that was never reached, which is a broken test
  // rather than a finding about the script.
  return {
    log: readFileSync(log, 'utf8'),
    series: existsSync(series) ? readFileSync(series, 'utf8').split('\n').filter(Boolean) : [],
    calls: readFileSync(box.callLog, 'utf8').split('\n').filter(Boolean),
  };
}

/** Hand the summariser a series directly. No sampler, no clock, no dependence on machine load. */
async function summariseSeries(box, lines) {
  const log = join(box.dir, 'summary.log');
  const series = join(box.dir, 'given.txt');
  writeFileSync(series, `${lines.join('\n')}\n`);
  const script = `
set -u
LOG=${JSON.stringify(log)}
say() { printf '%s\\n' "$*" >> "\${LOG}"; }
BROWSER_CONTAINER_NAME=byte-source-browser
. ${JSON.stringify(SCRIPT)}
summarize_browser_cpu ${JSON.stringify(series)} arm01
`;
  await run('bash', ['-c', script], { env: { ...process.env, PATH: `${box.bin}:${process.env.PATH}` } });
  return { log: readFileSync(log, 'utf8') };
}

describe('what the browser cost while an arm ran', () => {
  it('takes a sample per interval, so a summary has something to summarise', async () => {
    const result = await sampleAnArm(sandbox());

    assert.ok(
      result.series.length > 0,
      `no sample taken. docker calls: ${JSON.stringify(result.calls)} log: ${result.log}`,
    );
    assert.match(result.log, /samples/);
  });

  /**
   * ⛔ No sampler and no clock. `summarize_browser_cpu` is handed a series and asked what it says, so
   * this cannot pass or fail on how busy the machine is. The sampler's job is proved above by the
   * count; turning what it collected into a mean and a peak is arithmetic and is proved here.
   */
  it('reports the mean and the peak, because a viewer near a ceiling and one idling average the same', async () => {
    // 1.00, 3.00 and 2.00 cores. Mean 2.00, peak 3.00, and a mean alone cannot tell this from a flat
    // 2.00, which is the difference between a viewer with headroom and one about to stall.
    const result = await summariseSeries(sandbox(), ['100.00%', '300.00%', '200.00%']);

    assert.match(result.log, /3 samples/);
    assert.match(result.log, /mean 2\.00 cores/);
    assert.match(result.log, /peak 3\.00 cores/);
  });

  it('drops a line it cannot parse rather than averaging it in as an idle sample', async () => {
    const result = await summariseSeries(sandbox(), ['200.00%', 'Error response from daemon', '200.00%']);

    assert.match(result.log, /2 samples/, 'an unreadable line was counted, which pulls the mean toward zero');
    assert.match(result.log, /mean 2\.00 cores/);
  });

  /**
   * ⛔⛔⛔ THE CASE THAT MATTERS MOST, AND THE ONE A LOOP OVER SAMPLES CANNOT CATCH.
   *
   * A container that never answered produces an empty series, and every statistic over an empty
   * series is either zero or absent. "0.00 cores" in a report is indistinguishable from a viewer
   * that cost nothing, which is the shape that let a dead floor check pass a test and two sittings.
   */
  it('says the reading was never taken rather than reporting zero cores', async () => {
    const result = await sampleAnArm(sandbox({ absent: true }));

    assert.equal(result.series.length, 0, 'the stub answered after all, so this proves nothing');
    assert.match(result.log, /NO CPU READING/);
    assert.doesNotMatch(result.log, /0\.00 cores/, 'an unread container was reported as an idle one');
  });

  it('declines out loud when the interval disables it, the way the node sampler learned to', async () => {
    const result = await sampleAnArm(sandbox(), { intervalS: '0' });

    assert.match(result.log, /NO CPU READING/);
    assert.equal(result.series.length, 0);
  });
});
