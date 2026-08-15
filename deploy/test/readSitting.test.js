import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const READER = join(ROOT, 'deploy/scripts/read-sitting.py');

/**
 * That a sitting is refused rather than summarised when its arms were not delivered at the profile
 * the sitting claims to be measuring.
 *
 * ⛔⛔⛔ A RUN ON A STARVED ENCODER MEASURES THE STARVATION, AND IT LOOKS EXACTLY LIKE A RESULT.
 *
 * On 2026-08-05 three of four 1080p rows delivered ~26.5fps against a requested 30: the packet count
 * per segment was right for the GOP every time while the declared duration ran ~13% long, so the
 * encoder was falling behind real time rather than dropping frames. A viewer decoding 26.5 frames a
 * second is doing 12% less work than one decoding 30, and on the main-thread axis that reads as a
 * CHEAPER viewer. The saturation question this reader exists to answer would have been answered in
 * the wrong direction, with every other column looking healthy.
 *
 * ⛔⛔ AND THE GUARD THAT ALREADY EXISTED WOULD NOT HAVE CAUGHT IT. `phase06-light-vs-ultralight.sh`
 * checks delivered segment LENGTH against the request and admits anything from 0.7x to 1.4x, so a
 * 13% stretch passes it comfortably. The frame rate is the sharp instrument for this failure, which
 * is why it is the one gated here.
 *
 * ⛔ The spend has already happened by the time anything here runs, so what this protects is not the
 * money, it is the CLAIM. A non-zero exit and a withheld headline is the whole mechanism.
 */

const cleanups = [];

after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

/**
 * @typedef {{ arm: number, round: number, cond: string, fps: number | null,
 *             resolution?: string, thread?: number }} ArmFixture
 */

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'read-sitting-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function watchStem(arm) {
  return `browser-watch-2026-08-15T00-0${arm}-00-000Z`;
}

/**
 * The sampler's file, whose summary line is where the main-thread mean is read from.
 *
 * ⚠️ The step is 40s so that twelve samples SPAN THE ARM. A fixture whose series covered 55s of a
 * 360s watch was the shape of a sampler that died four minutes in, and the reader now refuses that.
 */
const THREAD_STEP_S = 40;

function writeMainThread(metricsDir, arm, thread) {
  const rows = [];
  for (let sample = 0; sample < 12; sample++) {
    rows.push(
      JSON.stringify({
        Timestamp: 1000 + sample * THREAD_STEP_S,
        TaskDuration: sample * THREAD_STEP_S * thread,
        ScriptDuration: sample * 0.1,
        ThreadTime: sample * THREAD_STEP_S * thread,
        ProcessTime: sample * THREAD_STEP_S * thread * 4,
        JSHeapUsedSize: 6_000_000 + sample * 1000,
      }),
    );
  }
  rows.push(
    JSON.stringify({
      summary: {
        samples: 12,
        usable: 12,
        wallS: arm.wallS ?? 11 * THREAD_STEP_S,
        mean: thread,
        peak: thread * 2,
        complete: true,
        stoppedBecause: arm.stoppedBecause ?? null,
        // A sitting recorded before the rename still has to be readable.
        ...(arm.legacyStoppedEarly ? { stoppedEarly: arm.legacyStoppedEarly } : {}),
      },
    }),
  );
  writeFileSync(
    join(metricsDir, `arm${String(arm.arm).padStart(2, '0')}-round${arm.round}-${arm.cond}-mainthread.jsonl`),
    `${rows.join('\n')}\n`,
  );
}

const WINDOW_S = 360;
const SETTLE_S = 60;

/**
 * A watch document shaped like the browser leaves one.
 *
 * ⭐ `decodedFrames` opens at the settle's tally rather than at zero, because that is what a real
 * arm's first sample carries and it is the whole reason the reader recomputes the rate instead of
 * reading `summary.deliveredFps`. That field is left deliberately WRONG here, at the inflated value
 * a pre-fix browser wrote, so a reader that trusts it fails these tests.
 */
