import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LIVE_SYNC_DURATION_S } from '../src/bench/clientTuning.js';
import { judgeLatency, playbackAdvances, summarize, type ViewerSample } from '../src/browser/session.js';

const BASE: ViewerSample = {
  atMs: 0,
  currentTime: 0,
  paused: false,
  readyState: 4,
  playbackRate: 1,
  bufferAheadS: 8,
  liveLatencyS: LIVE_SYNC_DURATION_S,
  rebufferCount: 0,
  rebufferMs: 0,
  fatalErrors: 0,
  droppedFrames: 0,
  resolution: '1280×720',
  feedStateMessage: null,
};

/** A run of samples one second apart, each advancing `advance` media seconds. */
function playing(count: number, advance: number, overrides: Partial<ViewerSample> = {}): ViewerSample[] {
  return Array.from({ length: count }, (_, i) => ({
    ...BASE,
    atMs: i * 1000,
    currentTime: i * advance,
    ...overrides,
  }));
}

describe('how playback moved against the wall clock', () => {
  it('reads ordinary playback as one media second per wall second', () => {
    const advances = playbackAdvances(playing(4, 1));

    assert.equal(advances.length, 3);
    advances.forEach((advance) => assert.equal(advance.ratio, 1));
  });

  it('reads the catch-up rate the client configures', () => {
    assert.equal(playbackAdvances(playing(2, 1.1))[0].ratio, 1.1);
  });

  /**
   * The measurement that cannot be wrong about whether a viewer saw anything. A stalled player still
   * reports a latency and still renders an overlay, and `currentTime` against the clock is what says
   * the picture was not moving.
   */
  it('reads a stalled player as gaining no media time', () => {
    assert.equal(playbackAdvances(playing(2, 0))[0].ratio, 0);
  });

  it('has nothing to say about a single sample', () => {
    assert.deepEqual(playbackAdvances(playing(1, 1)), []);
  });
});

describe('judging the latency against the buffer the client is configured with', () => {
  it('accepts a player sitting at its configured target', () => {
    const verdict = judgeLatency(playing(3, 1));

    assert.equal(verdict.reachedTargetAtJoin, true);
    assert.equal(verdict.heldTarget, true);
    assert.equal(verdict.ranLong, false);
    assert.equal(verdict.medianLatencyS, LIVE_SYNC_DURATION_S);
    assert.equal(verdict.joinLatencyS, LIVE_SYNC_DURATION_S);
  });

  /**
   * The failure the byte-budgeted window was built to remove. hls.js pins its sync position to the
   * start of the playlist, so a ten-segment window at a 0.25s segment held 2.5s and a viewer asking
   * for six got two and a half, with no error anywhere and nothing in the bench able to see it.
   */
  it('calls a player held near the edge by a short manifest clamped, not merely fast', () => {
    const verdict = judgeLatency(playing(3, 1, { liveLatencyS: 2.5 }));

    assert.equal(verdict.reachedTargetAtJoin, false);
    assert.equal(verdict.ranLong, false);
  });

  /**
   * The mistake this module made on its own first real run, kept as a test because the two failures
   * have different owners and the same shape in a summary. The 2026-08-05 session joined at 5.96s
   * against a 6s target, which is the uploader's window working exactly as the byte budget intended,
   * and then drained to a 2.28s median. Judged on the median it printed as a short manifest, which
   * would have sent the next day's work to the wrong side of the system.
   */
  it('separates a window that was too short from a session that drained away from a good one', () => {
    const drained = [
      { ...BASE, atMs: 0, liveLatencyS: 5.96 },
      { ...BASE, atMs: 1000, currentTime: 1, liveLatencyS: 3.11 },
      { ...BASE, atMs: 2000, currentTime: 2, liveLatencyS: 2.28 },
      { ...BASE, atMs: 3000, currentTime: 3, liveLatencyS: 0.84 },
    ];
    const verdict = judgeLatency(drained);

    assert.equal(verdict.reachedTargetAtJoin, true, 'the manifest named the runway the target asks for');
    assert.equal(verdict.heldTarget, false, 'and the session did not keep it');
  });

  it('leaves a player inside the tolerance of its target alone', () => {
    const verdict = judgeLatency(playing(3, 1, { liveLatencyS: LIVE_SYNC_DURATION_S - 0.9 }));

    assert.equal(verdict.reachedTargetAtJoin, true);
    assert.equal(verdict.heldTarget, true);
  });

  it('calls a player past the seek threshold as having run long', () => {
    const verdict = judgeLatency(playing(3, 1, { liveLatencyS: 2 * LIVE_SYNC_DURATION_S + 1 }));

    assert.equal(verdict.ranLong, true);
  });

  /** One sample past the threshold is the whole point, so this reads the maximum rather than a median. */
  it('notices a single excursion past the seek threshold inside an otherwise good run', () => {
    const samples = playing(5, 1);
    const withSpike = samples.map((sample, i) => (i === 2 ? { ...sample, liveLatencyS: 40 } : sample));

    assert.equal(judgeLatency(withSpike).ranLong, true);
    assert.equal(judgeLatency(withSpike).medianLatencyS, LIVE_SYNC_DURATION_S);
  });

  /**
   * The join is where a latency past the threshold is designed to happen, not where it is a defect.
   * hls.js pins its sync position to the start of the playlist, so a viewer joins as far back as the
   * first manifest reaches, and the window is budgeted in bytes: 36s of media at a 1.0s segment. The
   * threshold is what makes hls.js seek, and the seek is what fixes it.
   *
   * Measured 2026-08-05: a run joined 35.98s behind and was at 6.25s on the very next sample, and
   * this module reported it as "it did not recover on its own" against its own next row.
   */
  it('does not call a run long for the join it seeked away from', () => {
    const samples = playing(5, 1);
    const joinedFarBack = samples.map((sample, i) => (i === 0 ? { ...sample, liveLatencyS: 36 } : sample));

    const verdict = judgeLatency(joinedFarBack);

    assert.equal(verdict.ranLong, false, 'the seek recovered on the next sample and this called it a failure');
    assert.equal(verdict.joinedPastSeekThreshold, true, 'the jump a viewer saw at the join went unreported');
  });

  // The other half. A join inside the threshold needs no seek and must not be reported as one.
  it('says nothing about a join that needed no seek', () => {
    assert.equal(judgeLatency(playing(3, 1)).joinedPastSeekThreshold, false);
  });

  it('reports no latency rather than zero when the overlay never had one', () => {
    const verdict = judgeLatency(playing(3, 1, { liveLatencyS: null }));

    assert.equal(verdict.medianLatencyS, null);
    assert.equal(verdict.reachedTargetAtJoin, false, 'nothing was measured, so nothing is confirmed');
    assert.equal(verdict.heldTarget, false);
  });
});

