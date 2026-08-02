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
  /** How the run's own latency moved while it was being taken, or null with too few samples. */
  trend: LatencyTrend | null;
}

/**
 * How far the measured latency moved across a run, against how far it scattered while doing so.
 *
 * Both scaled to a minute of run so two runs of different lengths can be compared.
 *
 * **`Math.abs(msPerMinute) <= scatterMsPerMinute` holds for every possible run**, because the trend
 * is the first sample's latency minus the last and both of those are inside the scatter. Nothing here
 * branches on that comparison, and nothing downstream should: a report saying the trend is resolvable
 * when it exceeds its scatter would be printing a branch no run can reach.
 */
export interface LatencyTrend {
  /**
   * Milliseconds per minute of run, positive when later samples measured **less** latency than
   * earlier ones.
   *
   * This was called `paceDriftMsPerMinute` and described as the publisher's media clock running
   * against wall clock. It cannot be that, and the name was the defect the PR #64 gate found. The
   * bench recovers each capture instant from the media timestamp, so the only thing separating the
   * span of capture instants from the span of fetch instants is how much the latency itself changed
   * between the first sample and the last. Pace drift would produce exactly this signal, and so would
   * a pipeline that simply got faster, and so would the ordinary scatter of five samples.
   */
  msPerMinute: number;
  /**
   * The widest the trend could have come out at, had different samples landed at the ends.
   *
   * Taken across every sample rather than the two the trend uses, which is what makes it a bound
   * rather than a restatement. On the first real run it was 3199ms per minute against a trend of
   * 589, and swapping which segment landed last turned that trend into -980.
   */
  scatterMsPerMinute: number;
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
 * How much the measured latency moved across a run, and how far it scattered while doing so.
 *
 * Taken from two series across the same samples: `wallMs`, instants the bench read off its own clock
 * when it fetched, and `mediaMs`, capture instants recovered from the segments' own timestamps. Their
 * difference at each sample is that sample's latency, so this reduces to what the run's latency did
 * to itself, which is the only thing these two series can say.
 *
 * Returns null rather than a confident figure when there is nothing to measure across.
 */
export function latencyTrend(wallMs: readonly number[], mediaMs: readonly number[]): LatencyTrend | null {
  if (wallMs.length < 2 || wallMs.length !== mediaMs.length) {
    return null;
  }
  const spanMs = wallMs[wallMs.length - 1] - wallMs[0];
  if (spanMs <= 0) {
    return null;
  }
  const perMinute = (ms: number): number => (ms / spanMs) * 60_000;
  const latencies = wallMs.map((wall, index) => wall - mediaMs[index]);

  return {
    msPerMinute: perMinute(latencies[0] - latencies[latencies.length - 1]),
    scatterMsPerMinute: perMinute(Math.max(...latencies) - Math.min(...latencies)),
  };
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

/**
 * The trend line, always printed with the scatter beside it and never as a conclusion.
 *
 * Unconditional on purpose. `Math.abs(msPerMinute) <= scatterMsPerMinute` for every run, so a
 * sentence that only appears when the trend clears its scatter is a sentence no run ever prints.
 */
function trendLine(trend: LatencyTrend | null): string {
  if (trend === null) {
    return '- latency trend across the run: **not measured**, which needs two samples spanning some time.';
  }
  return (
    `- latency across the run moved ${trend.msPerMinute >= 0 ? '+' : ''}${Math.round(trend.msPerMinute)}ms per ` +
    `minute, inside a scatter of ${Math.round(trend.scatterMsPerMinute)}ms per minute. Positive means later ` +
    'segments measured less latency than earlier ones. The figure is the first sample minus the last, so the ' +
    'scatter always covers it, and one run cannot say whether the movement is the pipeline changing speed, the ' +
    "publisher's media clock running against wall clock, or which two segments happened to land at the ends. " +
    'Read it as a reason to distrust a single run as a baseline rather than as a measurement of any of the three.'
  );
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

  lines.push('', '## Self-checks', '', trendLine(run.trend));

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