function watch(arm) {
  const settled = Math.round(SETTLE_S * 30);
  const gained = Math.round(arm.fps * WINDOW_S);
  const samples = [
    { atMs: 0, decodedFrames: settled },
    { atMs: WINDOW_S * 1000, decodedFrames: settled + gained },
  ];
  return {
    samples,
    summary: {
      spanMs: WINDOW_S * 1000,
      deliveredFps: (settled + gained) / WINDOW_S,
      resolution: arm.resolution ?? '1920×1080',
      stalledSamples: 0,
      overallAdvanceRatio: 1.0,
    },
  };
}

/**
 * A sitting directory shaped like the driver leaves one, plus the `docs/bench` the driver writes its
 * per-arm watch summaries into.
 *
 * @param {ArmFixture[]} arms
 * @param {string} requested resolution the sitting header says it asked the publisher for
 */
function sitting(arms, requested = '1920x1080') {
  const dir = workspace();
  const metrics = join(dir, 'node-metrics');
  const bench = join(dir, 'docs', 'bench');
  mkdirSync(metrics, { recursive: true });
  mkdirSync(bench, { recursive: true });

  const lines = [`[00:36:21]   one LIVE broadcast of 76 min at a 0.5s GOP, ${requested} at 6000 kbps`];
  for (const arm of arms) {
    const thread = arm.thread ?? (arm.cond === 'weeb3' ? 0.225 : 0.072);
    lines.push(
      `[00:4${arm.arm}:00] arm ${arm.arm} (round ${arm.round}): segment bytes from ${arm.cond}, watching 360s`,
      '  CPU: 72 samples, mean 1.13 cores, peak 2.04 cores',
      '      retrieval requests                         40324',
      '  held at 2.0s target, max 3.0s, stallCount 0',
      '  2.26s behind live, 3 rebuffers, 0 stalled samples',
    );
    if (arm.fps !== null) {
      lines.push(`browser: wrote /repo/docs/bench/${watchStem(arm.arm)}.md`);
      writeFileSync(join(bench, `${watchStem(arm.arm)}.json`), JSON.stringify(watch(arm)));
    }
    writeMainThread(metrics, arm, thread);
  }
  writeFileSync(join(dir, 'byte-source-arms.log'), `${lines.join('\n')}\n`);
  return dir;
}

