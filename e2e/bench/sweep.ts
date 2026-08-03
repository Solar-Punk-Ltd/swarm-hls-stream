/**
 * `pnpm bench:sweep-report` — read every run in `docs/bench/` and print the grid.
 *
 * Reads artifacts only. It spends nothing, touches no deployment, and can be re-run against a sweep
 * that finished hours ago, which is the point of the runs carrying their own instants.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BenchRun } from '../src/bench/report.js';
import { type BufferSample, type GridRow, median, recommendBufferMs } from '../src/bench/sweepAnalysis.js';
import { ROOT_DIR } from '../src/config.js';

const REPORT_DIR = join(ROOT_DIR, 'docs', 'bench');
/** What the bench polls the feed at, which is the cadence its `visibleAt` instants were taken under. */
const POLL_INTERVAL_MS = 2_000;

function seconds(ms: number): string {
  return `${(ms / 1_000).toFixed(2)}s`;
}

/**
 * Runs are grouped by what they actually produced rather than by what they asked for.
 *
 * The GOP is a request and the segment is the result, and they differ whenever the engine's fragment
 * does not divide it. Grouping on the request would merge two settings that produced different
 * segments, which is the one thing a latency grid must not do.
 */
function settingLabel(run: BenchRun): string {
  const segmentMs = median(run.samples.map((sample) => sample.split.hops.find((h) => h.name === 'segment')!.ms));
  return `segment ${(segmentMs / 1_000).toFixed(2)}s (gop ${run.knobs.gopSeconds}s, ${run.knobs.videoBitrateKbps}kbps)`;
}

/**
 * Runs taken before the media-timeline correction existed, which cannot share a grid with runs taken
 * after it.
 *
 * They report about 1.4s less latency than they measured, and their `upload` hop is negative on every
 * sample, so averaging them in moves a row by more than most of the knobs do. `mediaTimelineLeadMs`
 * is absent on those artifacts and non-zero on every corrected one, which is the whole reason it is
 * written into the file rather than only printed.
 */
function isCorrected(run: BenchRun): boolean {
  return typeof run.mediaTimelineLeadMs === 'number' && run.mediaTimelineLeadMs > 0;
}

async function loadRuns(): Promise<{ runs: BenchRun[]; uncorrected: number }> {
  const names = (await readdir(REPORT_DIR)).filter((name) => name.startsWith('latency-') && name.endsWith('.json'));
  const runs: BenchRun[] = [];
  let uncorrected = 0;
  for (const name of names.sort()) {
    const run = JSON.parse(await readFile(join(REPORT_DIR, name), 'utf8')) as BenchRun;
    if (run.samples.length === 0) {
      continue;
    }
    if (!isCorrected(run)) {
      uncorrected += 1;
      continue;
    }
    runs.push(run);
  }
  return { runs, uncorrected };
}

function toRow(label: string, runs: readonly BenchRun[]): GridRow {
  const samples = runs.flatMap((run) => run.samples);
  const totals = samples.map((sample) => sample.split.totalMs);
  const bufferSamples: BufferSample[] = samples.map((sample) => ({
    totalMs: sample.split.totalMs,
    segmentMs: sample.split.hops.find((hop) => hop.name === 'segment')!.ms,
  }));
  const segmentMs = median(bufferSamples.map((sample) => sample.segmentMs));

  const hopMs: Record<string, number> = {};
  for (const name of samples[0].split.hops.map((hop) => hop.name)) {
    hopMs[name] = median(samples.map((s) => s.split.hops.find((hop) => hop.name === name)!.ms));
  }

  return {
    label,
    runs: runs.length,
    samples: samples.length,
    medianTotalMs: median(totals),
    minTotalMs: Math.min(...totals),
    maxTotalMs: Math.max(...totals),
    hopMs,
    skewMs: median(runs.map((run) => Math.abs(run.samples[0].split.skew.offsetMs))),
    buffer: recommendBufferMs(bufferSamples, POLL_INTERVAL_MS, segmentMs),
  };
}

async function main(): Promise<void> {
  const { runs, uncorrected } = await loadRuns();
  if (runs.length === 0) {
    throw new Error(`no corrected runs with samples in ${REPORT_DIR}`);
  }

  const grouped = new Map<string, BenchRun[]>();
  for (const run of runs) {
    const label = settingLabel(run);
    grouped.set(label, [...(grouped.get(label) ?? []), run]);
  }

  const rows = [...grouped.entries()].map(([label, group]) => toRow(label, group));
  rows.sort((a, b) => a.medianTotalMs - b.medianTotalMs);

  console.log(`\n# Knob sweep — ${runs.length} run(s), ${rows.length} setting(s)\n`);
  if (uncorrected > 0) {
    console.log(
      `${uncorrected} run(s) excluded for predating the media-timeline correction. They report about ` +
        '1.4s less latency than they measured and every `upload` hop in them is negative, so they cannot ' +
        'share a grid with the rest.\n',
    );
  }
  // Skew is the only thing in the artifact that says where the publisher ran. On the deployment host
  // it came back at 3ms; from a workstation, 157ms. A row mixing the two is comparing two networks.
  console.log('| setting | runs | samples | median | min | max | segment | upload | manifest+feed | fetch | skew |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of rows) {
    const feed = row.hopMs.manifestPublish + row.hopMs.feedPropagation;
    console.log(
      `| ${row.label} | ${row.runs} | ${row.samples} | **${seconds(row.medianTotalMs)}** | ` +
        `${seconds(row.minTotalMs)} | ${seconds(row.maxTotalMs)} | ${Math.round(row.hopMs.segment)}ms | ` +
        `${Math.round(row.hopMs.upload)}ms | ${Math.round(feed)}ms | ${Math.round(row.hopMs.fetch)}ms | ` +
        `${Math.round(row.skewMs)}ms |`,
    );
  }

  console.log('\n## What a viewer would sit behind live\n');
  console.log('The buffer is not measured, it is chosen, so each row shows the smallest choice its own');
  console.log('samples support. `floor` is the largest edge-to-fetchable delay observed, which is the');
  console.log('hard bound: a player set below it stalls on a segment this sweep already saw. The');
  console.log('recommendation adds the client poll cadence and one segment of margin.\n');
  console.log('| setting | floor | recommended buffer | behind live at that buffer | at the shipped 10s |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const row of rows) {
    const edgeToFetchable = row.medianTotalMs - row.hopMs.segment;
    console.log(
      `| ${row.label} | ${seconds(row.buffer.observedFloorMs)} | ${seconds(row.buffer.recommendedMs)} | ` +
        `**${seconds(edgeToFetchable + row.buffer.recommendedMs)}** | ${seconds(edgeToFetchable + 10_000)} |`,
    );
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(`\nsweep report failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
