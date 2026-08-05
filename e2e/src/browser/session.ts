/**
 * What a viewer's browser did, sampled while it watched, and what that says about the buffer the
 * player was configured with.
 *
 * The question this exists to answer is task #48's: `LIVE_SYNC_DURATION_S` was derived from arrival
 * times the bench measured, and derived is all it has ever been. A player configured to sit six
 * seconds behind live can fail to in two directions, and only one of them is visible from outside a
 * browser:
 *
 * - **Clamped short.** hls.js pins its sync position to the start of the playlist, so a first
 *   manifest naming less media than the target asks for leaves a joining viewer nearer the edge than
 *   configured, with correspondingly less runway. The uploader's window was ten segments until
 *   2026-08-05, which is 2.5s at a 0.25s segment against a 6s target, and nothing in the bench could
 *   have seen it.
 * - **Run long.** Latency past `LIVE_MAX_LATENCY_DURATION_S` means the seek that is supposed to
 *   recover it did not.
 *
 * Both are read off the player's own live latency, which is why {@link ViewerSample} carries it.
 */

import { LIVE_MAX_LATENCY_DURATION_S, LIVE_SYNC_DURATION_S } from '../bench/clientTuning.js';

/**
 * How far below the configured target the latency may sit before it reads as clamped.
 *
 * A player is entitled to be somewhat nearer the edge than its target: hls.js reloads a live
 * playlist once per target duration and corrects between reloads, so the position oscillates by
 * about that much either way. One second covers that at every segment length this deployment runs,
 * since the uploader declares `ceil(segment duration)` and nothing here is longer than a second.
 */
export const LATENCY_TARGET_TOLERANCE_S = 1;

/** Below this share of wall clock, playback is not advancing and the sample is a stall. */
export const STALLED_ADVANCE_RATIO = 0.25;

export interface ViewerSample {
  /** Wall clock in the browser when the sample was taken. */
  atMs: number;
  /** `video.currentTime`, the media position actually being shown. */
  currentTime: number;
  paused: boolean;
  /** `video.readyState`. 4 is HAVE_ENOUGH_DATA. */
  readyState: number;
  /** 1.1 while hls.js is catching up, 1 once it is at target. */
  playbackRate: number;
  /** Buffered media ahead of the playhead, in seconds. */
  bufferAheadS: number;
  /** `hls.latency` as the shipped QoE overlay reports it, or null before it has a value. */
  liveLatencyS: number | null;
  rebufferCount: number;
  rebufferMs: number;
  fatalErrors: number;
  droppedFrames: number;
  /** As the player decoded it, so `1280x720` here is what arrived rather than what was requested. */
  resolution: string | null;
  /**
   * What the shipped `FeedStateOverlay` was telling the viewer, or null when it was telling them
   * nothing, which is what it renders while the feed is live.
   *
   * The one reading here that is about the product's words rather than its timing. A picture that
   * has stopped is a different event from a picture that has stopped and says why, and only the
   * second one is a viewer who knows to wait rather than to reload.
   */
  feedStateMessage: string | null;
}

export interface PlaybackAdvance {
  /** Media seconds gained per wall-clock second. ~1 playing, ~1.1 catching up, ~0 stalled. */
  ratio: number;
  wallMs: number;
}

/**
 * How playback moved between consecutive samples.
 *
 * Separate from the latency reading because it answers a different question and answers it without
 * trusting the overlay: `currentTime` against the wall clock is the one measurement here that cannot
 * be wrong about whether a viewer was watching anything.
 */
export function playbackAdvances(samples: readonly ViewerSample[]): PlaybackAdvance[] {
  return samples.slice(1).map((sample, i) => {
    const previous = samples[i];
    const wallMs = sample.atMs - previous.atMs;
    const ratio = wallMs > 0 ? ((sample.currentTime - previous.currentTime) * 1000) / wallMs : 0;
    return { ratio, wallMs };
  });
}

