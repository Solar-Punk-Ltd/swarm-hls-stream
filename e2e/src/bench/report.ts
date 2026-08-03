/**
 * What a run produces: a markdown report an operator reads, and the JSON behind it that a later run
 * is compared against.
 *
 * The one decision worth stating is that a run reports **the median sample, whole**, rather than a
 * split averaged across samples. Averaging each hop independently produces a row set that sums to a
 * total no segment ever had, and describes a run that did not happen. Sprint 5's criterion is a drop
 * measured against a baseline, so the baseline has to be a thing that occurred.
 */

import type { FeedPoll } from './longRun.js';
import { HOPS_CROSSING_CLOCKS, impossibleHops, type LatencySplit } from './split.js';
import type { PublishKnobs } from './wallclockPublisher.js';

/** One segment carried end to end, with where its latency went. */
export interface SegmentSample {
  index: number;
  /** Swarm reference, which is what tied the fetched bytes to a line in the uploader's log. */
  ref: string;
  split: LatencySplit;
  /**
   * What the manifest declared this segment's duration to be, against the measured span in the split.
   *
   * Carried so a run can answer the question LAT-9 was opened on rather than only route around it.
   * The register recorded SRS announcing 3.15, 2.73, 3.16, 2.04 and 2.64 seconds against a fixed
   * two-second GOP, and two different faults produce that: an engine whose segmenting really is that
   * uneven, and an engine that cuts evenly and misreports. Measuring the span from the bytes makes
   * the split right under either, and only holding both figures says which it was.
   *
   * Null where the entry carried no readable `#EXTINF`, which costs the comparison and not the sample.
   */
  declaredDurationS: number | null;
  /** How many video packets the span was measured across, so a thin reading can be seen as thin. */
  videoPacketCount: number;
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
   * Every completed read of the feed, including the ones that named a segment already measured.
   *
   * A run's samples cannot say whether a gap between two of them was the feed standing still or this
   * process not asking, because both produce the same absence. The polls that yielded nothing are
   * what separate them, and they are only knowable while the run is happening. See `feedProgress`.
   */
  feedPolls: readonly FeedPoll[];
  /** How the run's own latency moved while it was being taken, or null with too few samples. */
  trend: LatencyTrend | null;
  /**
   * How much was taken off every capture instant, because the publisher's timestamps run that far
   * ahead of wall clock. See `measureMediaTimelineLead`.
   *
   * In the artifact rather than only in the console, because the runs of 2026-08-02 and 2026-08-03
   * were taken without it and read 1.4s fast. A reader comparing an old report against a new one has
   * no other way to tell which of the two they are holding.
   */
  mediaTimelineLeadMs: number;
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

/**
 * The warning that belongs next to the headline rather than only under it.
 *
 * The median is one sample chosen from several, and the self-checks below can be flagging that very
 * sample. On the first real run they were: the median was segment 24, segment 24's upload hop was
 * negative, and both facts were printed without either naming the other. A reader who stopped at the
 * table above had nothing telling them the warning was about the numbers they had just read.
 *
 * It states no verdict on the total. Whether the total survives an impossible hop depends on which
 * input is wrong, which `impossibleHopGuidance` works through with the run's own numbers.
 */
function medianFlaggedNotice(median: SegmentSample): string[] {
  const flagged = impossibleHops(median.split);
  if (flagged.length === 0) {
    return [];
  }
  return [
    '',
    `**The segment this split comes from is flagged below**, for ${flagged
      .map((hop) => `\`${hop.name}\` at ${Math.round(hop.ms)}ms`)
      .join(' and ')}. The self-checks say what that does and does not cost, and the rows below should ` +
      'not be read without them.',
  ];
}

/**
 * How much longer the manifest said a segment was than it is, in milliseconds. Negative means shorter.
 *
 * Takes the declaration separately from the sample rather than reading it back off one, so the null
 * case cannot arrive here. It used to, guarded by a `return 0` that no input could reach because every
 * call site works over the already-filtered list, and a zero gap from a segment carrying no
 * declaration would have been indistinguishable from perfect agreement.
 */
function declaredGapMs(declaredDurationS: number, sample: SegmentSample): number {
  return (declaredDurationS - sample.split.instants.segmentDurationS) * 1_000;
}

/** A sample whose manifest entry carried a readable duration, which is the only kind that compares. */
interface DeclaredSample {
  sample: SegmentSample;
  declaredDurationS: number;
}

function declaredSamples(run: BenchRun): DeclaredSample[] {
  return run.samples.flatMap((sample) =>
    sample.declaredDurationS === null ? [] : [{ sample, declaredDurationS: sample.declaredDurationS }],
  );
}

/**
 * What the manifest declared each segment held, against what it holds.
 *
 * Printed always and with no verdict attached, for the same reason `trendLine` is. LAT-9 was opened on
 * SRS announcing 3.15, 2.73, 3.16, 2.04 and 2.64 seconds against a fixed two-second GOP, and two
 * different faults produce that reading: segmenting that really is uneven, and even segmenting that is
 * misreported. One run cannot separate them, so a line that only appeared past some threshold would be
 * stating a judgement the numbers do not support.
 *
 * **It is evidence about both figures, not only the engine's.** The gap is declared minus measured,
 * and the measured term is the one the split runs on, so a disagreement says one of the two is wrong
 * without saying which. Reporting it as the engine's error would be the same shape of mistake the
 * `paceDriftMsPerMinute` name was: naming one cause for a signal that has more than one.
 *
 * Which matters here more than it looks, because the two are not symmetric in what they cost.
 * `totalMs` is `fetchedAtMs - capturedAtMs` and never moves, and the hops sum to it whatever the span
 * is, so `impossibleHops` prints its all-clear either way. What a too-small measured span does instead
 * is grow the `upload` hop, and that hop coming out negative is the whole reason LAT-9 was opened.
 * Measured on the real run's own instants: a 2.64s span gives -240ms, 2.0s gives +400ms, and a
 * truncated 0.067s gives +2333ms. **So a mis-measured span makes LAT-9's symptom look resolved**, and
 * this line is the only thing in the report that would show it.
 */
function declaredDurationLine(run: BenchRun): string {
  const compared = declaredSamples(run);
  if (compared.length === 0) {
    return (
      '- **no sample carried a readable `#EXTINF`**, so nothing here says whether the engine reports its ' +
      'own segment durations correctly. Every figure above is measured from the bytes and stands.'
    );
  }

  const gapOf = ({ declaredDurationS, sample }: DeclaredSample): number => declaredGapMs(declaredDurationS, sample);
  const worst = compared.reduce((a, b) => (Math.abs(gapOf(a)) >= Math.abs(gapOf(b)) ? a : b));
  // Named rather than left to the count, because every figure below is over the readable subset. Four
  // unreadable entries out of five reduce to one comparison, and one comparison against itself reads
  // as a reassuring 0ms while the manifest fault it hides is worse than any duration mismatch.
  const unreadable = run.samples.length - compared.length;
  const skipped =
    unreadable === 0
      ? ''
      : ` **${unreadable} of ${run.samples.length} carried no readable \`#EXTINF\` and are not in that comparison**, ` +
        'which is a manifest this cannot read rather than one that disagrees.';

  return (
    `- the manifest and the bytes disagree by at most ${Math.round(Math.abs(gapOf(worst)))}ms across ` +
    `${compared.length} sample(s), worst at segment ${worst.sample.index}, where it declared ` +
    `${seconds(worst.declaredDurationS * 1_000)} for ${seconds(
      worst.sample.split.instants.segmentDurationS * 1_000,
    )} ` +
    'of media. **Read this before the `upload` hop.** The gap is the declared figure minus the ' +
    'measured one, so it says one of the two is wrong and not which. Nothing above derives from the ' +
    'declared figure, but everything except `capture to fetchable` derives from the measured one, and ' +
    'a measured span that came out too small grows the `upload` hop rather than making it negative. ' +
    'A run where that hop is finally non-negative and this gap is wide has not settled anything. ' +
    'Separating an engine that segments unevenly from one that misreports even segments needs a ' +
    'second run at another GOP. Separating either of those from a short measurement needs the packet ' +
    'counts in the table above.' +
    skipped
  );
}

