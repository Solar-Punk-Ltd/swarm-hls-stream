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

/** A segment that reached the bench but could not be turned into a reading, and why. */
export interface DiscardedSegment {
  ref: string;
  reason: string;
}

export interface BenchRun {
  /** ISO instant the run finished, for the register row that cites it. */
  measuredAt: string;
  engine: string;
  profile: string;
  knobs: PublishKnobs;
  samples: readonly SegmentSample[];
  /**
   * Segments that were paid for and then dropped.
   *
   * Carried into the report rather than logged, because a run that measured one segment and silently
   * dropped four looks exactly like a run that asked for one. The count is the difference between a
   * thin result and a broken pipeline, and only this field can tell them apart afterwards.
   */
  discarded: readonly DiscardedSegment[];
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

/**
 * What to distrust when a hop came out negative, decided from the run's own numbers.
 *
 * The previous version of this named the skew estimate first and asserted that the totals were
 * unaffected. Both were wrong in the way that matters: it recommended a suspect its own printed
 * uncertainty had already ruled out, and it gave an unconditional reassurance for a conditional fact.
 *
 * Skew only reaches the two hops in `HOPS_CROSSING_CLOCKS`, and it moves them by exactly the error in
 * `offsetMs`. So a negative cross-clock hop is explicable by skew only if closing it needs a
 * correction inside `uncertaintyMs`, which is a question the numbers answer rather than a judgement.
 *
 * The totals claim is conditional because `totalMs` and the `upload` hop share `capturedAtMs`. An
 * error in the segment duration or in the log pairing moves the hop alone and leaves every total
 * standing; an error in the recovered capture instant moves both, one for one.
 */
function impossibleHopGuidance(run: BenchRun): string[] {
  const worstShortfallMs = Math.max(
    ...run.samples.flatMap((sample) =>
      impossibleHops(sample.split)
        .filter((hop) => HOPS_CROSSING_CLOCKS.includes(hop.name))
        .map((hop) => -hop.ms),
    ),
    0,
  );
  const uncertaintyMs = run.samples[0]?.split.skew.uncertaintyMs ?? 0;
  const skewCouldExplainIt = worstShortfallMs > 0 && worstShortfallMs <= uncertaintyMs;

  return [
    skewCouldExplainIt
      ? `  The skew estimate can account for this: closing the widest gap needs ${Math.round(worstShortfallMs)}ms, ` +
        `inside the +/-${Math.round(uncertaintyMs)}ms this run measured.`
      : `  **Not the skew estimate.** Closing the widest gap needs ${Math.round(worstShortfallMs)}ms of ` +
        `correction, outside the +/-${Math.round(uncertaintyMs)}ms this run measured, so the remaining ` +
        'candidates are the segment duration, the log pairing, and the recovered capture instant.',
    '  Whether the totals survive depends on which of those it is. The segment duration and the log ' +
      'pairing move the hop alone. The capture instant is shared with the total and moves both by the ' +
      'same amount, so a total is only safe once the capture instant is cleared.',
  ];
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
    impossibleHops(sample.split).map(
      (hop) => `segment ${sample.index}: ${hop.name} came out at ${Math.round(hop.ms)}ms`,
    ),
  );
  if (impossible.length === 0) {
    lines.push('- no hop came out negative, so no stage is recorded as finishing before the one feeding it.');
  } else {
    lines.push(
      '- **hops that cannot be true**, meaning an input is wrong rather than a pipeline that is fast:',
      ...impossible.map((line) => `  - ${line}`),
      ...impossibleHopGuidance(run),
    );
  }

  if (run.discarded.length > 0) {
    lines.push(
      `- **${run.discarded.length} segment(s) reached the bench and could not be read**, so they cost a ` +
        'broadcast and produced no reading. A thin run and a broken pipeline look identical without this list:',
      ...run.discarded.map((drop) => `  - \`${drop.ref.slice(0, 12)}\`: ${drop.reason}`),
    );
  }

  return lines.join('\n');
}
