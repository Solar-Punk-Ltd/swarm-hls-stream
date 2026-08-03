import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bufferDemandTrend, feedProgress, latencyByMinute, latencyDrift, mediaPacing } from '../src/bench/longRun.js';

/**
 * A publisher paced by a filter graph anchors wall clock at its first frame and emits at the nominal
 * frame rate afterwards, so a long run accumulates whatever gap opens between the two. A publisher
 * that is not real-time produces a latency that climbs on its own, which is indistinguishable from a
 * pipeline that is falling behind unless the pace is measured. Nothing a long run reports means
 * anything until it is.
 */
describe('how fast media time advanced against wall clock', () => {
  /**
   * The healthy case. Ten one-second segments arriving one second apart at a constant delay: media
   * and wall clock keep pace, nothing is missing, and a drift measured here would be the pipeline's.
   */
  it('reads 1 with no holes when media and wall clock keep pace', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      index: i,
      capturedAtMs: 100_000 + i * 1_000,
      fetchedAtMs: 103_000 + i * 1_000,
      segmentMs: 1_000,
    }));

    const pacing = mediaPacing(samples);

    assert.equal(pacing.deliveredPerWallSecond, 1);
    assert.equal(pacing.timelinePerWallSecond, 1);
    assert.equal(pacing.holeMs, 0);
  });

  /**
   * The confound this exists to expose. The publisher is pacing 2% slow, so a thousand milliseconds
   * of media takes 1020 of wall clock. Nothing is lost and nothing is late in media terms, but the
   * measured latency climbs 20ms per segment forever, which over half an hour is 36 seconds of drift
   * that no viewer of a real camera would ever see.
   *
   * Both readings drop together, because the timeline and the segments are the same clock running
   * slow. A run that reports drift while this is below 1 is reporting its own publisher.
   */
  it('reads below 1 on both counts when the publisher is not real-time', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      index: i,
      capturedAtMs: 100_000 + i * 1_000,
      fetchedAtMs: 104_020 + i * 1_020,
      segmentMs: 1_000,
    }));

    const pacing = mediaPacing(samples);

    assert.equal(Number(pacing.deliveredPerWallSecond.toFixed(4)), 0.9804);
    assert.equal(Number(pacing.timelinePerWallSecond.toFixed(4)), 0.9804);
    assert.equal(pacing.holeMs, 0);
  });

  /**
   * The other fault, which the pace alone cannot see. The timeline advances with wall clock, so the
   * publisher is honest, but each segment carries only 1000ms of the 1250ms the timeline crossed. A
   * viewer gets a jump every segment. The two readings are what separate this from the case above.
   */
  it('finds the media a viewer never receives, where the timeline keeps pace but the segments do not', () => {
    const samples = Array.from({ length: 5 }, (_, i) => ({
      index: i,
      capturedAtMs: 100_000 + i * 1_250,
      fetchedAtMs: 103_000 + i * 1_250,
      segmentMs: 1_000,
    }));

    const pacing = mediaPacing(samples);

    assert.equal(pacing.deliveredPerWallSecond, 0.8);
    assert.equal(pacing.timelinePerWallSecond, 1);
    assert.equal(pacing.holeMs, 1_000);
  });

  /**
   * The segment index is the uploader's own count and skips nothing, so a run that sampled one
   * segment in four still measures production across all of them. Sampling every fourth of nine
   * one-second segments spans an index gap of 8 over 8 seconds of wall clock.
   */
  it('counts segments the run never sampled, because the index is the uploader’s', () => {
    const samples = [0, 4, 8].map((index) => ({
      index,
      capturedAtMs: 100_000 + index * 1_000,
      fetchedAtMs: 103_000 + index * 1_000,
      segmentMs: 1_000,
    }));

    assert.equal(mediaPacing(samples).deliveredPerWallSecond, 1);
  });

  it('refuses to report a pace across samples that span no time', () => {
    const sample = { index: 0, capturedAtMs: 100_000, fetchedAtMs: 103_000, segmentMs: 1_000 };

    assert.throws(() => mediaPacing([sample]), /spans no wall time/);
  });
});