function knobLine(knobs: PublishKnobs): string {
  return `${knobs.size} @ ${knobs.fps}fps, ${knobs.videoBitrateKbps}kbps, ${knobs.gopSeconds}s GOP`;
}

/**
 * What the media-timeline correction did to this run, in the terms a reader compares runs in.
 *
 * Spelled out with the direction, because the sign is the part that is easy to get backwards: the
 * timestamps run ahead, so the picture was taken *earlier* than they claim, so removing the lead
 * makes the measured latency **larger**. A reader comparing against the uncorrected runs of
 * 2026-08-02 and 2026-08-03 has to add this to their headline figures, not subtract it.
 */
function leadLine(run: BenchRun): string {
  if (run.mediaTimelineLeadMs === 0) {
    return (
      "- **no correction was applied for the publisher's timestamps running ahead of wall clock.** Every " +
      'figure here is therefore a lower bound on the real latency, and the `upload` hop a lower bound on ' +
      'its real value.'
    );
  }
  return (
    `- the publisher's timestamps run ${Math.round(run.mediaTimelineLeadMs)}ms ahead of wall clock, measured ` +
    'locally before this run started, and that much has been taken off every capture instant. It reaches ' +
    '`capture to fetchable`, `behind live` and the `upload` hop, and no other row. Runs taken before this ' +
    'correction existed report that much *less* latency than they measured, because a timestamp that runs ' +
    'ahead makes the picture look newer than it is.'
  );
}

