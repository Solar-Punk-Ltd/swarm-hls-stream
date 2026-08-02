/**
 * What a run produces: a markdown report an operator reads, and the JSON behind it that a later run
 * is compared against.
 *
 * The one decision worth stating is that a run reports **the median sample, whole**, rather than a
 * split averaged across samples. Averaging each hop independently produces a row set that sums to a
 * total no segment ever had, and describes a run that did not happen. Sprint 5's criterion is a drop
 * measured against a baseline, so the baseline has to be a thing that occurred.
 */

import { HOPS_CROSSING_CLOCKS, impossibleHops, type LatencySplit } from './split.js';
import type { PublishKnobs } from './wallclockPublisher.js';

/** One segment carried end to end, with where its latency went. */
export interface SegmentSample {
  index: number;
  /** Swarm reference, which is what tied the fetched bytes to a line in the uploader's log. */
  ref: string;
  split: LatencySplit;
}

export interface BenchRun {
  /** ISO instant the run finished, for the register row that cites it. */
  measuredAt: string;
  engine: string;
  profile: string;
  knobs: PublishKnobs;
  samples: readonly SegmentSample[];
  /**
   * How far the publisher's media clock drifted from wall clock, in ms per minute, or null when
   * fewer than two samples made it measurable.
   *
   * The encoder anchors its timeline at the first frame's wall clock and then advances at the nominal
   * frame rate, so a long publish accumulates the difference between those two rates. Measured rather
   * than assumed: it is a direct bias on every latency in the run, and the only honest way to say it
   * is small is to have looked.
   */
  paceDriftMsPerMinute: number | null;
}

function medianIndex(count: number): number {
  return Math.floor((count - 1) / 2);
}

/** The sample whose total is the median, returned whole so its rows still sum to its own total. */
export function medianSample(samples: readonly SegmentSample[]): SegmentSample | undefined {
  if (samples.length === 0) {
    return undefined;
  }
  return [...samples].sort((a, b) => a.split.totalMs - b.split.totalMs)[medianIndex(samples.length)];
}

function seconds(ms: number): string {
  return `${(ms / 1_000).toFixed(2)}s`;
}

/**
 * How fast the publisher's media clock ran against the real one, in ms gained per minute.
 *
 * The encoder anchors its timeline on the first frame's wall clock and then advances at the nominal
 * frame rate. Those two rates are close but not identical, and the difference accumulates over a run
 * as a bias on every latency in it.
 *
 * Measured by comparing two series taken across the same samples: `wallMs`, instants the bench read
 * off its own clock, and `mediaMs`, instants recovered from the segments' timestamps. In a run with
 * no drift they advance together.
 *
 * **It cannot separate drift from a latency trend**, and that is worth knowing rather than hiding: a
 * run whose latency grew by a second between the first sample and the last reports that as drift too.
 * Either reading is a reason to distrust the run as a baseline, which is why one number carries both.
 *
 * Returns null rather than a confident figure when there is nothing to measure across.
 */
export function paceDriftMsPerMinute(wallMs: readonly number[], mediaMs: readonly number[]): number | null {
  if (wallMs.length < 2 || wallMs.length !== mediaMs.length) {
    return null;
  }
  const wallSpanMs = wallMs[wallMs.length - 1] - wallMs[0];
  const mediaSpanMs = mediaMs[mediaMs.length - 1] - mediaMs[0];
  if (wallSpanMs <= 0) {
    return null;
  }
  return ((mediaSpanMs - wallSpanMs) / wallSpanMs) * 60_000;
}

function knobLine(knobs: PublishKnobs): string {
  return `${knobs.size} @ ${knobs.fps}fps, ${knobs.videoBitrateKbps}kbps, ${knobs.gopSeconds}s GOP`;
}

export function renderReport(run: BenchRun): string {
  const median = medianSample(run.samples);
  if (!median) {
    return [
      `# Latency run — ${run.measuredAt}`,
      '',
      `**No segment was measured.** engine ${run.engine}, profile ${run.profile}, ${knobLine(run.knobs)}.`,
      '',
      'A run with no samples is not a slow pipeline, it is a run that failed. The reason is above this',
      'report in the run log.',
    ].join('\n');
  }

  const lines: string[] = [
    `# Latency run — ${run.measuredAt}`,
    '',
    `engine \`${run.engine}\`, profile \`${run.profile}\`, publishing ${knobLine(run.knobs)}`,
    `${run.samples.length} segment(s) measured; the split below is the median one, whole.`,
    '',
    '## What a viewer experiences',
    '',
    `| | |`,
    `| --- | --- |`,
    `| capture to fetchable | **${seconds(median.split.totalMs)}** |`,
    `| player buffer, configured | ${seconds(median.split.playerBufferMs)} |`,
    `| **behind live** | **${seconds(median.split.viewerLatencyMs)}** |`,
    '',
    '## Where it went',
    '',
    '| hop | ms | | what |',
    '| --- | ---: | --- | --- |',
  ];

  for (const hop of median.split.hops) {
    const crossesClocks = HOPS_CROSSING_CLOCKS.includes(hop.name);
    lines.push(`| ${hop.name} | ${Math.round(hop.ms)} | ${crossesClocks ? '~' : ''} | ${hop.what} |`);
  }

  lines.push(
    '',
    `Rows marked \`~\` are bounded by instants from two different clocks. The uploader host reads ` +
      `${Math.round(median.split.skew.offsetMs)}ms ahead of the bench, give or take ` +
      `${Math.round(median.split.skew.uncertaintyMs)}ms. That skew moves time between those two rows ` +
      'and cancels in the total, so it cannot move the headline figure.',
    '',
    '## Every sample',
    '',
    '| segment | ref | total |',
    '| ---: | --- | ---: |',
  );

  for (const sample of run.samples) {
    lines.push(`| ${sample.index} | \`${sample.ref.slice(0, 12)}\` | ${seconds(sample.split.totalMs)} |`);
  }

  const drift = run.paceDriftMsPerMinute;
  lines.push(
    '',
    '## Self-checks',
    '',
    drift === null
      ? '- publisher pace drift: **not measured**, which needs two samples spanning some time.'
      : `- publisher pace drift: ${drift >= 0 ? '+' : ''}${Math.round(drift)}ms per minute of media. ` +
        'This is a direct bias on every total above, in the direction of reporting less latency than ' +
        'there was when it is positive.',
  );

  const impossible = run.samples.flatMap((sample) =>
    impossibleHops(sample.split).map((hop) => `segment ${sample.index}: ${hop.name} came out at ${Math.round(hop.ms)}ms`),
  );
  if (impossible.length === 0) {
    lines.push('- no hop came out negative, so no stage is recorded as finishing before the one feeding it.');
  } else {
    lines.push(
      '- **hops that cannot be true**, meaning an input is wrong rather than a pipeline that is fast:',
      ...impossible.map((line) => `  - ${line}`),
      '  The totals are unaffected; the skew estimate or the log pairing is what to distrust.',
    );
  }

  return lines.join('\n');
}