/**
 * With five samples over ten seconds a fitted slope is noise, which is why the short bench takes the
 * first sample minus the last and prints the scatter beside it. Over hundreds of samples across half
 * an hour a slope is a real quantity, and the thing that decides whether to believe it is whether the
 * change it predicts across the run clears the spread of the samples around the line.
 */
describe('latency drift across a long run', () => {
  it('recovers a slope from a run whose latency really is climbing', () => {
    // 3s at the start, 6s thirty minutes later: 100ms per minute, on the line exactly.
    const samples = Array.from({ length: 31 }, (_, minute) => ({
      fetchedAtMs: minute * 60_000,
      totalMs: 3_000 + minute * 100,
    }));

    const drift = latencyDrift(samples);

    assert.equal(Math.round(drift.msPerMinute), 100);
    assert.equal(Math.round(drift.fittedChangeMs), 3_000);
    assert.equal(Math.round(drift.residualMs), 0);
  });

  /**
   * The case the short bench cannot handle and the reason `trend.msPerMinute` is unreadable at five
   * samples: a flat run whose samples scatter produces a slope near zero and a residual that dwarfs
   * whatever the slope predicts. Reporting the slope alone would invent a trend out of scatter.
   */
  it('reports a residual that dwarfs the fitted change on a flat but scattered run', () => {
    const scatter = [0, 800, -600, 400, -400, 700, -700, 500, -500, 100];
    const samples = scatter.map((offset, i) => ({
      fetchedAtMs: i * 60_000,
      totalMs: 5_000 + offset,
    }));

    const drift = latencyDrift(samples);

    assert.ok(
      Math.abs(drift.fittedChangeMs) < drift.residualMs,
      `a flat run should not out-predict its own scatter, got ${drift.fittedChangeMs}ms against ${drift.residualMs}ms`,
    );
  });

  it('refuses to fit a line through fewer than two samples', () => {
    assert.throws(() => latencyDrift([{ fetchedAtMs: 0, totalMs: 1_000 }]), /at least two samples/);
  });
});

/**
 * The buffer question asked twice, at the two ends of a run. A setting whose demand is flat holds a
 * constant stream; one whose demand climbs will eventually stall a player configured from its opening
 * minute, which is exactly what every figure this project has published was derived from.
 */
describe('whether the buffer a player needs grows while it watches', () => {
  it('reports no growth for a run whose arrivals stay put', () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({
      fetchedAtMs: i * 1_000,
      totalMs: 4_000,
      segmentMs: 1_000,
    }));

    const trend = bufferDemandTrend(samples);

    assert.equal(trend.firstThirdMs, 3_000);
    assert.equal(trend.lastThirdMs, 3_000);
    assert.equal(trend.growthMs, 0);
  });

  it('reports the growth for a run whose arrivals slip', () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({
      fetchedAtMs: i * 1_000,
      totalMs: 4_000 + i * 100,
      segmentMs: 1_000,
    }));

    const trend = bufferDemandTrend(samples);

    assert.equal(trend.firstThirdMs, 3_900);
    assert.equal(trend.lastThirdMs, 5_900);
    assert.equal(trend.growthMs, 2_000);
  });

  it('refuses to compare thirds of a run with fewer than three samples', () => {
    assert.throws(() => bufferDemandTrend([{ fetchedAtMs: 0, totalMs: 4_000, segmentMs: 1_000 }]), /three samples/);
  });
});

/**
 * Drift stated as one slope hides the shape of it. A run that was steady for twenty minutes and then
 * fell apart has the same fitted slope as one that degraded evenly, and only the second is a setting
 * you could compensate for.
 */