export function renderReport(run: BenchRun): string {
  const median = medianSample(run.samples);
  if (!median) {
    return [
      `# Latency run — ${run.measuredAt}`,
      '',
      `**No segment was measured.** engine ${run.engine}, profile ${run.profile}, ${knobLine(run.knobs)}.`,
      '',
      'A run with no samples is not a slow pipeline, it is a run that failed.',
      '',
      // This used to send the reader to the run log, which never had them: `measureLatency` only
      // pushes to `discarded` and the runner prints the report. So the one artifact naming why every
      // segment was dropped was the JSON beside this file, and the markdown said to look elsewhere.
      ...(run.discarded.length === 0
        ? [
            'Nothing was discarded either, so no segment ever reached the bench. The reason is above this report in the run log.',
          ]
        : [
            `All ${run.discarded.length} segment(s) that reached the bench were unreadable:`,
            '',
            ...run.discarded.map((drop) => `- \`${drop.ref.slice(0, 12)}\`: ${drop.reason}`),
          ]),
    ].join('\n');
  }

  const lines: string[] = [
    `# Latency run — ${run.measuredAt}`,
    '',
    `engine \`${run.engine}\`, profile \`${run.profile}\`, publishing ${knobLine(run.knobs)}`,
    `${run.samples.length} segment(s) measured. The split below is segment ${median.index}, the median one, whole.`,
    '',
    '## What a viewer experiences',
    '',
    `| | |`,
    `| --- | --- |`,
    `| capture to fetchable | **${seconds(median.split.totalMs)}** |`,
    `| player buffer, configured | ${seconds(median.split.playerBufferMs)} |`,
    `| **behind live** | **${seconds(median.split.viewerLatencyMs)}** |`,
    ...medianFlaggedNotice(median),
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
    'The boundary between `manifestPublish` and `feedPropagation` is attributed to the first publish ' +
      'logged after the upload, which can be one publish early: the uploader builds a manifest and then ' +
      'awaits the feed write, so a publish already in flight when a segment lands completes afterwards ' +
      'without naming it. That moves time between those two rows the same way skew does, and leaves ' +
      'their sum, so read `manifestPublish` and `feedPropagation` as one number.',
    '',
    '## Every sample',
    '',
    '| segment | ref | total | media held | declared | packets |',
    '| ---: | --- | ---: | ---: | ---: | ---: |',
  );

  for (const sample of run.samples) {
    const declared = sample.declaredDurationS === null ? 'unreadable' : seconds(sample.declaredDurationS * 1_000);
    lines.push(
      `| ${sample.index} | \`${sample.ref.slice(0, 12)}\` | ${seconds(sample.split.totalMs)} | ` +
        `${seconds(sample.split.instants.segmentDurationS * 1_000)} | ${declared} | ${sample.videoPacketCount} |`,
    );
  }

  lines.push('', '## Self-checks', '', trendLine(run.trend), declaredDurationLine(run), leadLine(run));

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
