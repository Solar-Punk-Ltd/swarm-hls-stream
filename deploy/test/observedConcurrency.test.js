import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summariseObserved } from '../scripts/concurrency-analysis.mjs';

/**
 * Every concurrency figure this project holds came from a harness that CHOSE the concurrency. The
 * player's own was read out of weeb-3's source and then inferred from a synthetic arm agreeing with a
 * playback result to within 3%. Agreement is not observation, so this summarises the fetches a real
 * player actually issued, in the same shape the sweep arms are summarised in, so the two are directly
 * comparable rather than merely consistent.
 */

const KB = 1024;
const SEGMENT_SECONDS = 0.266;

/** One fetch, in the row shape `parseSweepRows` produces. */
const at = (startMs, ms, bytes = 90 * KB) => ({
  arm: 'player',
  round: 0,
  ref: 'aa',
  startMs,
  endMs: startMs + ms,
  ms,
  bytes,
  status: 200,
  overBudget: false,
});

describe('what the player itself did, measured rather than assumed', () => {
  it('reports how many were really in flight, not how many the source says', () => {
    // Four overlapping the whole way, which is what reading weeb-3's constants predicts.
    const rows = [at(0, 4000), at(0, 4000), at(0, 4000), at(0, 4000)];

    const observed = summariseObserved(rows, { segmentSeconds: SEGMENT_SECONDS });

    assert.equal(observed.achievedPeak, 4);
    assert.equal(observed.achievedMean, 4);
  });

  it('separates a player that reaches sixteen from one that reaches four', () => {
    const four = summariseObserved(
      Array.from({ length: 4 }, () => at(0, 1000)),
      { segmentSeconds: SEGMENT_SECONDS },
    );
    const sixteen = summariseObserved(
      Array.from({ length: 16 }, () => at(0, 1000)),
      { segmentSeconds: SEGMENT_SECONDS },
    );

    assert.equal(four.achievedPeak, 4);
    assert.equal(sixteen.achievedPeak, 16);
  });

  /**
   * The verdict, and it is a fetch RATE rather than a byte rate. A 0.266s segment has to be replaced
   * 3.76 times a second however small it is, so a player that cannot issue and complete that many
   * cannot hold realtime no matter how fast each one is.
   */
  it('reports whether the fetch rate can replace segments as fast as they are played', () => {
    // Four in flight, one second each: four fetches per second against the 3.76 needed.
    const rows = [0, 0, 0, 0, 1000, 1000, 1000, 1000].map((start) => at(start, 1000));

    const observed = summariseObserved(rows, { segmentSeconds: SEGMENT_SECONDS });

    assert.equal(observed.fetchPerS, 4);
    assert.equal(observed.requiredFetchPerS, 3.76);
    assert.ok(observed.realtimeHeadroom > 1, 'four a second outruns 3.76 a second');
  });

  it('calls it short when the fetch rate cannot keep up', () => {
    // Four in flight, two seconds each: two a second against 3.76 needed.
    const rows = [0, 0, 0, 0, 2000, 2000, 2000, 2000].map((start) => at(start, 2000));

    const observed = summariseObserved(rows, { segmentSeconds: SEGMENT_SECONDS });

    assert.equal(observed.fetchPerS, 2);
    assert.ok(observed.realtimeHeadroom < 1);
    assert.equal(observed.verdict, 'short');
  });

  it('counts only what actually arrived towards throughput', () => {
    const rows = [at(0, 1000), { ...at(0, 1000), status: 504, bytes: 28 }];

    const observed = summariseObserved(rows, { segmentSeconds: SEGMENT_SECONDS });

    assert.equal(observed.fetches, 2);
    assert.equal(observed.delivered, 1);
    assert.equal(observed.kbPerS, 90, 'the failed one contributed no bytes but did occupy a slot');
  });

  // A run with nothing in it must not divide by zero and claim a verdict.
  it('says nothing rather than something wrong when there are no fetches', () => {
    const observed = summariseObserved([], { segmentSeconds: SEGMENT_SECONDS });

    assert.equal(observed.fetches, 0);
    assert.equal(observed.verdict, 'no fetches');
  });
});