describe('latency bucketed by minute of run', () => {
  it('buckets by elapsed minute from the first sample, not by wall clock', () => {
    const samples = [
      { fetchedAtMs: 1_000_000, totalMs: 3_000 },
      { fetchedAtMs: 1_030_000, totalMs: 3_400 },
      { fetchedAtMs: 1_090_000, totalMs: 9_000 },
    ];

    const buckets = latencyByMinute(samples);

    assert.deepEqual(
      buckets.map((bucket) => bucket.fromMinute),
      [0, 1],
    );
    assert.equal(buckets[0].samples, 2);
    assert.equal(buckets[0].medianMs, 3_000);
    assert.equal(buckets[0].maxMs, 3_400);
    assert.equal(buckets[1].samples, 1);
    assert.equal(buckets[1].maxMs, 9_000);
  });

  /**
   * A minute nothing arrived in is the most interesting minute in the run, and a bucket list built by
   * grouping what did arrive omits it entirely. The gap has to appear as an empty row rather than as
   * two adjacent rows a reader has to notice are not consecutive.
   */
  it('keeps a minute that carried no samples, since that is the stall', () => {
    const samples = [
      { fetchedAtMs: 0, totalMs: 3_000 },
      { fetchedAtMs: 130_000, totalMs: 3_000 },
    ];

    const buckets = latencyByMinute(samples);

    assert.deepEqual(
      buckets.map((bucket) => bucket.fromMinute),
      [0, 1, 2],
    );
    assert.equal(buckets[1].samples, 0);
    assert.equal(buckets[1].medianMs, null);
  });

  it('refuses to bucket an empty run', () => {
    assert.throws(() => latencyByMinute([]), /no samples/);
  });
});

/**
 * The 2026-08-03 smoke run went 48 seconds without a new segment, and nothing in the artifact could
 * say whose 48 seconds they were. The uploader's log settled it afterwards, with 154 manifest writes
 * inside that window, but only because the log happened to still be there. An instrument that cannot
 * attribute its own gap reports every one of them as the product.
 *
 * Two quantities separate the two. A feed that stopped advancing while the bench kept asking shows
 * many polls naming the same segment. A bench that stopped asking shows one.
 */
describe('whether a gap belongs to the feed or to the bench watching it', () => {
  it('reports a one-poll stall for a feed that advances every time it is asked', () => {
    const polls = ['a', 'b', 'c', 'd'].map((newestRef, i) => ({ atMs: i * 2_000, newestRef }));

    const progress = feedProgress(polls);

    assert.equal(progress.stallMs, 2_000);
    assert.equal(progress.stallPolls, 1);
    assert.equal(progress.longestPollGapMs, 2_000);
  });

  /**
   * The feed's fault. The bench asked every two seconds throughout and got the same answer five times
   * running, so a viewer polling at that cadence saw the stream stop for ten seconds.
   */
  it('blames the feed when many polls in a row name the same segment', () => {
    const polls = ['a', 'b', 'b', 'b', 'b', 'b', 'c'].map((newestRef, i) => ({ atMs: i * 2_000, newestRef }));

    const progress = feedProgress(polls);

    assert.equal(progress.stallMs, 10_000);
    assert.equal(progress.stallPolls, 5);
    assert.equal(progress.longestPollGapMs, 2_000);
  });

  /**
   * The bench's fault, and the shape the smoke run actually had. One poll, then nothing for 48
   * seconds, then a different segment. The feed may have advanced a hundred times in between and this
   * instrument would never know, which is exactly what `longestPollGapMs` exists to admit.
   */
  it('blames itself when a long gap holds only one poll', () => {
    const polls = [
      { atMs: 0, newestRef: 'a' },
      { atMs: 2_000, newestRef: 'b' },
      { atMs: 50_000, newestRef: 'c' },
    ];

    const progress = feedProgress(polls);

    assert.equal(progress.stallMs, 48_000);
    assert.equal(progress.stallPolls, 1);
    assert.equal(progress.longestPollGapMs, 48_000);
  });

  /**
   * The run ending is not a stall. The newest segment at the last poll was never superseded because
   * the publisher stopped, and counting that would report every clean run as stalling at its end.
   */
  it('does not count the run ending as the last segment stalling', () => {
    const polls = [
      { atMs: 0, newestRef: 'a' },
      { atMs: 2_000, newestRef: 'b' },
      { atMs: 4_000, newestRef: 'b' },
      { atMs: 90_000, newestRef: 'b' },
    ];

    const progress = feedProgress(polls);

    assert.equal(progress.stallMs, 2_000);
    assert.equal(progress.longestPollGapMs, 86_000);
  });

  it('refuses to judge a feed off fewer than two polls', () => {
    assert.throws(() => feedProgress([{ atMs: 0, newestRef: 'a' }]), /at least two polls/);
  });
});
