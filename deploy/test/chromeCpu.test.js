import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  chromeProcessType,
  coresBetween,
  METRICS_OF_INTEREST,
  parseCpuTime,
  parseProcessTable,
  readMetrics,
  summarizeCpu,
  treeCpu,
  windowRates,
} from '../scripts/chrome-cpu.mjs';

/**
 * ⭐ THE UNIT UNDER TEST IS AN ACCOUNTING BOUNDARY, WHICH IS WHY IT GETS A TEST AT ALL.
 *
 * Every CPU figure this project holds was read off one PID. That is right for bee, which is one
 * process, and wrong for Chrome, which spawns a browser process, a GPU process and one renderer per
 * site plus utilities. Sampling the launcher PID alone would report a number that is roughly the
 * cost of supervising the work rather than the cost of doing it, and it would look plausible.
 *
 * So the tree walk is the measurement, and these cases are the ones that would silently undercount:
 * a helper that is a grandchild rather than a child, a sibling Chrome the operator already had open,
 * and a time format that parses to a wrong number rather than to NaN.
 */

describe('parseCpuTime', () => {
  it('reads the MM:SS.ss form ps uses for a short-lived process', () => {
    assert.equal(parseCpuTime('0:12.34'), 12.34);
    assert.equal(parseCpuTime('2:03.00'), 123);
  });

  it('reads the HH:MM:SS form ps switches to after an hour', () => {
    assert.equal(parseCpuTime('1:02:03'), 3723);
  });

  it('reads the DD-HH:MM:SS form, which is where a naive split silently loses a day', () => {
    assert.equal(parseCpuTime('2-01:00:00'), 2 * 86400 + 3600);
  });

  /**
   * ⛔ Returning 0 or NaN here would be read as "this process was idle" rather than as "this reading
   * failed", and the run would carry on and average it in. A CPU total that is quietly too low is the
   * exact failure this whole file exists to prevent.
   */
  it('throws rather than returning a number it did not read', () => {
    assert.throws(() => parseCpuTime('-'), /unreadable CPU time/);
    assert.throws(() => parseCpuTime(''), /unreadable CPU time/);
    assert.throws(() => parseCpuTime('later'), /unreadable CPU time/);
  });
});

describe('chromeProcessType', () => {
  it('names the helper kinds off their own --type flag', () => {
    assert.equal(chromeProcessType('/path/Google Chrome Helper --type=renderer --lang=en'), 'renderer');
    assert.equal(chromeProcessType('/path/Google Chrome Helper (GPU) --type=gpu-process'), 'gpu-process');
    assert.equal(chromeProcessType('/path/Google Chrome Helper --type=utility --utility-sub-type=x'), 'utility');
  });

  it('calls the process with no --type the browser process, because that is what it is', () => {
    assert.equal(
      chromeProcessType('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new'),
      'browser',
    );
  });
});

const PS_OUTPUT = [
  '    1     0   0:30.00 /sbin/launchd',
  '  100     1   0:04.00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --user-data-dir=/tmp/cdp-a',
  '  101   100   1:00.00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper --type=renderer',
  '  102   100   0:30.00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper (GPU) --type=gpu-process',
  '  103   101   0:06.00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper --type=utility',
  '  200     1   9:99.00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/Library/Chrome',
  '  201   200   9:00.00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper --type=renderer',
].join('\n');

describe('parseProcessTable', () => {
  it('splits the fixed columns off a command that itself contains spaces', () => {
    const rows = parseProcessTable(PS_OUTPUT);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows[1], {
      pid: 100,
      ppid: 1,
      cpuSeconds: 4,
      command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --user-data-dir=/tmp/cdp-a',
    });
  });

  it('ignores blank lines rather than producing a row that parses to nothing', () => {
    assert.equal(parseProcessTable('\n\n').length, 0);
  });
});

describe('treeCpu', () => {
  const rows = parseProcessTable(PS_OUTPUT);

  /**
   * ⭐ pid 103 is a grandchild, and it is in the fixture because Chrome's utilities are reparented
   * under a renderer rather than under the browser process. Summing direct children only would drop
   * it, and the result would still look like a reasonable number.
   */
  it('sums the whole descendant tree, not just direct children', () => {
    const seen = treeCpu(rows, 100);
    assert.equal(seen.totalSeconds, 4 + 60 + 30 + 6);
    assert.equal(seen.processCount, 4);
  });

  /**
   * ⛔⛔ The operator's own Chrome is the confound this instrument would be most embarrassed by. It
   * shares an executable path and a process name with ours, so any match-by-name approach charges
   * their tab count to our measurement. Descending from the PID we spawned is the only thing that
   * cannot make that mistake.
   */
  it('excludes a Chrome the harness did not launch', () => {
    const seen = treeCpu(rows, 100);
    assert.equal(seen.processCount, 4, 'pids 200 and 201 are somebody else Chrome');
    assert.ok(!Object.hasOwn(seen.byType, 'nothing'));
  });

  it('breaks the total down by helper kind, so a renderer-bound run is distinguishable', () => {
    assert.deepEqual(treeCpu(rows, 100).byType, {
      browser: 4,
      renderer: 60,
      'gpu-process': 30,
      utility: 6,
    });
  });

  it('reports zero for a root that has already exited rather than throwing', () => {
    assert.deepEqual(treeCpu(rows, 999), { totalSeconds: 0, processCount: 0, byType: {} });
  });
});

