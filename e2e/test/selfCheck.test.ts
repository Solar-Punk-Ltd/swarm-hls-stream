import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type ProbedCheckSegment, requireSpansMeetEndToEnd } from '../src/bench/selfCheck.js';

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

/** Segments starting `startsAtMs` apart, each claiming to hold `spans[i]` of media. */
function probed(startsAtMs: readonly number[], spans: readonly number[]): ProbedCheckSegment[] {
  return startsAtMs.map((capturedAtMs, index) => ({
    capturedAtMs,
    mediaSpanMs: spans[index],
    frameDurationMs: FRAME_MS,
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
