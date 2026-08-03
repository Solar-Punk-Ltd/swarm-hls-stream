/**
 * `pnpm bench:recipe` — measure how often the publish recipe actually produces segments, against the
 * `-re` form it replaced.
 *
 * Exists because the reason `wallclockPublisher.ts` paces with the `realtime` filters instead of
 * `-re` is a success *rate*, and a rate is the one kind of claim a unit test cannot hold. The tests
 * next to that file assert which flags are present; they cannot assert that the flags work half the
 * time, which is exactly what was wrong before. Without this script the figure quoted in that file,
 * in its test, and in the register is an assertion nobody can check.
 *
 * Costs nothing but time: it muxes to a local temporary directory and never touches a deployment or
 * a postage stamp.
 *
 * **A clean `-re` column does not clear `-re`, and running this on an idle machine will produce
 * one.** The failure is load-sensitive, which fits the mechanism: `-re` sleeps on a comparison
 * against an absolute epoch timestamp, and whether it latches a usable reference first is a race
 * between the two input threads that contention decides. Measured on 2026-08-03: at 1-minute load
 * averages around 8 to 13 the `-re` form produced segments in 2 of 5 and then 3 of 6 runs, while the
 * shipping recipe was 5 of 5 and 6 of 6 including a run at load 13.3. Re-measured at load 4.1, both
 * forms went 5 of 5.
 *
 * So the honest reading is not that `-re` never works. It is that `-re` degrades under contention
 * and the filters do not, and a benchmark that stops producing segments when the machine is busy is
 * useless precisely when a latency measurement is most interesting. To see the difference, run this
 * against a loaded machine and raise `RECIPE_TRIALS`.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_KNOBS, wallclockEncodeArgs } from '../src/bench/wallclockPublisher.js';
import { startFfmpeg } from '../src/harness/ffmpegProcess.js';

/** Long enough for several segments at a 2s target, short enough that a broken recipe costs little. */
const WINDOW_MS = 12_000;
const SEGMENT_SECONDS = 2;
/** Small frames: this measures whether segments appear at all, not how much is encoded. */
const SIZE = '320x240';
const DEFAULT_TRIALS = 5;

interface Trial {
  segments: number;
  firstSegmentMs: number | null;
}

/**
 * The recipe as it ships, and the one it replaced.
 *
 * The `-re` variant is derived from the shipping arguments rather than written out, so that a future
 * change to the encode is compared against itself and this script cannot drift into measuring a
 * recipe nobody uses.
 */
function withReInsteadOfFilters(args: readonly string[]): string[] {
  const withoutFilters = args.filter((arg, i) => {
    const previous = args[i - 1];
    return !(arg === '-vf' || arg === '-af' || previous === '-vf' || previous === '-af');
  });
  return withoutFilters.flatMap((arg) => (arg === '-use_wallclock_as_timestamps' ? ['-re', arg] : [arg]));
}

async function runTrial(encodeArgs: readonly string[]): Promise<Trial> {
  const dir = await mkdtemp(join(tmpdir(), 'recipe-reliability-'));
  try {
    const proc = startFfmpeg([
      ...encodeArgs,
      '-f',
      'hls',
      '-hls_time',
      String(SEGMENT_SECONDS),
      '-hls_flags',
      'independent_segments',
      '-hls_segment_filename',
      join(dir, 's%d.ts'),
      join(dir, 'probe.m3u8'),
    ]);
    const startedAtMs = Date.now();
    let firstSegmentMs: number | null = null;

    while (Date.now() - startedAtMs < WINDOW_MS) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (firstSegmentMs === null && (await countSegments(dir)) > 0) {
        firstSegmentMs = Date.now() - startedAtMs;
      }
    }
    const segments = await countSegments(dir);
    await proc.stop();
    return { segments, firstSegmentMs };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function countSegments(dir: string): Promise<number> {
  return (await readdir(dir)).filter((name) => /^s\d+\.ts$/.test(name)).length;
}

function summarise(label: string, trials: readonly Trial[]): string {
  const produced = trials.filter((trial) => trial.segments > 0);
  const firsts = produced.map((trial) => `${((trial.firstSegmentMs ?? 0) / 1_000).toFixed(1)}s`);
  return (
    `${label.padEnd(22)} ${produced.length} of ${trials.length} produced segments` +
    (firsts.length > 0 ? `, first at ${firsts.join(' / ')}` : '')
  );
}

async function main(): Promise<void> {
  const trials = Number(process.env.RECIPE_TRIALS ?? DEFAULT_TRIALS);
  const shipping = wallclockEncodeArgs({ ...DEFAULT_KNOBS, size: SIZE });
  const previous = withReInsteadOfFilters(shipping);

  console.log(`recipe: ${trials} trial(s) each, ${WINDOW_MS}ms window, ${SEGMENT_SECONDS}s segments\n`);

  const results = new Map<string, Trial[]>();
  for (const [label, args] of [
    ['realtime filters', shipping],
    ['-re (replaced)', previous],
  ] as const) {
    const runs: Trial[] = [];
    for (let i = 0; i < trials; i++) {
      runs.push(await runTrial(args));
    }
    results.set(label, runs);
    console.log(summarise(label, runs));
  }

  const shippingRuns = results.get('realtime filters') ?? [];
  if (shippingRuns.some((trial) => trial.segments === 0)) {
    console.error('\nthe shipping recipe failed to produce segments in at least one trial, which is the defect');
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`recipe reliability failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