describe('summarizing a session', () => {
  it('counts the samples where playback did not advance', () => {
    const samples = [
      ...playing(3, 1),
      { ...BASE, atMs: 3000, currentTime: 2 },
      { ...BASE, atMs: 4000, currentTime: 2 },
    ];

    assert.equal(summarize(samples).stalledSamples, 2);
  });

  it('takes the running totals off the last sample rather than adding them up', () => {
    const samples = [
      { ...BASE, atMs: 0, rebufferCount: 1, rebufferMs: 200, droppedFrames: 3 },
      { ...BASE, atMs: 1000, currentTime: 1, rebufferCount: 2, rebufferMs: 500, droppedFrames: 9 },
    ];
    const summary = summarize(samples);

    assert.equal(summary.rebufferCount, 2);
    assert.equal(summary.rebufferMs, 500);
    assert.equal(summary.droppedFrames, 9);
  });

  it('reports the span the samples cover, so a median is read against its own duration', () => {
    assert.equal(summarize(playing(11, 1)).spanMs, 10_000);
  });

  it('reports the resolution the player decoded rather than the one requested', () => {
    assert.equal(summarize(playing(2, 1, { resolution: '640×360' })).resolution, '640×360');
  });

  /**
   * The measured session: 84.0 media seconds over 99.4 wall seconds, with every sample that played
   * at all playing at exactly 1x. Quoting the typical sample would have called that healthy.
   */
  it('separates the rate playback ran at from the rate a viewer actually received', () => {
    const stalling = [
      { ...BASE, atMs: 0, currentTime: 0 },
      { ...BASE, atMs: 1000, currentTime: 1 },
      { ...BASE, atMs: 2000, currentTime: 1 },
      { ...BASE, atMs: 3000, currentTime: 2 },
      { ...BASE, atMs: 4000, currentTime: 3 },
    ];
    const summary = summarize(stalling);

    assert.equal(summary.medianAdvanceRatio, 1, 'a sample that played, played at its rate');
    assert.equal(summary.overallAdvanceRatio, 0.75, 'and the viewer got three seconds out of four');
  });
});
