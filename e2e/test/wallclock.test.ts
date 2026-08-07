import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  captureInstantMs,
  type CaptureWindow,
  type FramePts,
  impliedCaptureInstantMs,
  latencyMsFromPts,
  MPEGTS_TIMESCALE,
  MPEGTS_WRAP_TICKS,
  UnusableTimestampsError,
} from '../src/bench/wallclock.js';

/**
 * One real measurement, kept as the anchor for everything below.
 *
 * Produced by `ffmpeg 7.1.1 -use_wallclock_as_timestamps 1 -f lavfi -i testsrc2 -copyts -f mpegts`
 * on 2026-08-02: the process started at epoch 1785677886.564 and the first video packet came back
 * with pts 1923644272. Every other case in this file is a variation on these numbers, so if the
 * recipe in `wallclockPublisher.ts` ever stops carrying the clock, this is the reading to reproduce
 * before believing the parser is at fault.
 */
const REAL_PUBLISH_START_MS = 1_785_677_886_564;
const REAL_FIRST_PTS = 1_923_644_272;
/** Time that ffmpeg build spends between spawning and stamping its first frame. */
const REAL_STARTUP_MS = 1_503;

const TS_FRAME: FramePts = { pts: REAL_FIRST_PTS, timescale: MPEGTS_TIMESCALE, wrapTicks: MPEGTS_WRAP_TICKS };

function ptsForInstant(epochMs: number): number {
  return Math.round(((epochMs / 1_000) * MPEGTS_TIMESCALE) % MPEGTS_WRAP_TICKS);
}

function windowFrom(startMs: number, observedMs: number, leadMs = 0): CaptureWindow {
  return { publishStartedAtMs: startMs, observedAtMs: observedMs, mediaTimelineLeadMs: leadMs };
}

describe('reading a wall-clock instant back out of an MPEG-TS timestamp', () => {
  it('recovers the capture instant from the pts ffmpeg actually wrote', () => {
    const observedAtMs = REAL_PUBLISH_START_MS + 30_000;

    const capturedAtMs = impliedCaptureInstantMs(TS_FRAME, windowFrom(REAL_PUBLISH_START_MS, observedAtMs));

    assert.equal(Math.round(capturedAtMs), REAL_PUBLISH_START_MS + REAL_STARTUP_MS);
  });

  /**
   * The two integers the module header cites, put somewhere that runs. The header had them nine ticks
   * out apiece, and the assertion above could not catch that because it rounds to the millisecond:
   * 135231 ticks and 135240 ticks are 1502.567ms and 1502.667ms, and both round to the 1503 it wants.
   */
  it('folds the anchor exactly where the module header says it does', () => {
    const anchorTicks = (REAL_PUBLISH_START_MS * (MPEGTS_TIMESCALE / 1_000)) % MPEGTS_WRAP_TICKS;

    assert.equal(anchorTicks, 1_923_509_032);
    assert.equal(REAL_FIRST_PTS - anchorTicks, 135_240);
  });

  it('measures the latency as the gap between capture and fetch', () => {
    const capturedAtMs = REAL_PUBLISH_START_MS + REAL_STARTUP_MS;
    const observedAtMs = capturedAtMs + 8_400;

    const latencyMs = latencyMsFromPts(TS_FRAME, windowFrom(REAL_PUBLISH_START_MS, observedAtMs));

    assert.equal(Math.round(latencyMs), 8_400);
  });

  /**
   * The case the 33-bit field exists to create. A publisher started just before a wrap and observed
   * just after it sees a pts smaller than the one it wrote, and subtracting without folding gives a
   * latency of nearly 26.5 hours. Nothing else in the pipeline would notice.
   */
  it('folds a timestamp that wrapped between capture and fetch', () => {
    const wrapPeriodMs = (MPEGTS_WRAP_TICKS / MPEGTS_TIMESCALE) * 1_000;
    // A capture instant two seconds before a wrap boundary, and a fetch three seconds after it.
    const wrapAtMs = Math.ceil(REAL_PUBLISH_START_MS / wrapPeriodMs) * wrapPeriodMs;
    const capturedAtMs = wrapAtMs - 2_000;
    const observedAtMs = wrapAtMs + 3_000;
    const frame: FramePts = { ...TS_FRAME, pts: ptsForInstant(capturedAtMs) };

    const latencyMs = latencyMsFromPts(frame, windowFrom(capturedAtMs - 1_000, observedAtMs));

    assert.equal(Math.round(latencyMs), 5_000);
  });

  it('leaves a container that cannot wrap alone', () => {
    const capturedAtMs = REAL_PUBLISH_START_MS + REAL_STARTUP_MS;
    const frame: FramePts = {
      pts: (capturedAtMs / 1_000) * MPEGTS_TIMESCALE,
      timescale: MPEGTS_TIMESCALE,
      wrapTicks: null,
    };

    const latencyMs = latencyMsFromPts(frame, windowFrom(REAL_PUBLISH_START_MS, capturedAtMs + 4_000));

    assert.equal(Math.round(latencyMs), 4_000);
  });

  it('reads a timescale other than 90kHz as the ticks-per-second it is', () => {
    const capturedAtMs = REAL_PUBLISH_START_MS + REAL_STARTUP_MS;
    const frame: FramePts = { pts: (capturedAtMs / 1_000) * 1_000, timescale: 1_000, wrapTicks: null };

    const latencyMs = latencyMsFromPts(frame, windowFrom(REAL_PUBLISH_START_MS, capturedAtMs + 2_500));

    assert.equal(Math.round(latencyMs), 2_500);
  });
});

