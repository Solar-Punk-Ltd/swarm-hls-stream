/**
 * Reading a run that lasted long enough for its own stability to be a question.
 *
 * Every latency figure this project has published comes from the opening seconds of a broadcast: a
 * run publishes for about fifty seconds and takes five samples spanning eight to twenty seconds of
 * media. Those figures are reproducible across independent starts, which is a different property from
 * holding still, and the difference is the whole reason this module exists.
 *
 * Nothing here is a verdict. Each function answers one question the short bench cannot ask, and the
 * report puts the answers next to each other.
 *
 * ## Why the pace comes first
 *
 * The publisher is paced by ffmpeg's `realtime` filter at the nominal frame rate, and the capture
 * instant of every sample is recovered from the media timestamps. So a publisher running a percent
 * slow produces a latency that climbs by that percent of elapsed time forever, with no viewer of a
 * real camera ever seeing it. Over fifty seconds that is half a second and invisible under the
 * scatter. Over half an hour it is eighteen seconds and would be the headline. {@link mediaPacing}
 * is the only thing separating that from a pipeline genuinely falling behind, and it is measured
 * rather than assumed away.
 */

import { median } from './sweepAnalysis.js';

/** One measured segment, reduced to what the pacing question needs. */
export interface PacedSample {
  /**
   * The uploader's own count of segments produced, which skips nothing.
   *
   * A run polling every two seconds samples one segment in four at a half-second fragment, so the
   * sampled set says nothing about how many segments were produced between two of them. This does.
   */
  index: number;
  /** Bench clock, recovered from the segment's own presentation timestamps. */
  capturedAtMs: number;
  /** Bench clock, when the segment finished downloading. */
  fetchedAtMs: number;
  /** Media the segment holds, measured from its packets. */
  segmentMs: number;
}

export interface MediaPacing {
  /**
   * Seconds of media the segments actually carried, per second of wall clock.
   *
   * Below 1 means a viewer playing at 1x runs out of media, whatever the cause, and falls further
   * behind for as long as it stays there.
   */
  deliveredPerWallSecond: number;
  /**
   * Seconds the media timeline advanced, per second of wall clock.
   *
   * **This is the instrument's own honesty check.** Below 1 means the publisher is not producing in
   * real time, and a latency climbing at exactly `(1 - this) x elapsed` is the publisher rather than
   * the pipeline. A real broadcaster's camera does not do this, so a run where it is below 1 measures
   * the bench.
   */
  timelinePerWallSecond: number;
  /**
   * Media the timeline crossed that no segment carried, across the sampled span.
   *
   * Zero when the segments tile the timeline. Positive means a viewer gets a jump: the frames exist
   * in the timeline and arrive in nothing. It is the difference between the two ratios above given a
   * unit, and it is the only thing distinguishing a slow publisher from a lossy one, because a slow
   * publisher moves both ratios together and a lossy one moves only the first.
   */
  holeMs: number;
}

/**
 * How fast media time advanced against wall clock, read two ways.
 *
 * Both denominators are the span of fetch instants, which is bench wall clock and the only clock in
 * the run that is not derived from the media. The numerators are what differ: one counts the media
 * the segments contained, taken from the uploader's segment index and the median span, and the other
 * counts the distance the timeline travelled, taken from the recovered capture instants.
 */
export function mediaPacing(samples: readonly PacedSample[]): MediaPacing {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const wallMs = last === undefined || first === undefined ? 0 : last.fetchedAtMs - first.fetchedAtMs;
  if (wallMs <= 0) {
    throw new Error('the run spans no wall time, so nothing divides into a pace');
  }

  const deliveredMs = (last.index - first.index) * median(samples.map((sample) => sample.segmentMs));
  const timelineMs = last.capturedAtMs - first.capturedAtMs;

  return {
    deliveredPerWallSecond: deliveredMs / wallMs,
    timelinePerWallSecond: timelineMs / wallMs,
    holeMs: timelineMs - deliveredMs,
  };
}

/** One measured segment, reduced to what the drift question needs. */
export interface TimedSample {
  fetchedAtMs: number;
  totalMs: number;
}

