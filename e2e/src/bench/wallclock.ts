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
 * 1785677886.564 came back with a first pts of 1923644272 ticks. 1785677886564 x 90 mod 2^33 is
 * 1923509032 ticks, leaving 135240 ticks, or 1.5027s, which is what that build spends between
 * spawning and encoding its first frame. Running the same publish through ffmpeg's own HLS muxer, the
 * closest local stand-in for what a media engine does to the stream, preserved it.
 *
 * Those two integers are asserted in `wallclock.test.ts`, because the previous pair here were each
 * nine ticks out and nothing noticed: the only test over them rounded to the millisecond, and at that
 * resolution a wrong anchor and a right one agree.
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
  /**
   * How far the publisher's media timeline runs ahead of wall clock, from the run's own self-check.
   *
   * **Required rather than defaulted, and it is the anchor rather than a correction applied after.**
   * A stamp carries `capture + lead`, so the latest value a real one can hold is `observedAtMs +
   * lead`, not `observedAtMs`. Folding against the observation instead throws any frame that beat the
   * lead a whole wrap period into the past, where it is rejected as "captured before the publisher
   * started".
   *
   * That is not a corner case, it is a censor aimed at the best configurations. Measured 2026-08-05
   * against a lead of 1386ms: at a 2.0s GOP the fastest segment measured 3028ms and nothing was lost,
   * while at a 0.5s GOP the fastest surviving segment measured 1432ms, **46ms above the lead**, and
   * 79% of a three-minute run was discarded. The survivors were the slow tail, so the faster a
   * deployment got, the worse this instrument reported it.
   */
  mediaTimelineLeadMs: number;
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
  // Folded against the latest value a real stamp can carry, which is the observation plus however far
  // the publisher's timeline runs ahead of it. Folding against the observation alone puts the fold
  // line inside the range of stamps a fast deployment legitimately produces. See `CaptureWindow`.
  const latestStampMs = window.observedAtMs + window.mediaTimelineLeadMs;
  const sinceCapture = (((latestStampMs - stampMs) % periodMs) + periodMs) % periodMs;
  return latestStampMs - sinceCapture;
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

  // Checked before the bounds because the bounds cannot check it: every comparison against `NaN` is
  // false, so a `NaN` latency satisfies neither `< 0` nor `> elapsedMs` and would be returned as a
  // reading. It reaches here from a tick rate of zero, which divides a timestamp into infinity. The
  // damage would not stop at one wrong figure either, since `impossibleHops` compares the same way
  // and would not flag it, and the median sort would order the run around a value nothing orders.
  if (!Number.isFinite(latencyMs)) {
    throw new UnusableTimestampsError(
      "the segment's first frame implies a capture instant that is not a finite number, so either " +
        'its timestamp or the tick rate it is counted in is unusable. This is a broken reading ' +
        'rather than a surprising one, and it is refused here so that it cannot be reported as a ' +
        'latency that no later check would question.',
      latencyMs,
      window,
    );
  }

  // Bounded on the wall-clock latency rather than on the timeline one, because the two differ by the
  // lead and only the first has bounds that are true by construction. A frame cannot be captured
  // before the publisher started, and cannot be observed before it was captured. Comparing the
  // timeline latency against zero instead rejects everything faster than the lead, which is a real
  // and reachable region rather than an impossible one.
  const wallClockLatencyMs = latencyMs + window.mediaTimelineLeadMs;
  if (wallClockLatencyMs < 0 || wallClockLatencyMs > elapsedMs) {
    throw new UnusableTimestampsError(
      `the segment's first frame implies it was captured ${describeOffset(wallClockLatencyMs, elapsedMs)}, ` +
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

/**
 * When a segment's picture was really taken, which is the last step of the conversion above.
 *
 * `latencyMsFromPts` answers how far behind the *publisher's timeline* a frame arrived, and that
 * timeline is not wall clock: it is measured to run a fixed distance ahead of it, because ffmpeg
 * emits about 1.4s of media faster than real time as it starts and the output timeline never
 * resyncs. See `measureMediaTimelineLead`, which is where the quantity comes from.
 *
 * A function rather than an expression at the one call site, so the correction can be asserted. Left
 * inline it was a term nothing could see the absence of: drop it and every test in the repository
 * still passes, while every latency in every report quietly reads 1.4 seconds fast.
 *
 * @param leadMs how far the publisher's timeline runs ahead of wall clock. Zero for a publisher that keeps time.
 */
export function captureInstantMs(observedAtMs: number, latencyMs: number, leadMs: number): number {
  return observedAtMs - latencyMs - leadMs;
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