export interface LatencyVerdict {
  /** The player's latency on the first sample that had one, which is what a joining viewer got. */
  joinLatencyS: number | null;
  medianLatencyS: number | null;
  minLatencyS: number | null;
  maxLatencyS: number | null;
  /**
   * Whether the uploader named enough media for the player to start where it was told to.
   *
   * Judged on the **join** and on nothing else. hls.js pins its sync position to the start of the
   * playlist at mount, so the first manifest is the only thing that can hold a joining viewer nearer
   * the edge than configured. What the latency does afterwards is a different question with
   * different causes, and answering it with a median was this module's own first mistake: the run of
   * 2026-08-05 joined at 5.96s against a 6s target, which is the window working, and its median of
   * 2.28s printed as "the window is too short".
   */
  reachedTargetAtJoin: boolean;
  /** Whether it was still there later. False with {@link reachedTargetAtJoin} true means it drained. */
  heldTarget: boolean;
  /**
   * Whether the join itself was past the seek threshold, so a viewer's first second was a jump.
   *
   * Reported apart from {@link ranLong} because it is a different event with a different cause and a
   * different fix. hls.js pins its sync position to the start of the playlist, so a viewer joins as
   * far back as the first manifest reaches, and the uploader's window is budgeted in bytes rather
   * than in seconds: about 36 seconds of media at a 1.0s segment against a 6s target. Passing the
   * threshold is what makes hls.js seek, and the seek is the designed response, so this is a
   * question about how much media the uploader names and not about whether the player recovered.
   */
  joinedPastSeekThreshold: boolean;
  /**
   * True when latency ran past the point hls.js is supposed to seek rather than drift, **after** the
   * join.
   *
   * The join is excluded because it is the one sample where being past the threshold is expected,
   * and reading the plain maximum reported a run that joined 35.98s behind and was at 6.25s one
   * sample later as one where the seek had not worked. Everything after the join is still judged on
   * a single excursion: mid-session, one sample past the threshold is the whole signal.
   */
  ranLong: boolean;
}

export function judgeLatency(samples: readonly ViewerSample[]): LatencyVerdict {
  const observed = samples.map((sample) => sample.liveLatencyS).filter((value): value is number => value !== null);
  if (observed.length === 0) {
    return {
      joinLatencyS: null,
      medianLatencyS: null,
      minLatencyS: null,
      maxLatencyS: null,
      reachedTargetAtJoin: false,
      heldTarget: false,
      joinedPastSeekThreshold: false,
      ranLong: false,
    };
  }

  const floor = LIVE_SYNC_DURATION_S - LATENCY_TARGET_TOLERANCE_S;
  const medianLatencyS = median(observed);
  const afterJoin = observed.slice(1);
  return {
    joinLatencyS: observed[0],
    medianLatencyS,
    minLatencyS: Math.min(...observed),
    maxLatencyS: Math.max(...observed),
    reachedTargetAtJoin: observed[0] >= floor,
    heldTarget: medianLatencyS >= floor,
    joinedPastSeekThreshold: observed[0] > LIVE_MAX_LATENCY_DURATION_S,
    ranLong: afterJoin.some((latency) => latency > LIVE_MAX_LATENCY_DURATION_S),
  };
}

export interface SessionSummary {
  samples: number;
  /** Wall-clock span the samples cover. A median over a short span is a median over a short span. */
  spanMs: number;
  /** Samples where playback gained less than {@link STALLED_ADVANCE_RATIO} of wall clock. */
  stalledSamples: number;
  /**
   * The advance ratio of a typical sample, which is 1.0 in any session that plays at all.
   *
   * Not the one to quote. Playback either runs at its rate or is stopped, so the median describes
   * the sample rather than the session, and a viewer rebuffering a sixth of the time still scores
   * 1.000 here. {@link overallAdvanceRatio} is the honest one.
   */
  medianAdvanceRatio: number;
  /**
   * Media seconds delivered per wall second across the whole session, stalls included.
   *
   * This is what a viewer experienced: 1.0 means the picture kept up with the world, and the
   * shortfall below it is time they spent watching a frozen frame.
   */
  overallAdvanceRatio: number;
  /** The overlay's own count, which counts a `waiting` event rather than a slow sample. */
  rebufferCount: number;
  rebufferMs: number;
  fatalErrors: number;
  droppedFrames: number;
  resolution: string | null;
  medianBufferAheadS: number;
  latency: LatencyVerdict;
}

export function summarize(samples: readonly ViewerSample[]): SessionSummary {
  const last = samples[samples.length - 1];
  const advances = playbackAdvances(samples);
  const spanMs = samples.length > 1 ? last.atMs - samples[0].atMs : 0;
  return {
    samples: samples.length,
    spanMs,
    stalledSamples: advances.filter((advance) => advance.ratio < STALLED_ADVANCE_RATIO).length,
    medianAdvanceRatio: advances.length > 0 ? median(advances.map((advance) => advance.ratio)) : 0,
    overallAdvanceRatio: spanMs > 0 ? ((last.currentTime - samples[0].currentTime) * 1000) / spanMs : 0,
    // Read off the last sample rather than summed, because the overlay reports these as running
    // totals for the session.
    rebufferCount: last?.rebufferCount ?? 0,
    rebufferMs: last?.rebufferMs ?? 0,
    fatalErrors: last?.fatalErrors ?? 0,
    droppedFrames: last?.droppedFrames ?? 0,
    resolution: last?.resolution ?? null,
    medianBufferAheadS: samples.length > 0 ? median(samples.map((sample) => sample.bufferAheadS)) : 0,
    latency: judgeLatency(samples),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