/**
 * The half that decides whether this instrument can be believed at all.
 *
 * A media engine that rebases the stream to zero still yields a pts, and the modulo still yields a
 * number of seconds. Without these bounds the bench would publish that number as a latency, and the
 * whole point of LAT-1 is to produce a figure a later sprint can be measured against.
 */
describe('refusing a reading the pipeline cannot have produced', () => {
  it('rejects a stream the engine rebased to start at zero', () => {
    // What a repackaging engine emits: media offset from the start of ITS timeline, not the epoch.
    const rebased: FramePts = { ...TS_FRAME, pts: 4 * MPEGTS_TIMESCALE };
    const observedAtMs = REAL_PUBLISH_START_MS + 20_000;

    assert.throws(
      () => latencyMsFromPts(rebased, windowFrom(REAL_PUBLISH_START_MS, observedAtMs)),
      (error: unknown) => {
        assert.ok(error instanceof UnusableTimestampsError);
        assert.match(error.message, /rebased/);
        return true;
      },
    );
  });

  it('rejects a capture instant from before the publisher existed', () => {
    const observedAtMs = REAL_PUBLISH_START_MS + 20_000;
    // Stamped a minute before the publisher started, so it cannot be this run's media.
    const frame: FramePts = { ...TS_FRAME, pts: ptsForInstant(REAL_PUBLISH_START_MS - 60_000) };

    assert.throws(
      () => latencyMsFromPts(frame, windowFrom(REAL_PUBLISH_START_MS, observedAtMs)),
      UnusableTimestampsError,
    );
  });

  /**
   * Only reachable without a wrap, since folding a TS timestamp cannot produce a negative. An fMP4
   * segment carrying a timestamp from the future is what a clock stepping backwards mid-run looks
   * like, and it must not report as a small positive latency.
   */
  it('rejects a frame stamped after it was fetched', () => {
    const observedAtMs = REAL_PUBLISH_START_MS + 20_000;
    const frame: FramePts = {
      pts: ((observedAtMs + 5_000) / 1_000) * MPEGTS_TIMESCALE,
      timescale: MPEGTS_TIMESCALE,
      wrapTicks: null,
    };

    assert.throws(
      () => latencyMsFromPts(frame, windowFrom(REAL_PUBLISH_START_MS, observedAtMs)),
      UnusableTimestampsError,
    );
  });

  /**
   * The one reading the two physical bounds cannot reject by themselves, because every comparison
   * against `NaN` is false, so `latencyMs < 0` and `latencyMs > elapsedMs` are both false at once.
   * A tick rate of zero produces exactly this. Returned rather than thrown, it is not merely a wrong
   * number: `impossibleHops` would not flag it either, for the same reason, and the median sort it
   * lands in compares against it and comes out in an arbitrary order.
   */
  it('rejects a reading that is not a finite number, which the bounds alone cannot', () => {
    const observedAtMs = REAL_PUBLISH_START_MS + 20_000;
    const noTickRate: FramePts = { ...TS_FRAME, timescale: 0 };

    assert.throws(
      () => latencyMsFromPts(noTickRate, windowFrom(REAL_PUBLISH_START_MS, observedAtMs)),
      UnusableTimestampsError,
    );
  });

  it('carries the implied latency on the error, so a report can say how wrong it was', () => {
    const rebased: FramePts = { ...TS_FRAME, pts: 4 * MPEGTS_TIMESCALE };
    const observedAtMs = REAL_PUBLISH_START_MS + 20_000;

    try {
      latencyMsFromPts(rebased, windowFrom(REAL_PUBLISH_START_MS, observedAtMs));
      assert.fail('a rebased stream was accepted');
    } catch (error) {
      assert.ok(error instanceof UnusableTimestampsError);
      assert.ok(error.impliedLatencyMs > 60_000, `implied latency was ${error.impliedLatencyMs}ms`);
      assert.equal(error.window.observedAtMs, observedAtMs);
    }
  });

  /**
   * The bound is inclusive: a frame captured at the very instant the publisher started is legal, and
   * one captured a millisecond earlier is not.
   *
   * Both cases are built backwards, from the pts to the window, rather than forwards. Rounding a
   * chosen instant to the nearest 90kHz tick moves it by up to 5.6us, which is enough to land just
   * inside the bound instead of on it — so a test written the natural way passes whether the
   * comparison is `>` or `>=` and pins neither.
   */
  it('admits a latency equal to the whole elapsed run, and nothing past it', () => {
    const observedAtMs = REAL_PUBLISH_START_MS + 10_000;
    const capturedAtMs = impliedCaptureInstantMs(TS_FRAME, windowFrom(REAL_PUBLISH_START_MS, observedAtMs));

    const atTheBound = windowFrom(capturedAtMs, observedAtMs);
    const justPast = windowFrom(capturedAtMs + 1, observedAtMs);

    assert.equal(latencyMsFromPts(TS_FRAME, atTheBound), observedAtMs - capturedAtMs);
    assert.throws(() => latencyMsFromPts(TS_FRAME, justPast), UnusableTimestampsError);
  });
});