/** Runs the reader with `docs/bench` pointed at the fixture rather than at the real checkout. */
async function table(dir) {
  try {
    const { stdout } = await run('python3', [READER, 'table', dir], {
      env: { ...process.env, SITTING_BENCH_DIR: join(dir, 'docs', 'bench') },
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '' };
  }
}

/** Four healthy arms, one warm-up round then one counted round, both conditions in each. */
function healthyArms() {
  return [
    { arm: 1, round: 1, cond: 'gateway', fps: 30.1 },
    { arm: 2, round: 1, cond: 'weeb3', fps: 30.0 },
    { arm: 3, round: 2, cond: 'gateway', fps: 30.2 },
    { arm: 4, round: 2, cond: 'weeb3', fps: 29.9 },
  ];
}

describe('the delivered frame rate is a column, not an assumption', () => {
  it('names what each arm actually delivered, so a starved arm is visible without opening a file', async () => {
    const { code, stdout } = await table(sitting(healthyArms()));

    assert.equal(code, 0);
    for (const fps of ['30.1', '30.0', '30.2', '29.9']) {
      assert.match(stdout, new RegExp(fps.replace('.', '\\.')), `arm delivering ${fps}fps is missing from the table`);
    }
  });

  it('summarises a sitting whose arms all held the requested rate', async () => {
    const { code, stdout } = await table(sitting(healthyArms()));

    assert.equal(code, 0);
    assert.match(stdout, /MAIN THREAD mean/);
  });
});

describe('an arm not delivered at the requested profile voids the headline', () => {
  it('refuses the 2026-08-05 failure: 26.5fps against a requested 30', async () => {
    const arms = healthyArms();
    arms[2].fps = 26.5;

    const { code, stdout } = await table(sitting(arms));

    assert.notEqual(code, 0, 'a counted arm at 26.5fps against 30 must not exit zero');
    assert.doesNotMatch(
      stdout,
      /MAIN THREAD mean/,
      'no ratio may be printed from arms that were not delivered at the profile',
    );
    assert.match(stdout, /26\.5/);
  });

  // ⛔ The segment-length guard in phase06 admits 0.7x to 1.4x, and 26.5/30 is 0.883, so the historical
  // failure sits comfortably INSIDE it. Pinning the tolerance here is what stops somebody widening
  // this one to match that one.
  it('is tight enough that the historical shortfall could never be inside it', async () => {
    const arms = healthyArms();
    arms[2].fps = 30 * 0.93;

    const { code } = await table(sitting(arms));

    assert.notEqual(code, 0, 'a 7% shortfall must already be refused, the historical case was 12%');
  });

  it('does not void a sitting for a warm-up arm, which is discarded anyway', async () => {
    const arms = healthyArms();
    arms[0].fps = 26.5;

    const { code, stdout } = await table(sitting(arms));

    assert.equal(code, 0, 'warm-up arms are not read, so their frame rate cannot void the sitting');
    assert.match(stdout, /MAIN THREAD mean/);
  });

  it('refuses an arm delivered at a resolution the sitting did not ask for', async () => {
    const arms = healthyArms();
    arms[3].resolution = '1280×720';

    const { code, stdout } = await table(sitting(arms));

    assert.notEqual(code, 0, 'a 720p arm inside a 1080p sitting is a different configuration under this one name');
    assert.doesNotMatch(stdout, /MAIN THREAD mean/);
  });

  /**
   * ⛔⛔⛔ THE READING THE SUMMARY ITSELF GOT WRONG, AND THE REASON THIS RECOMPUTES.
   *
   * `summary.deliveredFps` counted every frame decoded since playback began over the window's media
   * alone, so a healthy 30fps six-minute arm wrote 35.0 into its own summary. A guard reading that
   * field would admit a starved encoder at 26.5, which reports 30.9 the same way. Every fixture here
   * carries that inflated value, so a reader that trusts the summary passes this arm and fails.
   */
  it('reads the arm rather than the summary, which counted the settle in its own numerator', async () => {
    const arms = healthyArms();
    arms[2].fps = 26.5;

    const { code, stdout } = await table(sitting(arms));

    assert.notEqual(code, 0, 'the summary says 30.9 for this arm and the samples say 26.5');
    assert.match(stdout, /26\.5/);
  });

  // ⛔⛔ "I could not find it" and "there is nothing wrong with it" are the same return value, and
  // treating them alike is how #41 shipped. An arm whose watch summary never landed has an UNKNOWN
  // frame rate, and unknown is refused here for the same reason a shortfall is.
  it('refuses an arm whose watch summary is missing rather than reading it as healthy', async () => {
    const arms = healthyArms();
    arms[2].fps = null;

    const { code, stdout } = await table(sitting(arms));

    assert.notEqual(code, 0, 'an arm with no delivered frame rate must not pass the guard by default');
    assert.doesNotMatch(stdout, /MAIN THREAD mean/);
  });
});

/**
 * That a quantile ratio says how many samples stand behind it, and refuses to be read as a finding
 * when the answer is three.
 *
 * ⛔⛔⛔ THIS EXISTS BECAUSE I NEARLY PUBLISHED FROM THREE WINDOWS, ON 2026-08-15.
 *
 * Comparing the 720p and 1080p sittings, p99 moved 1.03x while p90 moved 1.60x, which reads as a
 * tail that bitrate does not touch and would have been a mechanism worth a paid sitting to chase.
 * With 253 pooled intervals per condition, p99 is the third-highest value. The apparent invariance
 * was three windows, and the same check killed a second claim in the same pass: "the crest factor is
 * compressing" was mean-against-max, and p90/p50 is 1.129 against 1.105, unchanged.
 *
 * ⭐ What survived is stronger than either guess. Every quantile from q25 to q90 moves by ONE factor,
 * 1.60x to 1.64x for the in-tab path against 2.40x the bytes, so the distribution scales uniformly
 * rather than changing shape. A uniform scaling is what makes the exponent worth measuring.
 */
describe('a quantile ratio carries the count it rests on', () => {
  /** 200 intervals at one utilisation plus a single much larger spike, so a high quantile lands on
   * the spike and a low one does not. */
  function armAt(dir, arm, utilisation) {
    const rows = [];
    let work = 0;
    for (let sample = 0; sample <= 200; sample++) {
      if (sample > 0) {
        work += 5 * (sample === 200 ? utilisation * 10 : utilisation);
      }
      rows.push(
        JSON.stringify({
          Timestamp: sample * 5,
          TaskDuration: Number(work.toFixed(6)),
          ProcessTime: sample * 5 * utilisation * 4,
          JSHeapUsedSize: 6_000_000,
        }),
      );
    }
    writeFileSync(
      join(dir, `arm${String(arm).padStart(2, '0')}-round2-weeb3-mainthread.jsonl`),
      `${rows.join('\n')}\n`,
    );
  }

  function sittingFor(utilisation) {
    const dir = workspace();
    const metrics = join(dir, 'node-metrics');
    mkdirSync(metrics, { recursive: true });
    armAt(metrics, 3, utilisation);
    writeFileSync(
      join(dir, 'byte-source-arms.log'),
      '[00:00:00]   one LIVE broadcast of 40 min at a 0.5s GOP, 1280x720 at 2500 kbps\n' +
        '[00:01:00] arm 3 (round 2): segment bytes from weeb3, watching 360s\n',
    );
    return dir;
  }

  async function shape(dirs) {
    try {
      const { stdout } = await run('python3', [READER, 'shape', ...dirs]);
      return stdout;
    } catch (error) {
      return error.stdout ?? '';
    }
  }

  it('prints how many samples sit above each quantile it compares', async () => {
    const out = await shape([sittingFor(0.2), sittingFor(0.4)]);

    assert.match(out, /samples/i, 'a ratio with no count behind it is what caused this test to exist');
    assert.match(out, /0\.250/, 'the low quantiles are where the robust ratios live');
  });

  it('marks a quantile too thin to read as a distribution', async () => {
    const out = await shape([sittingFor(0.2), sittingFor(0.4)]);
    const thin = out.split('\n').filter((line) => line.includes('0.990'));

    assert.equal(thin.length > 0, true, 'p99 has to appear, since hiding it is not the fix');
    assert.ok(
      thin.every((line) => /thin/i.test(line)),
      'p99 over 200 intervals rests on two samples and must say so',
    );
  });
});

/**
 * That the host, rather than the session ageing, can be ruled out as the cause of a within-arm creep.
 *
 * ⛔⛔⛔ THE TWO SERIES DO NOT SHARE A CLOCK, AND JOINING THEM WRONG FAILS QUIETLY.
 * `*-mainthread.jsonl` carries CDP's monotonic `Timestamp`; `sample-NNNN.json` carries epoch `atMs`.
 * The two differ by the host's boot time, about 234 million seconds here. A reader that joins on the
 * raw numbers pairs every thread reading with whichever single sample is nearest, which is always the
 * same one, and then reports a sensitivity of exactly zero. Zero is also the answer a healthy host
 * gives, so the defect and the finding are the same output.
 *
 * ⭐ So the fixture plants a sensitivity and makes host load ZIG-ZAG rather than drift. A join that is
 * out by one sampling interval recovers the planted slope with its sign REVERSED, which no amount of
 * reading a summary would catch.
 */
describe('whether host load could account for a creep', () => {
  const MONOTONIC_START = 20_000_000;
  const EPOCH_START = 1_786_000_000;
  const ARM_SECONDS = 360;
  const THREAD_INTERVAL_S = 5;
  const SAMPLE_INTERVAL_S = 30;
  const BASE_UTILISATION = 0.2;
  const PLANTED_SENSITIVITY = 0.002;
  const loadAt = (sample) => 10 + 10 * (sample % 2);

  function loadSitting(arms, { sampleSpanS = ARM_SECONDS, writeSeries = true } = {}) {
    const dir = workspace();
    const metrics = join(dir, 'node-metrics');
    mkdirSync(metrics, { recursive: true });
    const lines = ['[00:36:21]   one LIVE broadcast of 76 min at a 0.5s GOP, 1280x720 at 2500 kbps'];

    for (const arm of arms) {
      const stem = `arm${String(arm.arm).padStart(2, '0')}-round${arm.round}-${arm.cond}`;
      const rows = [];
      let cumulative = 0;
      for (let i = 0; i * THREAD_INTERVAL_S <= ARM_SECONDS; i++) {
        if (i > 0) {
          // The interval's midpoint decides which sample it belongs to, which is what the join must
          // reproduce from two clocks that share no origin.
          const midpoint = (i - 0.5) * THREAD_INTERVAL_S;
          const sample = Math.round(midpoint / SAMPLE_INTERVAL_S);
          cumulative += THREAD_INTERVAL_S * (BASE_UTILISATION + PLANTED_SENSITIVITY * loadAt(sample));
        }
        rows.push(
          JSON.stringify({
            Timestamp: MONOTONIC_START + i * THREAD_INTERVAL_S,
            TaskDuration: cumulative,
          }),
        );
      }
      rows.push(JSON.stringify({ summary: { samples: rows.length, complete: true } }));
      writeFileSync(join(metrics, `${stem}-mainthread.jsonl`), `${rows.join('\n')}\n`);

      if (writeSeries) {
        const series = join(metrics, `${stem}-series`);
        mkdirSync(series, { recursive: true });
        const count = Math.floor(sampleSpanS / SAMPLE_INTERVAL_S);
        for (let j = 0; j <= count; j++) {
          writeFileSync(
            join(series, `sample-${String(j + 1).padStart(4, '0')}.json`),
            JSON.stringify({
              label: `${stem}-${j + 1}`,
              atMs: (EPOCH_START + (j * sampleSpanS) / count) * 1000,
              hostLoad: `${loadAt(j).toFixed(2)} 9.00 8.00`,
            }),
          );
        }
      }
      lines.push(
        `[00:4${arm.arm}:00] arm ${arm.arm} (round ${arm.round}): segment bytes from ${arm.cond}, watching 360s`,
      );
    }
    writeFileSync(join(dir, 'byte-source-arms.log'), `${lines.join('\n')}\n`);
    return dir;
  }

  async function loadRead(dir, creep) {
    const argv = [READER, 'load', dir, ...(creep === undefined ? [] : [String(creep)])];
    try {
      const { stdout } = await run('python3', argv);
      return { code: 0, stdout };
    } catch (error) {
      return { code: error.code ?? 1, stdout: error.stdout ?? '' };
    }
  }

  const counted = [{ arm: 3, round: 2, cond: 'weeb3' }];

  it('recovers a planted sensitivity across clocks that share no origin', async () => {
    const result = await loadRead(loadSitting(counted));
    const row = result.stdout.split('\n').find((line) => line.includes('arm03'));

    assert.ok(row, result.stdout);
    const recovered = Number(row.trim().split(/\s+/).at(-2));
    assert.ok(
      Math.abs(recovered - PLANTED_SENSITIVITY) < 0.0002,
      `recovered ${recovered} for a planted ${PLANTED_SENSITIVITY}; a join on the raw clocks reads 0 and one interval out reads the negative`,
    );
  });

  it('refuses to align two series that cannot be the same window', async () => {
    const result = await loadRead(loadSitting(counted, { sampleSpanS: 900 }));

    assert.match(result.stdout, /no usable load series/);
    assert.doesNotMatch(result.stdout, /dU\/dLoad = /);
  });

  it('says the series is missing rather than reporting a sensitivity of zero', async () => {
    const result = await loadRead(loadSitting(counted, { writeSeries: false }));

    assert.match(result.stdout, /no usable load series/);
  });

  it('leaves warm-up arms out, as every other view of a sitting does', async () => {
    const result = await loadRead(
      loadSitting([
        { arm: 1, round: 1, cond: 'weeb3' },
        { arm: 3, round: 2, cond: 'weeb3' },
      ]),
    );

    assert.doesNotMatch(result.stdout, /arm01/);
    assert.match(result.stdout, /arm03/);
  });

  it('turns a creep into the load rise that would be needed to fake it', async () => {
    const result = await loadRead(loadSitting(counted), 0.034);

    assert.match(result.stdout, /to fake \+0\.034 cores\/hr, host load would have to rise \d+ units per hour/);
  });

  it('says nothing about faking a creep when no creep was named', async () => {
    const result = await loadRead(loadSitting(counted));

    assert.doesNotMatch(result.stdout, /to fake/);
  });
});

/**
 * That a thread series covering part of an arm cannot be read as covering the arm.
 *
 * ⛔⛔⛔ THE SUMMARY'S `complete` FLAG DOES NOT MEAN THIS AND READS EXACTLY LIKE IT. It reports
 * whether every scriptable target was sampled. A sampler whose CDP connection dies mid-arm still runs
 * its `finally`, writes `complete: true` beside a short `wallS`, and leaves a well-formed series.
 *
 * ⚠️ Worth a gate only because of arm LENGTH. Every arm this had ever run on was six minutes, where a
 * truncation is a small error. #106 is a three-hour arm whose whole output is a slope, and forty
 * minutes of it fitted and published as three hours is a wrong number with nothing marking it.
 */
describe('a thread series that does not span its arm', () => {
  it('refuses a counted arm whose sampler stopped a fraction of the way in', async () => {
    const arms = healthyArms();
    const result = await table(sitting(arms.map((arm) => (arm.arm === 3 ? { ...arm, wallS: 80 } : arm))));

    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /does not span the arm it is labelled with/);
    assert.match(result.stdout, /arm 3 \(gateway\): covered 80s of 360s/);
  });

  /**
   * ⛔⛔⛔ THE ROLLBACK OF A GATE I WROTE THE SAME NIGHT, AND WHY IT IS NOT MOTIVATED REASONING.
   *
   * This first refused on the recorded reason alone. The 2026-08-15 three-hour arm sampled 10863s of a
   * 10800s watch, every second of its own window, and was refused because the sampler's loop had ended
   * when the browser container was torn down. That teardown races the stop file and wins about half the
   * time, so a perfectly healthy arm records a reason.
   *
   * ⚠️ Loosening a gate so one's own data passes is exactly the move this suite exists to prevent, so
   * the argument stands without that arm: the stated harm is a slope fitted over PART of an arm and
   * published as the whole, coverage is what measures that, and a reason cannot, because a normal
   * ending produces one.
   */
  it('does not refuse a full-length arm just because the sampler recorded why it ended', async () => {
    const arms = healthyArms();
    const result = await table(
      sitting(arms.map((arm) => (arm.arm === 4 ? { ...arm, stoppedBecause: 'CDP socket is not open' } : arm))),
    );

    assert.equal(result.code, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /does not span the arm/);
  });

  it('names the recorded reason when the arm IS short, since that is when it explains something', async () => {
    const arms = healthyArms();
    const result = await table(
      sitting(arms.map((arm) => (arm.arm === 4 ? { ...arm, wallS: 80, stoppedBecause: 'websocket closed' } : arm))),
    );

    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /arm 4 \(weeb3\): covered 80s of 360s \(websocket closed\)/);
  });

  it('still reads the reason off a sitting recorded before the field was renamed', async () => {
    const arms = healthyArms();
    const result = await table(
      sitting(arms.map((arm) => (arm.arm === 4 ? { ...arm, wallS: 80, legacyStoppedEarly: 'old key' } : arm))),
    );

    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /arm 4 \(weeb3\): covered 80s of 360s \(old key\)/);
  });

  it('accepts the normal case, where the series runs longer than the watch window', async () => {
    // The sampler opens with the arm and closes at the stop file, so it also covers the settle.
    const result = await table(sitting(healthyArms()));

    assert.equal(result.code, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /does not span the arm/);
  });

  it('does not void a sitting for a truncated warm-up arm, which is discarded anyway', async () => {
    const arms = healthyArms();
    const result = await table(sitting(arms.map((arm) => (arm.arm === 1 ? { ...arm, wallS: 80 } : arm))));

    assert.equal(result.code, 0, result.stdout);
  });

  it('prints the coverage of every arm, so a near miss is visible before it becomes a refusal', async () => {
    const result = await table(sitting(healthyArms()));

    assert.match(result.stdout, /cover/);
    assert.match(result.stdout, /1\.22/);
  });
});
