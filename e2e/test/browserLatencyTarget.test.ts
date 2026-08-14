import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LIVE_SYNC_DURATION_S } from '../src/bench/clientTuning.js';
import { latencySection } from '../src/browser/report.js';
import { judgeLatency, judgeLatencyTarget, summarize, type ViewerSample } from '../src/browser/session.js';

const BASE: ViewerSample = {
  atMs: 0,
  currentTime: 0,
  paused: false,
  readyState: 4,
  playbackRate: 1,
  bufferAheadS: 8,
  liveLatencyS: LIVE_SYNC_DURATION_S,
  liveTargetLatencyS: LIVE_SYNC_DURATION_S,
  bufferStalls: 0,
  rebufferCount: 0,
  rebufferMs: 0,
  fatalErrors: 0,
  decodedFrames: 0,
  droppedFrames: 0,
  resolution: '1920×1080',
  feedStateMessage: null,
};

function run(...steps: readonly Partial<ViewerSample>[]): ViewerSample[] {
  return steps.map((step, i) => ({ ...BASE, atMs: i * 1000, currentTime: i, ...step }));
}

/**
 * The confound this exists to catch, and the run that paid for it.
 *
 * hls.js adds `min(stallCount, targetduration)` to the configured `liveSyncDuration` and never takes
 * it back, so a single non-fatal stall moves the target a viewer is steered to for the rest of the
 * session. Latency then settles around the moved target, and every latency figure in the run is
 * against a different question from one measured without the stall.
 *
 * On 2026-08-07 the 1080p ABA ran two identical 0.25s control arms twenty minutes apart. They came
 * back 5.89s and 6.81s, which voided the comparison, and the write-up could only call it an
 * unexplained drift in the sitting. Inverting hls.js's own catch-up curve against the archived
 * samples puts arm 1's target at 6.0 and arm 3's at about 7.0. Both arms reported zero rebuffers,
 * zero stalled samples and zero fatal errors, so nothing in either report could have said so.
 */
