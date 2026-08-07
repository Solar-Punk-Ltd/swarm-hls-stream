import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { measureMediaTimelineLead, type ProbedCheckSegment, requireSpansMeetEndToEnd } from '../src/bench/selfCheck.js';

/**
 * The local instrument check's contiguity rule, driven directly.
 *
 * It had no test at all. Nothing in `test/` imported `selfCheck.ts`, and its only caller anywhere is
 * the `bench:latency` entry point, so replacing the whole function body with `return` left every test
 * green. That is worse than an untested check, because the check is what a run leans on before it
 * spends postage, and it was reporting as coverage.
 *
 * Running ffmpeg is not what stood in the way. Producing these three numbers needs a publish, and
 * comparing them is arithmetic, which is the same split that put `segmentSpan.ts` beside `probe.ts`.
 */

const FRAME_MS = 1_000 / 30;
const SPAN_MS = 2_000;

/**
 * Segments starting `startsAtMs` apart, each claiming to hold `spans[i]` of media.
 *
 * `closedAtMs` defaults to the instant the span says the segment finished, which is a lead of zero.
 * The contiguity tests below are indifferent to it, and the lead tests pass their own.
 */
function probed(
  startsAtMs: readonly number[],
  spans: readonly number[],
  closedAtMs?: readonly number[],
): ProbedCheckSegment[] {
  return startsAtMs.map((capturedAt, index) => ({
    capturedAtMs: capturedAt,
    mediaSpanMs: spans[index],
    frameDurationMs: FRAME_MS,
    closedAtMs: closedAtMs?.[index] ?? capturedAt + spans[index],
  }));
}

describe('the local check that each span reaches the next segment', () => {
  it('accepts spans that meet the next segment exactly', () => {
    const starts = [0, SPAN_MS, 2 * SPAN_MS, 3 * SPAN_MS];

    requireSpansMeetEndToEnd(probed(starts, [SPAN_MS, SPAN_MS, SPAN_MS, SPAN_MS]));
  });

  /**
   * The error the arithmetic exists to prevent, at exactly the size it comes in. Reading the ends of
   * a reordered packet list, or forgetting the final frame's credit, is one frame short and no more.
   */
  it('refuses a span that falls one frame short of the next start', () => {
    const starts = [0, SPAN_MS, 2 * SPAN_MS];

    assert.throws(
      () => requireSpansMeetEndToEnd(probed(starts, [SPAN_MS - FRAME_MS, SPAN_MS, SPAN_MS])),
      (error: Error) => {
        assert.match(error.message, /failed its own local check/);
        assert.match(error.message, /33ms unaccounted for against a frame of 33ms/);
        return true;
      },
    );
  });

  /** Overlap is as impossible as a gap, and the message has to survive a negative shortfall. */
  it('refuses a span that runs a frame past the next start', () => {
    const starts = [0, SPAN_MS, 2 * SPAN_MS];

    assert.throws(() => requireSpansMeetEndToEnd(probed(starts, [SPAN_MS + FRAME_MS, SPAN_MS, SPAN_MS])), /-33ms/);
  });

  /**
   * The tolerance is half a frame, which is the widest value that still separates a correct span from
   * one a whole frame out. Anything it leaves room for is float error in two tick conversions.
   */
  it('accepts noise inside half a frame', () => {
    const starts = [0, SPAN_MS, 2 * SPAN_MS];

    requireSpansMeetEndToEnd(probed(starts, [SPAN_MS - FRAME_MS * 0.49, SPAN_MS, SPAN_MS]));
  });

  /**
   * The final segment was cut by the interrupt and has nothing after it to meet, so its span is never
   * inspected. Asserted rather than left implicit, because the alternative reading of "excluded" is
   * that the loop stops one early and skips a real pair.
   */
  it('never inspects the final segment span, which nothing follows', () => {
    const starts = [0, SPAN_MS, 2 * SPAN_MS];

    requireSpansMeetEndToEnd(probed(starts, [SPAN_MS, SPAN_MS, 999_999]));
  });

  it('checks every pair rather than only the first', () => {
    const starts = [0, SPAN_MS, 2 * SPAN_MS, 3 * SPAN_MS];

    assert.throws(
      () => requireSpansMeetEndToEnd(probed(starts, [SPAN_MS, SPAN_MS, SPAN_MS - FRAME_MS, SPAN_MS])),
      /segment 2 measures/,
    );
  });

  /**
   * `runCheck` refuses a publish that produced too few segments before reaching here, so these are
   * unreachable through it. They pass silently rather than throwing, which is the right answer for a
   * check with nothing to compare, and is asserted so a later caller cannot be surprised by it.
   */
  it('has nothing to say about one segment or none', () => {
    requireSpansMeetEndToEnd([]);
    requireSpansMeetEndToEnd(probed([0], [SPAN_MS]));
  });
});