describe('readMetrics', () => {
  /** The shape `Performance.getMetrics` answers with: a flat array of name/value pairs. */
  const stubClient = (metrics) => ({
    send: async (method) => {
      if (method === 'Performance.enable') {
        return {};
      }
      if (method === 'Performance.getMetrics') {
        return { metrics };
      }
      throw new Error(`unexpected ${method}`);
    },
  });

  it('picks the metrics of interest out by name', async () => {
    const seen = await readMetrics(
      stubClient([
        { name: 'Timestamp', value: 1000 },
        { name: 'TaskDuration', value: 12.5 },
        { name: 'ThreadTime', value: 9.5 },
        { name: 'JSHeapUsedSize', value: 4096 },
        { name: 'LayoutCount', value: 3 },
      ]),
    );
    assert.equal(seen.TaskDuration, 12.5);
    assert.equal(seen.ThreadTime, 9.5);
    assert.equal(seen.JSHeapUsedSize, 4096);
    assert.ok(!('LayoutCount' in seen), 'only the named ones are carried');
  });

  /**
   * ⚠️ Chrome's metric names are not a contract and this runs against whatever Chrome the host has.
   * A missing name has to arrive as null, so the run reports "Chrome did not supply this" instead of
   * a zero that reads as "the page did no work".
   */
  it('reports a metric this Chrome did not supply as null, never as zero', async () => {
    const seen = await readMetrics(stubClient([{ name: 'TaskDuration', value: 7 }]));
    assert.equal(seen.TaskDuration, 7);
    for (const name of METRICS_OF_INTEREST) {
      if (name !== 'TaskDuration') {
        assert.equal(seen[name], null, `${name} should be null, not 0`);
      }
    }
  });
});

/**
 * ⭐⭐ THE WINDOW SPLIT IS THE FINDING, NOT THE FORMATTING, WHICH IS WHY IT IS TESTED.
 *
 * A cold bee gateway burned 14x its settled CPU for thirty seconds and then stopped dead. Averaged
 * over a twelve-minute run that burst is 0.6% of the denominator and vanishes. The fixture below is
 * that shape on purpose: a hot startup, then a quiet plateau, and the assertion is that the two are
 * reported apart and that the whole-run average agrees with neither.
 */
const SAMPLES = [
  { atS: 0, cpuSeconds: 0, taskDuration: 0, heapMB: 30 },
  { atS: 5, cpuSeconds: 4, taskDuration: 3.5, heapMB: 90 },
  { atS: 10, cpuSeconds: 7, taskDuration: 6.0, heapMB: 120 },
  { atS: 20, cpuSeconds: 8, taskDuration: 6.6, heapMB: 140 },
  { atS: 30, cpuSeconds: 9, taskDuration: 7.2, heapMB: 135 },
];

describe('coresBetween', () => {
  it('is CPU seconds per wall second, which is already a core count', () => {
    assert.equal(coresBetween({ atS: 0, cpuSeconds: 0 }, { atS: 5, cpuSeconds: 4 }), 0.8);
  });

  it('answers null rather than 0 where the pair cannot say', () => {
    assert.equal(coresBetween(undefined, { atS: 5, cpuSeconds: 4 }), null);
    assert.equal(coresBetween({ atS: 5, cpuSeconds: 4 }, { atS: 5, cpuSeconds: 9 }), null);
  });
});

describe('windowRates', () => {
  it('rates only the samples inside the window', () => {
    assert.deepEqual(windowRates(SAMPLES, 10, 30), {
      wallS: 20,
      cores: 0.1,
      mainThreadUtilization: 0.06,
      peakHeapMB: 140,
    });
  });

  it('reports a window too short to rate as null rather than as idle', () => {
    assert.deepEqual(windowRates(SAMPLES, 30, 30), {
      wallS: 0,
      cores: null,
      mainThreadUtilization: null,
      peakHeapMB: null,
    });
  });

  it('carries a main-thread reading through as null when Chrome supplied no TaskDuration', () => {
    const blind = SAMPLES.map((sample) => ({ ...sample, taskDuration: null }));
    const seen = windowRates(blind, 0, 30);
    assert.equal(seen.mainThreadUtilization, null);
    assert.equal(seen.cores, 0.3, 'the process tree still answers');
  });
});

describe('summarizeCpu', () => {
  const table = summarizeCpu({
    idle: { seconds: 0.4, windowS: 10 },
    firstPlayheadAtS: 10,
    samples: SAMPLES,
  });

  it('separates the startup burst from the steady state', () => {
    assert.equal(table['startup, to first frame'].cores, 0.7);
    assert.equal(table['steady, playing'].cores, 0.1);
  });

  /** ⛔ The number a run would have reported without the split, kept visible so it cannot be quoted alone. */
  it('shows the whole-run average agreeing with neither, which is the point', () => {
    assert.equal(table['whole run'].cores, 0.3);
  });

  it('carries the empty-Chrome floor so the page cost is separable from the browser cost', () => {
    assert.equal(table['idle, about:blank'].cores, 0.04);
  });

  it('falls back to the last sample when no frame ever played', () => {
    const stalled = summarizeCpu({ idle: null, firstPlayheadAtS: null, samples: SAMPLES });
    assert.equal(stalled['startup, to first frame'].cores, 0.3, 'the whole run was startup');
    assert.equal(stalled['steady, playing'].cores, null);
    assert.equal(stalled['idle, about:blank'].cores, null);
  });
});