export interface LatencyDrift {
  /** Least-squares slope of latency against wall time, in milliseconds of latency per minute of run. */
  msPerMinute: number;
  /** What that slope predicts the latency moved by, across the whole run. Positive means it grew. */
  fittedChangeMs: number;
  /**
   * How far the samples sit from the fitted line, as a root-mean-square.
   *
   * The figure that decides whether the slope is readable, and the reason this is a different
   * function from `latencyTrend` rather than a longer run through it. The short bench takes the first
   * sample minus the last and prints the scatter beside it, which is right for five samples over ten
   * seconds because a fitted line there is noise. Over hundreds of samples across half an hour the
   * line is a real quantity, and what makes it real is `fittedChangeMs` clearing this.
   */
  residualMs: number;
}

/**
 * The slope of a run's latency against its own elapsed time, with the spread around it.
 *
 * Ordinary least squares, and stated as a change across the run rather than only as a rate, because a
 * rate invites being multiplied by a duration the run never covered.
 */
export function latencyDrift(samples: readonly TimedSample[]): LatencyDrift {
  if (samples.length < 2) {
    throw new Error('a slope needs at least two samples to run through');
  }
  const minutes = samples.map((sample) => sample.fetchedAtMs / 60_000);
  const latencies = samples.map((sample) => sample.totalMs);
  const meanMinute = mean(minutes);
  const meanLatency = mean(latencies);

  const spread = minutes.reduce((sum, minute) => sum + (minute - meanMinute) ** 2, 0);
  if (spread === 0) {
    throw new Error('every sample landed at the same instant, so no slope runs through them');
  }
  const covariance = minutes.reduce(
    (sum, minute, index) => sum + (minute - meanMinute) * (latencies[index] - meanLatency),
    0,
  );
  const msPerMinute = covariance / spread;

  const residuals = latencies.map(
    (latency, index) => latency - (meanLatency + msPerMinute * (minutes[index] - meanMinute)),
  );
  const runMinutes = minutes[minutes.length - 1] - minutes[0];

  return {
    msPerMinute,
    fittedChangeMs: msPerMinute * runMinutes,
    residualMs: Math.sqrt(mean(residuals.map((residual) => residual ** 2))),
  };
}

/** One measured segment, reduced to what the buffer question needs, plus when it arrived. */
export interface BufferedSample {
  fetchedAtMs: number;
  totalMs: number;
  segmentMs: number;
}

export interface BufferDemandTrend {
  /** The buffer the first third of the run would have needed to never stall. */
  firstThirdMs: number;
  lastThirdMs: number;
  /** Positive when the run ended needing more buffer than it started with. */
  growthMs: number;
}

/**
 * Whether the buffer a player needs holds still while it watches.
 *
 * `recommendBufferMs` derives a setting from the worst arrival in a set of samples, and every buffer
 * this project recommends was derived from a run's opening seconds. That is only a safe setting if
 * the demand does not climb, which is a question no short run can be asked. Thirds rather than a
 * fitted line, because the quantity is a maximum and a maximum has no slope.
 */
export function bufferDemandTrend(samples: readonly BufferedSample[]): BufferDemandTrend {
  if (samples.length < 3) {
    throw new Error('comparing the ends of a run needs at least three samples');
  }
  const ordered = [...samples].sort((a, b) => a.fetchedAtMs - b.fetchedAtMs);
  const third = Math.floor(ordered.length / 3);
  const demand = (slice: readonly BufferedSample[]): number =>
    Math.max(...slice.map((sample) => sample.totalMs - sample.segmentMs));

  const firstThirdMs = demand(ordered.slice(0, third));
  const lastThirdMs = demand(ordered.slice(ordered.length - third));

  return { firstThirdMs, lastThirdMs, growthMs: lastThirdMs - firstThirdMs };
}