/**
 * The quantity that turned five impossible `upload` hops into five possible ones.
 *
 * Measured on 2026-08-03: the publisher emits about 1.4 seconds of media faster than real time while
 * ffmpeg starts up, and its output timeline never resyncs, so every timestamp afterwards claims a
 * later capture instant than the truth. The two runs taken before this existed reported 1.4s less
 * latency than they had measured, and every `upload` reading in both was negative.
 *
 * These drive the arithmetic directly. Producing the inputs needs a publish; comparing them is
 * subtraction over three numbers, which is the same split the contiguity check above sits on.
 */
describe('measuring how far the publisher runs ahead of wall clock', () => {
  const LEAD_MS = 1_393;

  it('reports the lead as the gap between where the media says it ended and when it was written', () => {
    const starts = [0, SPAN_MS, 2 * SPAN_MS];
    const spans = [SPAN_MS, SPAN_MS, SPAN_MS];
    const closes = starts.map((start) => start + SPAN_MS - LEAD_MS);

    const { leadMs, spreadMs } = measureMediaTimelineLead(probed(starts, spans, closes));

    assert.equal(leadMs, LEAD_MS);
    assert.equal(spreadMs, 0);
  });

  /**
   * The degenerate case, and the one that makes the test above mean anything. A publisher whose
   * timeline keeps time has nothing to correct, and a function that returned any fixed quantity
   * would pass the first test and fail this one.
   */
  it('reports no lead when the media timeline agrees with the wall clock', () => {
    const starts = [0, SPAN_MS, 2 * SPAN_MS];

    const { leadMs } = measureMediaTimelineLead(probed(starts, [SPAN_MS, SPAN_MS, SPAN_MS]));

    assert.equal(leadMs, 0);
  });

  /** A timeline that lags rather than leads is a real reading too, and it has to keep its sign. */
  it('reports a negative lead for a timeline that runs behind the wall clock', () => {
    const starts = [0, SPAN_MS];
    const closes = [SPAN_MS + 300, 2 * SPAN_MS + 300];

    const { leadMs } = measureMediaTimelineLead(probed(starts, [SPAN_MS, SPAN_MS], closes));

    assert.equal(leadMs, -300);
  });

  it('takes the median, so one outlying segment does not move the correction', () => {
    const starts = [0, SPAN_MS, 2 * SPAN_MS];
    const spans = [SPAN_MS, SPAN_MS, SPAN_MS];
    const closes = [SPAN_MS - LEAD_MS, 2 * SPAN_MS - LEAD_MS - 100, 3 * SPAN_MS - LEAD_MS + 100];

    const { leadMs } = measureMediaTimelineLead(probed(starts, spans, closes));

    assert.equal(leadMs, LEAD_MS);
  });

  /**
   * Refused rather than averaged. This is subtracted from every capture instant a run measures, so an
   * estimate that scatters moves every latency in the report by however wrong it is, and it would do
   * so silently. Across 44 real segments the quantity held to within 2ms.
   */
  it('refuses an estimate too scattered to subtract', () => {
    const starts = [0, SPAN_MS, 2 * SPAN_MS];
    const spans = [SPAN_MS, SPAN_MS, SPAN_MS];
    const closes = [SPAN_MS - LEAD_MS, 2 * SPAN_MS - LEAD_MS - 4_000, 3 * SPAN_MS - LEAD_MS + 4_000];

    assert.throws(
      () => measureMediaTimelineLead(probed(starts, spans, closes)),
      /ahead of wall clock across 3 segment\(s\), a spread of 4000ms/,
    );
  });
});