describe('whether the run was measured against the target it was configured with', () => {
  it('says the target held when the player never left the configured value', () => {
    const verdict = judgeLatencyTarget(run({}, {}, {}));

    assert.equal(verdict.held, true);
    assert.equal(verdict.configuredS, LIVE_SYNC_DURATION_S);
    assert.equal(verdict.raisedByS, 0);
  });

  /**
   * ⛔⛔⛔ The regression this file existed to prevent, reintroduced one level up and shipped.
   *
   * `BROWSER_TARGET_LATENCY_S` has moved arms to 6, 2 and 1.5 since PR #186, and until 2026-08-14
   * this verdict compared every one of them against the compile-time `LIVE_SYNC_DURATION_S`. The
   * 2026-08-14 sitting ran four arms at 2s that each reported `worstS: 3`, a full second of raise,
   * beside a verdict reading `raisedByS: 0, held: true`.
   *
   * Every test above passes the default target, so none of them could see it. **A parameter with a
   * default is only tested by a case that passes something else.**
   */
  it('judges a moved target against the value this run asked for, not the compiled default', () => {
    const raisedPastTwo = run({ liveTargetLatencyS: 2 }, { liveTargetLatencyS: 3, bufferStalls: 1 });

    const verdict = judgeLatencyTarget(raisedPastTwo, 2);

    assert.equal(verdict.configuredS, 2, 'the verdict names a target this run never asked for');
    assert.equal(verdict.raisedByS, 1, 'a second of raise past a 2s target read as none');
    assert.equal(verdict.held, false, 'a target that moved 2 to 3 cannot be reported as held');
  });

  it('carries the run target through summarize, which is where the watch loses it', () => {
    const raisedPastTwo = run({ liveTargetLatencyS: 2 }, { liveTargetLatencyS: 3, bufferStalls: 1 });

    assert.equal(summarize(raisedPastTwo, 2).latencyTarget.held, false);
    assert.equal(summarize(raisedPastTwo, 2).latencyTarget.configuredS, 2);
  });

  it('catches a target raised part way through, which is the shape a stall makes', () => {
    const verdict = judgeLatencyTarget(run({}, {}, { liveTargetLatencyS: LIVE_SYNC_DURATION_S + 1, bufferStalls: 1 }));

    assert.equal(verdict.held, false);
    assert.equal(verdict.raisedByS, 1);
    assert.equal(verdict.stalls, 1);
  });

  /**
   * The join case, and the one that voided the 1080p arm. The stall happened before the first sample,
   * so there is no step to notice: every sample the run ever took was already against the raised
   * target. A check that compared samples against each other would call this a clean run.
   */
  it('catches a target that was already raised on the first sample', () => {
    const verdict = judgeLatencyTarget(
      run(
        { liveTargetLatencyS: LIVE_SYNC_DURATION_S + 1, bufferStalls: 1 },
        { liveTargetLatencyS: LIVE_SYNC_DURATION_S + 1, bufferStalls: 1 },
      ),
    );

    assert.equal(verdict.held, false);
    assert.equal(verdict.raisedByS, 1);
  });

  it('reports the worst target the run ever steered to, not the last one', () => {
    const verdict = judgeLatencyTarget(run({}, { liveTargetLatencyS: LIVE_SYNC_DURATION_S + 1, bufferStalls: 1 }, {}));

    assert.equal(verdict.worstS, LIVE_SYNC_DURATION_S + 1);
    assert.equal(verdict.raisedByS, 1);
  });

  // Null until hls.js has computed one, which is the first sample or two of every run.
  it('ignores samples taken before the player had a target', () => {
    const verdict = judgeLatencyTarget(run({ liveTargetLatencyS: null }, {}, {}));

    assert.equal(verdict.held, true);
    assert.equal(verdict.worstS, LIVE_SYNC_DURATION_S);
  });

  /**
   * Not held, rather than held. A run that never read a target has not shown that the target was
   * steady, and this project has been caught before by a check whose empty case reads as a pass.
   */
  it('refuses to call a target held when it never saw one', () => {
    const verdict = judgeLatencyTarget(run({ liveTargetLatencyS: null }, { liveTargetLatencyS: null }));

    assert.equal(verdict.held, false);
    assert.equal(verdict.worstS, null);
    assert.equal(verdict.raisedByS, 0);
  });

  it('has something to say about a run with no samples at all', () => {
    const verdict = judgeLatencyTarget([]);

    assert.equal(verdict.held, false);
    assert.equal(verdict.worstS, null);
    assert.equal(verdict.stalls, 0);
  });

  /**
   * The overlay formats to two decimals, so a target of exactly the configured value survives the
   * round trip as itself. A tolerance wider than that formatting would swallow the smallest raise
   * hls.js can make, which is a whole second at every segment length this deployment runs.
   */
  it('does not call a raise held because the overlay rounded it', () => {
    const verdict = judgeLatencyTarget(run({ liveTargetLatencyS: LIVE_SYNC_DURATION_S + 0.5 }));

    assert.equal(verdict.held, false);
  });

  /**
   * The measure that survives a stall, and the reason it is worth carrying.
   *
   * Subtracting each sample's own target collapses the two 1080p control arms from 0.92s apart to
   * 0.08s (5.89 against a 6.0 target, 6.81 against about 7.0) while leaving the 0.81s effect intact.
   * ⚠️ That arithmetic is a **reconstruction**, since arm 3's target was inverted out of a single
   * catch-up sample rather than recorded, so it is the reason for the measure and not a result.
   */
  it('measures latency against the target the player was steering to, per sample', () => {
    const verdict = judgeLatencyTarget(
      run(
        { liveLatencyS: 6.81, liveTargetLatencyS: 7 },
        { liveLatencyS: 6.81, liveTargetLatencyS: 7 },
        { liveLatencyS: 6.81, liveTargetLatencyS: 7 },
      ),
    );

    assert.equal(verdict.medianPastTargetS?.toFixed(2), '-0.19');
  });

  /**
   * Per sample rather than median-minus-median, pinned by a case where the two disagree.
   *
   * ⚠️ Most shapes cannot tell them apart. A run that sits flat either side of a target step gives
   * the same answer both ways, which is how the first version of this test passed against a
   * deliberately median-minus-median implementation. Separating them needs latency and target to move
   * out of step, which is exactly what a stall does: latency spikes in the same moment the target is
   * raised, so the two medians come from different samples and pairing them is the whole point.
   */
  it('is not a difference of medians, pinned where the two definitions disagree', () => {
    const verdict = judgeLatencyTarget(
      run(
        { liveLatencyS: 6.05, liveTargetLatencyS: 6 },
        { liveLatencyS: 9.33, liveTargetLatencyS: 7 },
        { liveLatencyS: 6.9, liveTargetLatencyS: 7 },
      ),
    );

    // Per sample: +0.05, +2.33, -0.10, median +0.05.
    // Median of latencies 6.90 minus median of targets 7.00 would be -0.10.
    assert.equal(verdict.medianPastTargetS?.toFixed(2), '0.05');
  });

  it('says nothing about the distance when a sample is missing either half', () => {
    assert.equal(judgeLatencyTarget(run({ liveLatencyS: null })).medianPastTargetS, null);
    assert.equal(judgeLatencyTarget(run({ liveTargetLatencyS: null })).medianPastTargetS, null);
  });

  it('counts stalls across a restart, which resets the player counter to zero', () => {
    const verdict = judgeLatencyTarget(run({ bufferStalls: 2 }, { bufferStalls: 3 }, { bufferStalls: 1 }));

    assert.equal(verdict.stalls, 4);
  });
});

/**
 * The verdict has to reach the document, beside the numbers it governs.
 *
 * A run's latency figures were readable on their own and unreadable against another run's, and no
 * reader could tell the two apart. The place that has to say so is the section that prints the
 * figures, not a footnote further down.
 */
