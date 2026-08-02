/**
 * Turning a segment's presentation timestamp back into the wall-clock instant its first frame was
 * captured. This is the whole basis of the glass-to-glass measurement, so it is also the one place
 * where being quietly wrong would produce a latency figure nobody could tell from a real one.
 *
 * The publisher runs `-use_wallclock_as_timestamps 1 -copyts`, so ffmpeg stamps the first input frame
 * with the publishing machine's own clock and the encoder carries that anchor into the output
 * timeline. MPEG-TS then stores presentation timestamps in 33 bits at 90kHz, which wraps every
 * ~26.5 hours, so what arrives at the far end is the epoch **modulo that period**, not the epoch.
 *
 * Measured against ffmpeg 7.1.1 rather than assumed. A publish whose process started at epoch
 * 1785677886.564 came back with a first pts of 1923644272 ticks; 1785677886.564 x 90000 mod 2^33 is
 * 1923509041 ticks, leaving 135231 ticks, or 1.503s, which is what that build spends between spawning
 * and encoding its first frame. Running the same publish through ffmpeg's own HLS muxer, the closest
 * local stand-in for what a media engine does to the stream, preserved it.
 *
 * ## What this cannot see, and why the caller must bound it
 *
 * A media engine is free to rewrite timestamps, and both engines here repackage the stream. If one
 * rebases to zero, the arithmetic below still returns a number: `pts` becomes a small media offset,
 * the modulo folds it into the wrap period, and the result is an arbitrary value in [0, 26.5h) that
 * looks exactly like a latency. Roughly one run in eight hundred would land under a minute and be
 * indistinguishable by inspection.
 *
 * So no reading is trusted on its own shape. `latencyMsFromPts` takes the instant the publisher was
 * started and rejects anything physically impossible: a frame cannot be captured before the process
 * that captured it existed, and cannot be observed before it was captured. Those two bounds are not a
 * threshold anyone tuned, they are the only two things that are true by construction, and together
 * they reject a rebased stream with probability `1 - elapsed/26.5h`.
 */

/** MPEG-TS presentation timestamps: 90kHz ticks, stored in 33 bits, so ~26.5 hours to a wrap. */
export const MPEGTS_TIMESCALE = 90_000;
export const MPEGTS_WRAP_TICKS = 2 ** 33;

/** A segment's first video frame, as the container stored it. */
export interface FramePts {
  /** Presentation timestamp in `timescale` ticks. */
  pts: number;
  /** Ticks per second, from the stream's `time_base`. */
  timescale: number;
  /**
   * Modulus the container counts timestamps in, or null for one that cannot wrap.
   *
   * Not derived from `timescale`, because the wrap is a property of the container rather than of the
   * rate: MPEG-TS truncates to 33 bits, and an fMP4 segment at the same 90kHz does not truncate at
   * all. Deriving it would silently apply a TS wrap to a container that has none.
   */
  wrapTicks: number | null;
}

/** Both ends of the window a real capture instant has to fall inside, on one machine's clock. */
export interface CaptureWindow {
  /** When the publisher process was started. Nothing it captured can predate this. */
  publishStartedAtMs: number;
  /** When the segment carrying this frame finished downloading. Nothing can be observed before capture. */
  observedAtMs: number;
}

/**
 * Thrown when the timestamps did not survive the pipeline, rather than returning the number anyway.
 *
 * Separate from a plain `Error` so a runner can tell "this deployment cannot be measured this way"
 * from "the run failed", and report the first as a result instead of a crash.
 */
export class UnusableTimestampsError extends Error {
  constructor(message: string, readonly impliedLatencyMs: number, readonly window: CaptureWindow) {
    super(message);
    this.name = 'UnusableTimestampsError';
  }
}

function wrapPeriodMs(frame: FramePts): number | null {
  return frame.wrapTicks === null ? null : (frame.wrapTicks / frame.timescale) * 1_000;
}

/**
 * The wall-clock instant `frame` was captured, as a raw reading with no plausibility check applied.
 *
 * Exported for the report, which shows the implied instant next to a rejection so an operator can see
 * *how* wrong it was. Callers measuring latency want `latencyMsFromPts`, which bounds it.
 */
export function impliedCaptureInstantMs(frame: FramePts, window: CaptureWindow): number {
  const stampMs = (frame.pts / frame.timescale) * 1_000;
  const periodMs = wrapPeriodMs(frame);
  if (periodMs === null) {
    return stampMs;
  }
  // The congruent instant at or before the observation, which is the only one a real capture can be.
  const sinceCapture = (((window.observedAtMs - stampMs) % periodMs) + periodMs) % periodMs;
  return window.observedAtMs - sinceCapture;
}

/**
 * How far behind the publisher's clock this frame arrived, in milliseconds.
 *
 * Both timestamps must come from the same machine's clock, which is why the publisher and the fetch
 * both run on the bench host: a measurement split across two clocks would carry their skew, and skew
 * between machines is routinely larger than the effect Sprint 5 is trying to detect.
 *
 * @throws UnusableTimestampsError when the implied capture instant falls outside `window`.
 */
export function latencyMsFromPts(frame: FramePts, window: CaptureWindow): number {
  const capturedAtMs = impliedCaptureInstantMs(frame, window);
  const latencyMs = window.observedAtMs - capturedAtMs;
  const elapsedMs = window.observedAtMs - window.publishStartedAtMs;

  if (latencyMs < 0 || latencyMs > elapsedMs) {
    throw new UnusableTimestampsError(
      `the segment's first frame implies it was captured ${describeOffset(latencyMs, elapsedMs)}, ` +
        'which cannot happen. The wall-clock timestamps the publisher wrote did not survive the ' +
        'pipeline, most likely because the media engine rebased the stream to start at zero when it ' +
        'repackaged. Latency cannot be measured this way against this deployment; the per-hop split ' +
        'from the uploader log still can.',
      latencyMs,
      window,
    );
  }

  return latencyMs;
}

function describeOffset(latencyMs: number, elapsedMs: number): string {
  if (latencyMs < 0) {
    return `${(-latencyMs / 1_000).toFixed(1)}s after it was fetched`;
  }
  return (
    `${(latencyMs / 1_000).toFixed(1)}s ago, which is before the publisher started ` +
    `${(elapsedMs / 1_000).toFixed(1)}s ago`
  );
}
