import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isSegmentRequest,
  refusedSegments,
  type RequestRecord,
  segmentRef,
  summarizeNetwork,
} from '../src/browser/network.js';

const GATEWAY = 'http://127.0.0.1:10077';

function segment(ref: string, startedAtMs: number, durationMs: number, status: number, bytes = 90_000): RequestRecord {
  return { url: `${GATEWAY}/bytes/${ref}`, status, startedAtMs, endedAtMs: startedAtMs + durationMs, bytes };
}

describe('telling a segment request from everything else the page does', () => {
  it('recognises the gateway bytes route', () => {
    assert.equal(isSegmentRequest(`${GATEWAY}/bytes/abc123`), true);
  });

  it('does not count a feed read as a segment', () => {
    assert.equal(isSegmentRequest(`${GATEWAY}/feeds/owner/topic`), false);
  });

  it('names the chunk, without a query string', () => {
    assert.equal(segmentRef(`${GATEWAY}/bytes/abc123?cache=0`), 'abc123');
  });
});

describe('separating a player that is waiting from a player that is downloading', () => {
  /**
   * The hypothesis this exists to test. hls.js waits `retryDelayMs: 1000` after a failed fragment, so
   * a segment refused once costs a second of airtime whatever the gateway does next. The wait is
   * measured between attempts and excludes transfer time, so it cannot be inflated by a slow gateway.
   */
  it('attributes the gap between a refusal and the next ask to waiting, not to transfer', () => {
    const records = [segment('a', 0, 40, 404), segment('a', 1040, 60, 200)];

    const [refused] = refusedSegments(records);
    assert.equal(refused.attempts, 2);
    assert.equal(refused.waitedBetweenAttemptsMs, 1000, 'the retry delay, with both transfers excluded');
    assert.equal(refused.refusedForMs, 1100, 'first refusal to bytes in hand');
    assert.equal(refused.served, true);
  });

  it('adds up every wait when a segment was refused more than once', () => {
    const records = [segment('a', 0, 40, 404), segment('a', 1040, 40, 404), segment('a', 2080, 50, 200)];

    assert.equal(refusedSegments(records)[0].waitedBetweenAttemptsMs, 2000);
  });

  it('says nothing about a segment that was served first time', () => {
    assert.deepEqual(refusedSegments([segment('a', 0, 60, 200)]), []);
  });

  it('reports a segment the gateway never served, rather than dropping it', () => {
    const [refused] = refusedSegments([segment('a', 0, 40, 404), segment('a', 1040, 40, 404)]);

    assert.equal(refused.served, false);
    assert.equal(refused.attempts, 2);
  });

  it('reads attempts in time order however the log arrived', () => {
    const [refused] = refusedSegments([segment('a', 1040, 60, 200), segment('a', 0, 40, 404)]);

    assert.equal(refused.waitedBetweenAttemptsMs, 1000);
  });
});

describe('summarizing what the network cost the viewer', () => {
  const RUN: RequestRecord[] = [
    { url: `${GATEWAY}/feeds/owner/topic`, status: 200, startedAtMs: 0, endedAtMs: 30, bytes: 400 },
    segment('a', 100, 200, 200),
    segment('b', 300, 200, 200),
    segment('c', 500, 40, 404),
    segment('c', 1540, 200, 200),
  ];

  it('counts segment requests without counting the feed reads beside them', () => {
    const summary = summarizeNetwork(RUN);

    assert.equal(summary.segmentRequests, 4);
    assert.equal(summary.distinctSegments, 3);
  });

  it('reports the refusal share over requests and the segments affected separately', () => {
    const summary = summarizeNetwork(RUN);

    assert.equal(summary.refusals, 1);
    assert.equal(summary.refusalShare, 0.25);
    assert.equal(summary.segmentsRefusedAtLeastOnce, 1, 'one segment, though it took two requests');
    assert.equal(summary.segmentsNeverServed, 0);
  });

  /** The two numbers that decide the question, side by side and computed from disjoint intervals. */
  it('splits time spent transferring from time spent waiting between attempts', () => {
    const summary = summarizeNetwork(RUN);

    assert.equal(summary.medianTransferMs, 200);
    assert.equal(summary.totalWaitedBetweenAttemptsMs, 1000);
  });

  it('measures how many segment fetches were ever in flight together', () => {
    // a runs 100-300 and b runs 300-500, which touch without overlapping.
    assert.equal(summarizeNetwork([segment('a', 100, 200, 200), segment('b', 300, 200, 200)]).maxConcurrent, 1);
    assert.equal(summarizeNetwork([segment('a', 100, 200, 200), segment('b', 200, 200, 200)]).maxConcurrent, 2);
  });

  it('counts delivered bytes rather than requested ones', () => {
    const summary = summarizeNetwork([segment('a', 0, 100, 200, 50_000), segment('b', 0, 100, 404, 0)]);

    assert.equal(summary.segmentBytesPerSecond, 500_000, '50kB delivered over a 100ms span');
  });

  /**
   * The total as well as the rate, because a cost is paid against bytes rather than against bytes
   * per second, and dividing the rate back out by the span reintroduces the run's length into a
   * figure that should not carry it.
   */
  it('reports the delivered total, not only the rate', () => {
    const summary = summarizeNetwork([segment('a', 0, 100, 200, 50_000), segment('b', 0, 100, 404, 0)]);

    assert.equal(summary.segmentBytesDelivered, 50_000);
  });

  it('leaves a refused segment out of the delivered total', () => {
    assert.equal(summarizeNetwork([segment('a', 0, 100, 404, 0)]).segmentBytesDelivered, 0);
  });

  it('has something to say about an empty log rather than dividing by zero', () => {
    const summary = summarizeNetwork([]);

    assert.equal(summary.segmentRequests, 0);
    assert.equal(summary.segmentBytesPerSecond, 0);
    assert.equal(summary.medianTransferMs, 0);
  });
});