export interface LatencyBucket {
  /** Minutes since the run's first sample. */
  fromMinute: number;
  samples: number;
  /** Null for a minute that carried no samples, which is a stall rather than a zero. */
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

/**
 * Latency grouped by which minute of the run it was measured in.
 *
 * A single slope hides the shape of a run: one that held steady for twenty minutes and then fell
 * apart fits the same line as one that degraded evenly, and only the second is a setting an operator
 * could compensate for.
 *
 * **A minute nothing arrived in is kept as an empty row.** Grouping only what arrived would drop it,
 * and it is the most interesting minute in the run.
 */
export function latencyByMinute(samples: readonly TimedSample[]): LatencyBucket[] {
  if (samples.length === 0) {
    throw new Error('no samples, so there are no minutes to group them into');
  }
  const ordered = [...samples].sort((a, b) => a.fetchedAtMs - b.fetchedAtMs);
  const startedAtMs = ordered[0].fetchedAtMs;
  const minuteOf = (sample: TimedSample): number => Math.floor((sample.fetchedAtMs - startedAtMs) / 60_000);
  const lastMinute = minuteOf(ordered[ordered.length - 1]);

  return Array.from({ length: lastMinute + 1 }, (_, fromMinute) => {
    const inMinute = ordered.filter((sample) => minuteOf(sample) === fromMinute).map((sample) => sample.totalMs);
    if (inMinute.length === 0) {
      return { fromMinute, samples: 0, medianMs: null, p95Ms: null, maxMs: null };
    }
    return {
      fromMinute,
      samples: inMinute.length,
      medianMs: median(inMinute),
      p95Ms: percentile(inMinute, 0.95),
      maxMs: Math.max(...inMinute),
    };
  });
}

/** One completed read of the feed a viewer's player polls. */
export interface FeedPoll {
  /** Bench clock, when the manifest finished arriving. */
  atMs: number;
  /** The newest segment that manifest named, or null where it named none. */
  newestRef: string | null;
}

export interface FeedProgress {
  /** The longest a segment stayed the newest one the feed named. */
  stallMs: number;
  /**
   * How many polls saw it unchanged, which is the whole attribution.
   *
   * Several means the bench kept asking and the feed kept giving the same answer, so a viewer polling
   * at that cadence saw the stream stop. One means the bench itself was not asking, and the feed may
   * have advanced any number of times unobserved.
   */
  stallPolls: number;
  /** Bench clock, when that segment first appeared. */
  stallStartedAtMs: number;
  /**
   * The longest the bench went between two polls, which bounds everything it could have seen.
   *
   * A stall no longer than this is the instrument's, whatever else the numbers suggest.
   */
  longestPollGapMs: number;
}

/**
 * Whether a gap in new segments belongs to the feed or to the bench watching it.
 *
 * The smoke run of 2026-08-03 went 48 seconds without a new segment and the artifact could not say
 * whose seconds those were. It took the uploader's log, which held 154 manifest writes inside that
 * window, to establish that the pipeline never stopped. That only worked because the log was still
 * there, and an instrument that needs a second instrument to interpret its own gaps will eventually
 * report one of them as the product.
 *
 * A trailing run of polls that was never superseded is not counted. The newest segment at the last
 * poll stays newest because the publisher stopped, and counting it would report every clean run as
 * stalling at its end.
 */
export function feedProgress(polls: readonly FeedPoll[]): FeedProgress {
  if (polls.length < 2) {
    throw new Error('attributing a gap needs at least two polls to sit between');
  }
  const ordered = [...polls].sort((a, b) => a.atMs - b.atMs);

  let longestPollGapMs = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    longestPollGapMs = Math.max(longestPollGapMs, ordered[i].atMs - ordered[i - 1].atMs);
  }

  let best = { stallMs: 0, stallPolls: 0, stallStartedAtMs: ordered[0].atMs };
  let runStart = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].newestRef === ordered[runStart].newestRef) {
      continue;
    }
    const stallMs = ordered[i].atMs - ordered[runStart].atMs;
    if (stallMs > best.stallMs) {
      best = { stallMs, stallPolls: i - runStart, stallStartedAtMs: ordered[runStart].atMs };
    }
    runStart = i;
  }

  return { ...best, longestPollGapMs };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Nearest-rank, so the figure returned is one a segment actually measured. */
export function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}