describe('what the latency section says about the target it was measured against', () => {
  const sectionFor = (...steps: readonly Partial<ViewerSample>[]): string =>
    latencySection({
      measuredAt: '2026-08-07T00:00:00.000Z',
      watchUrl: 'http://127.0.0.1/#/watch/x',
      chromeVersion: 'Chrome test',
      gopSeconds: 0.25,
      summary: summarize(run(...steps)),
      instrument: { sound: true, failures: [], firedChecks: [], soundSamples: steps.length },
      samples: [],
      screenshots: [],
    }).join('\n');

  it('says the figures are comparable when the target held', () => {
    const section = sectionFor({}, {}, {});

    assert.match(section, /Measured against the configured target throughout/);
    assert.doesNotMatch(section, /not comparable/);
  });

  it('says the figures are not comparable when a stall moved the target', () => {
    const section = sectionFor({}, { liveTargetLatencyS: LIVE_SYNC_DURATION_S + 1, bufferStalls: 1 });

    assert.match(section, /not comparable with another run/);
    assert.match(section, /1\.00s past the configured 6s/);
    assert.match(section, /1 buffer stall\b/, 'one stall, not "1 buffer stalls"');
  });

  // The failure that made this necessary: the run reads perfectly on every other row.
  it('says so even when every other row in the report is clean', () => {
    const section = sectionFor(
      { liveTargetLatencyS: LIVE_SYNC_DURATION_S + 1, bufferStalls: 1, rebufferCount: 0, fatalErrors: 0 },
      { liveTargetLatencyS: LIVE_SYNC_DURATION_S + 1, bufferStalls: 1, rebufferCount: 0, fatalErrors: 0 },
    );

    assert.match(section, /⛔ \*\*The latency figures above are against a target that moved/);
  });

  // The prose has to stay true in the corner as well as the common case: "what is still comparable is
  // not measurable from this run" is a sentence that contradicts itself.
  it('does not offer a replacement figure it does not have', () => {
    const section = sectionFor(
      { liveLatencyS: null, liveTargetLatencyS: LIVE_SYNC_DURATION_S + 1, bufferStalls: 1 },
      { liveLatencyS: null, liveTargetLatencyS: LIVE_SYNC_DURATION_S + 1, bufferStalls: 1 },
    );

    assert.match(section, /nothing here is comparable instead/);
    assert.doesNotMatch(section, /What is still comparable/);
  });

  it('says it could not tell, rather than saying it held, when no target was reported', () => {
    const section = sectionFor({ liveTargetLatencyS: null }, { liveTargetLatencyS: null });

    assert.match(section, /never reported a latency target/);
    assert.doesNotMatch(section, /Measured against the configured target throughout/);
  });
});

/**
 * The join is read off the first sample that had a latency, and until 2026-08-07 that included
 * samples taken before playback began.
 *
 * `browser-watch-2026-08-07T09-47-47-623Z` is the run that exposed it. Its first sample sits at
 * `readyState 1` with 0.99s buffered and reports **37.00s** behind live, which is the whole live
 * window: `hls.latency` is computed against the playlist edge whether or not the player has picked a
 * position yet. One second later the same run reads 6.28s at `readyState 4`.
 *
 * ⛔ **Nothing seeked.** `currentTime` goes 31.01 to 32.17 across that pair, a normal 1.16s step at
 * the catch-up rate. The report nonetheless printed "the join was a jump, so hls.js seeked to the
 * edge", which describes an event that did not happen, and `a-quarter-second-buys-nothing` drew a
 * conclusion about segment length from joins measured this way.
 */
describe('reading the join from a player that had actually started', () => {
  it('skips samples taken before the player could play, however large their latency', () => {
    const verdict = judgeLatency(
      run(
        { liveLatencyS: 37, readyState: 1, bufferAheadS: 0.99 },
        { liveLatencyS: 6.28, readyState: 4 },
        { liveLatencyS: 6.1, readyState: 4 },
      ),
    );

    assert.equal(verdict.joinLatencyS, 6.28);
    assert.equal(verdict.joinedPastSeekThreshold, false, 'no seek happened, and none should be claimed');
  });

  it('still reports a genuine jump, where the player was playing when it read one', () => {
    const verdict = judgeLatency(run({ liveLatencyS: 37, readyState: 4 }, { liveLatencyS: 6.28, readyState: 4 }));

    assert.equal(verdict.joinLatencyS, 37);
    assert.equal(verdict.joinedPastSeekThreshold, true);
  });

  // Falling back rather than reporting nothing: a run where the player never reached a playable state
  // still has a first latency, and it is the only thing there is to say about the join.
  it('falls back to the first latency when the player never became playable', () => {
    const verdict = judgeLatency(run({ liveLatencyS: 9.5, readyState: 1 }, { liveLatencyS: 9.4, readyState: 2 }));

    assert.equal(verdict.joinLatencyS, 9.5);
  });

  it('leaves the median alone, which is over every sample that had a latency', () => {
    const verdict = judgeLatency(
      run({ liveLatencyS: 37, readyState: 1 }, { liveLatencyS: 6, readyState: 4 }, { liveLatencyS: 6, readyState: 4 }),
    );

    assert.equal(verdict.medianLatencyS, 6);
    assert.equal(verdict.maxLatencyS, 37, 'the excursion is still visible, it is just not called a join');
  });
});