/**
 * The last step of the conversion, which is the one that had no test and could not get one while it
 * was an expression inside `measureOne`.
 *
 * The publisher's timeline is measured to run about 1.4s ahead of wall clock, so a frame stamped X
 * was captured at `X - lead`. Two runs were published before that was known, and both reported that
 * much less latency than they had measured, with every `upload` hop negative as a result.
 */
describe('correcting a capture instant for a publisher that runs ahead', () => {
  const OBSERVED_AT = 1_785_677_886_564;
  const LATENCY_MS = 6_000;
  const LEAD_MS = 1_393;

  it('moves the capture instant earlier by the lead, so the measured latency grows', () => {
    const uncorrected = captureInstantMs(OBSERVED_AT, LATENCY_MS, 0);

    const corrected = captureInstantMs(OBSERVED_AT, LATENCY_MS, LEAD_MS);

    assert.equal(uncorrected - corrected, LEAD_MS);
    assert.equal(OBSERVED_AT - corrected, LATENCY_MS + LEAD_MS);
  });

  /** A publisher that keeps time needs no correction, which is what a zero lead has to mean. */
  it('changes nothing when the publisher keeps time', () => {
    assert.equal(captureInstantMs(OBSERVED_AT, LATENCY_MS, 0), OBSERVED_AT - LATENCY_MS);
  });
});

/**
 * The arm that says a fast deployment is measurable at all.
 *
 * The publisher's timeline runs ahead of wall clock, so a stamp carries `capture + lead` and the
 * latest value a real one can hold is `observed + lead`. Folding against `observed` alone puts the
 * fold line inside the range a fast deployment legitimately produces: any frame whose wall-clock
 * latency beats the lead lands a whole wrap period in the past and is rejected as impossible.
 *
 * Not hypothetical, and not symmetric in its damage. Measured 2026-08-05 against a 1386ms lead: at a
 * 2.0s GOP the fastest segment measured 3028ms and nothing was lost, while at a 0.5s GOP the fastest
 * survivor measured 1432ms, 46ms clear of the lead, and 79% of a three-minute run was discarded. The
 * survivors are the slow tail, so the better a configuration was the worse it was reported to be.
 */
describe('measuring a deployment that beats the publisher lead (2026-08-05)', () => {
  const LEAD_MS = 1_386;
  const PUBLISH_START = REAL_PUBLISH_START_MS;

  /** A frame captured `latencyMs` before it was observed, stamped on a timeline that leads by `LEAD_MS`. */
  function frameCapturedAgo(latencyMs: number, observedAtMs: number): FramePts {
    return {
      pts: ptsForInstant(observedAtMs - latencyMs + LEAD_MS),
      timescale: MPEGTS_TIMESCALE,
      wrapTicks: MPEGTS_WRAP_TICKS,
    };
  }

  for (const latencyMs of [3_028, 1_432, 900, 200]) {
    it(`reads a ${latencyMs}ms latency rather than discarding it`, () => {
      const observedAtMs = PUBLISH_START + 60_000;
      const frame = frameCapturedAgo(latencyMs, observedAtMs);

      const timelineLatencyMs = latencyMsFromPts(frame, windowFrom(PUBLISH_START, observedAtMs, LEAD_MS));

      // The function answers in the publisher's timeline, and `captureInstantMs` puts it back on wall
      // clock. Asserting the round trip rather than the intermediate, since that is what a report uses.
      const capturedAtMs = captureInstantMs(observedAtMs, timelineLatencyMs, LEAD_MS);
      assert.equal(Math.round(observedAtMs - capturedAtMs), latencyMs);
    });
  }

  /** The arm that fails on the old anchoring, which is the whole point of the block. */
  it('rejects the same frames when the lead is not carried into the fold', () => {
    const observedAtMs = PUBLISH_START + 60_000;
    const beatsTheLead = frameCapturedAgo(900, observedAtMs);

    assert.throws(
      () => latencyMsFromPts(beatsTheLead, windowFrom(PUBLISH_START, observedAtMs, 0)),
      UnusableTimestampsError,
      'a frame faster than the lead was accepted without the lead, so this fixture proves nothing',
    );
  });

  /** The bounds still have to reject what is genuinely impossible, or the fix has only widened a hole. */
  it('still refuses a capture instant from before the publisher existed', () => {
    const observedAtMs = PUBLISH_START + 10_000;
    const tooOld = frameCapturedAgo(30_000, observedAtMs);

    assert.throws(
      () => latencyMsFromPts(tooOld, windowFrom(PUBLISH_START, observedAtMs, LEAD_MS)),
      UnusableTimestampsError,
    );
  });
});
