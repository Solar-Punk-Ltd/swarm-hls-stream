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
  liveTargetLatencyS: LIVE_SYNC_DURATION_S,
  bufferStalls: 0,
  rebufferCount: 0,
  rebufferMs: 0,
  fatalErrors: 0,
  decodedFrames: 0,
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

/**
 * Task #102. A forward jump is the player abandoning media, and it used to be counted as media the
 * viewer watched.
 *
 * hls.js writes `media.currentTime = liveSyncPosition` whenever latency passes
 * `LIVE_MAX_LATENCY_DURATION_S`, which is its designed response to falling behind and is the normal
 * end of every freeze the gateway causes. The playhead then covers the whole freeze in one sample.
 * Reading `currentTime` at the ends of a session cannot tell that apart from playing throughout, so
 * a ten second freeze and the seek that ended it netted to exactly 1.000 and the run read as
 * flawless. Two crash reports were published against that reading.
 *
 * The cure is a ceiling rather than a judgement: no viewer can watch more media seconds than the
 * clock allows at the fastest rate the player is configured to use, so anything above that was
 * jumped past. The excess is reported rather than quietly dropped, because a session with one seek
 * in it is a different thing from a session with none and the ratio alone no longer says which.
 */
describe('media a viewer watched, against media the player skipped', () => {
  /** Plays for `playedS`, freezes for `frozenS`, then seeks to the live edge and plays on. */
  function frozenThenSeeking(playedS: number, frozenS: number, afterS: number): ViewerSample[] {
    const before = Array.from({ length: playedS }, (_, i) => ({ ...BASE, atMs: i * 1000, currentTime: i }));
    const frozen = Array.from({ length: frozenS }, (_, i) => ({
      ...BASE,
      atMs: (playedS + i) * 1000,
      currentTime: playedS - 1,
    }));
    // The seek: one sample later, the playhead is at the live edge, which is where the clock is.
    const after = Array.from({ length: afterS }, (_, i) => ({
      ...BASE,
      atMs: (playedS + frozenS + i) * 1000,
      currentTime: playedS + frozenS + i,
    }));
    return [...before, ...frozen, ...after];
  }

  it('does not credit a freeze and its recovery seek as a session that played throughout', () => {
    const summary = summarize(frozenThenSeeking(6, 10, 5));

    assert.ok(
      summary.overallAdvanceRatio < 0.75,
      `read ${summary.overallAdvanceRatio.toFixed(3)}, and ten of twenty seconds were a frozen frame`,
    );
  });

  it('says how much media the seek skipped, rather than dropping it silently', () => {
    const summary = summarize(frozenThenSeeking(6, 10, 5));

    assert.equal(summary.forwardSeeks, 1);
    assert.ok(
      summary.seekedPastS > 8 && summary.seekedPastS < 11,
      `read ${summary.seekedPastS}s skipped, against the ten seconds the freeze cost`,
    );
  });

  /**
   * The join seek, which every session has. A viewer starts as far back as the first manifest
   * reaches, about 36 seconds of media against a 6s target, and hls.js jumps them forward at once.
   * {@link LatencyVerdict.joinedPastSeekThreshold} already reports the event, so counting those
   * seconds as watched was the same defect happening to every run rather than only to a faulted one.
   */
  it('excludes the jump a viewer is given when they join behind the edge', () => {
    const joined = [
      { ...BASE, atMs: 0, currentTime: 0 },
      { ...BASE, atMs: 1000, currentTime: 30 },
      ...Array.from({ length: 9 }, (_, i) => ({ ...BASE, atMs: (2 + i) * 1000, currentTime: 31 + i })),
    ];
    const summary = summarize(joined);

    assert.equal(summary.forwardSeeks, 1);
    assert.ok(
      summary.overallAdvanceRatio <= 1.1,
      `read ${summary.overallAdvanceRatio.toFixed(3)}, which is more media than the clock allows`,
    );
  });

  it('leaves the catch-up rate alone, which is playing fast and not jumping', () => {
    const summary = summarize(playing(10, 1.1, { playbackRate: 1.1 }));

    assert.equal(summary.forwardSeeks, 0);
    assert.equal(summary.seekedPastS, 0);
    assert.ok(Math.abs(summary.overallAdvanceRatio - 1.1) < 0.001);
  });

  /**
   * `currentTime` and the clock are not read in the same instant, so a sample pair can show slightly
   * more media than the rate strictly allows without anything having jumped. The tolerance absorbing
   * that has a wide gap to sit in: an honest second gains at most 1.1s, and the smallest seek hls.js
   * can make is 6s, because it fires past a 12s latency and lands on a 6s one.
   */
  it('reads a sampling wobble as playback rather than as a seek', () => {
    const wobbling = [
      { ...BASE, atMs: 0, currentTime: 0 },
      { ...BASE, atMs: 1000, currentTime: 1.4 },
      { ...BASE, atMs: 2000, currentTime: 2.4 },
    ];

    assert.equal(summarize(wobbling).forwardSeeks, 0);
  });
});

/**
 * The silent quality failure, and why the rate is per media second rather than per wall second.
 *
 * A consumer slower than the stream's bitrate does not error or drop frames, it stretches media
 * time, so the encoder reports its keyframe interval hit exactly while the frame rate underneath
 * collapsed. Task #76 reproduced 12.2fps against a requested 30 that way.
 */
describe('the frame rate that actually arrived', () => {
  /**
   * A sample at a stated wall second, holding a stated media position.
   *
   * Both clocks are named because they have to agree: media that outruns the wall clock by more
   * than the catch-up rate is a seek, and the denominator excludes it. These fixtures used to
   * advance three media seconds per wall second, which no player does and which reads as a seek on
   * every step.
   */
  const at = (atS: number, currentTime: number, decodedFrames: number): ViewerSample => ({
    ...BASE,
    atMs: atS * 1000,
    currentTime,
    decodedFrames,
  });

  it('reads a healthy stream at the rate it was encoded', () => {
    const samples = [at(0, 0, 0), at(3, 3, 90), at(6, 6, 180), at(9, 9, 270)];

    assert.equal(summarize(samples).deliveredFps, 30);
  });

  it('sees a collapsed frame rate that nothing else reports', () => {
    // Same wall clock, same media, a third of the frames. Nothing here is frozen and nothing errored.
    const samples = [at(0, 0, 0), at(3, 3, 36), at(6, 6, 72), at(9, 9, 108)];
    const summary = summarize(samples);

    assert.equal(summary.deliveredFps, 12);
    assert.equal(summary.stalledSamples, 0, 'a collapsed frame rate was reported as a stall');
  });

  /**
   * The reason for the denominator. A picture that has stopped decodes nothing, so a wall-time rate
   * would call a freeze and a collapse the same number, and the two need opposite fixes.
   */
  it('is not fooled by a freeze, which decodes nothing and plays nothing', () => {
    const samples = [at(0, 0, 0), at(3, 3, 90), at(6, 3, 90), at(9, 3, 90), at(12, 6, 180), at(15, 9, 270)];

    assert.equal(summarize(samples).deliveredFps, 30, 'a frozen stretch was charged to the frame rate');
  });

  it('says nothing rather than guessing from too little media', () => {
    const samples = [at(0, 0, 0), at(2, 2, 60)];

    assert.equal(summarize(samples).deliveredFps, null);
  });
});
