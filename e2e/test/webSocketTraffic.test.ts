import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  amplification,
  bytesBetween,
  frameBytes,
  framesBetween,
  openConnectionsAt,
  perSecondSeries,
  type WebSocketConnection,
  type WebSocketFrame,
} from '../src/browser/webSocketTraffic.js';

/**
 * The arithmetic the in-tab throttle probe reads its answer out of, on hand-built frames.
 *
 * ⭐ Separate from the recorder on purpose. Every in-browser throughput figure this project
 * retracted before 2026-08-11 was retracted for the arithmetic applied after collection rather than
 * for a mistimed fetch, so the collection is a listener with no sums in it and the sums are these,
 * where `node --test` can reach them.
 */

const START_MS = 1_756_800_000_000;

function inbound(atMs: number, bytes: number): WebSocketFrame {
  return { atMs, direction: 'in', bytes };
}

function outbound(atMs: number, bytes: number): WebSocketFrame {
  return { atMs, direction: 'out', bytes };
}

describe('how many bytes a frame carried', () => {
  it('reads a binary payload by its byte length', () => {
    assert.equal(frameBytes(Buffer.alloc(4_096)), 4_096);
  });

  /**
   * ⛔ `length` on a string is characters, not bytes. A node's yamux frames arrive as Buffers, so
   * the difference would show up only on whatever text frames the transport carries, which is the
   * hardest kind of undercount to notice: the total stays plausible.
   */
  it('reads a text payload by its utf-8 byte length rather than its character count', () => {
    assert.equal('é'.length, 1);
    assert.equal(frameBytes('é'), 2);
  });

  it('reads an empty payload as no bytes at all', () => {
    assert.equal(frameBytes(''), 0);
  });
});

describe('the bytes and frames inside a window', () => {
  const frames: WebSocketFrame[] = [
    inbound(START_MS - 1, 1_000),
    inbound(START_MS, 10),
    outbound(START_MS + 100, 20),
    inbound(START_MS + 900, 30),
    outbound(START_MS + 1_500, 40),
    inbound(START_MS + 2_000, 1_000),
  ];

  /**
   * Half open, so two windows laid end to end count every frame exactly once. Part A runs three
   * idle windows back to back and Part B measures a retrieval and then its tail, and a frame landing
   * on a boundary counted twice would inflate whichever amplification ratio it fell into.
   */
  it('takes a frame on the opening instant and leaves the closing one to the next window', () => {
    assert.equal(bytesBetween(frames, START_MS, START_MS + 2_000, 'in'), 40);
    assert.equal(bytesBetween(frames, START_MS + 2_000, START_MS + 3_000, 'in'), 1_000);
  });

  it('counts each direction on its own', () => {
    assert.equal(bytesBetween(frames, START_MS, START_MS + 2_000, 'out'), 60);
    assert.equal(framesBetween(frames, START_MS, START_MS + 2_000, 'in'), 2);
    assert.equal(framesBetween(frames, START_MS, START_MS + 2_000, 'out'), 2);
  });

  it('reads an empty window as zero rather than as nothing', () => {
    assert.equal(bytesBetween(frames, START_MS + 5_000, START_MS + 6_000, 'in'), 0);
    assert.equal(framesBetween(frames, START_MS + 5_000, START_MS + 6_000, 'in'), 0);
  });
});

describe('the per-second series a window is read from', () => {
  const frames: WebSocketFrame[] = [
    inbound(START_MS + 10, 100),
    inbound(START_MS + 999, 200),
    outbound(START_MS + 500, 5),
    inbound(START_MS + 1_000, 300),
    inbound(START_MS + 2_500, 400),
  ];

  it('buckets by whole seconds from the start of the window', () => {
    const series = perSecondSeries(frames, START_MS, START_MS + 3_000);

    assert.deepEqual(series, [
      { secondIndex: 0, inBytes: 300, outBytes: 5, inFrames: 2, outFrames: 1 },
      { secondIndex: 1, inBytes: 300, outBytes: 0, inFrames: 1, outFrames: 0 },
      { secondIndex: 2, inBytes: 400, outBytes: 0, inFrames: 1, outFrames: 0 },
    ]);
  });

  /**
   * ⛔ A second nothing arrived in is a reading of zero, never a gap. H2 asks what share of a capped
   * link the node's idle chatter takes, and a series that only carried the busy seconds would divide
   * by a smaller denominator and answer a different question.
   */
  it('emits a zero second rather than skipping it', () => {
    const series = perSecondSeries([inbound(START_MS + 2_100, 50)], START_MS, START_MS + 3_000);

    assert.equal(series.length, 3);
    assert.deepEqual(series[0], { secondIndex: 0, inBytes: 0, outBytes: 0, inFrames: 0, outFrames: 0 });
  });

  it('rounds a part second up so the tail of a window is not dropped', () => {
    assert.equal(perSecondSeries([], START_MS, START_MS + 2_500).length, 3);
  });

  it('has no seconds at all when the window has no length', () => {
    assert.deepEqual(perSecondSeries(frames, START_MS, START_MS), []);
  });

  it('ignores frames outside the window', () => {
    const series = perSecondSeries(frames, START_MS + 1_000, START_MS + 2_000);

    assert.deepEqual(series, [{ secondIndex: 0, inBytes: 300, outBytes: 0, inFrames: 1, outFrames: 0 }]);
  });
});

describe('how many connections were open at an instant', () => {
  const connections: WebSocketConnection[] = [
    { url: 'wss://peer-one.invalid', openedAtMs: START_MS, closedAtMs: START_MS + 5_000 },
    { url: 'wss://peer-two.invalid', openedAtMs: START_MS + 1_000, closedAtMs: null },
    { url: 'wss://peer-three.invalid', openedAtMs: START_MS + 9_000, closedAtMs: null },
  ];

  it('counts the ones already open and not yet closed', () => {
    assert.equal(openConnectionsAt(connections, START_MS + 2_000), 2);
  });

  /** A connection that never closed stays open for every later instant, which is what null means. */
  it('keeps an unclosed connection open past the one that closed', () => {
    assert.equal(openConnectionsAt(connections, START_MS + 6_000), 1);
  });

  it('counts a connection from the instant it opened and not before', () => {
    assert.equal(openConnectionsAt(connections, START_MS - 1), 0);
    assert.equal(openConnectionsAt(connections, START_MS), 1);
  });

  /** Closing is the end of the interval, so the closing instant is already outside it. */
  it('drops a connection on the instant it closed', () => {
    assert.equal(openConnectionsAt(connections, START_MS + 5_000), 1);
  });
});

describe('inbound bytes against the payload they delivered', () => {
  /** H1 predicts near 1.0 to 1.3 unthrottled, so the ratio has to be the plain division. */
  it('is the ratio of what crossed the link to what came back', () => {
    assert.equal(amplification(224_848, 224_848), 1);
    assert.equal(amplification(700_000, 200_000), 3.5);
  });

  /**
   * ⛔⛔ Null rather than Infinity or zero. A retrieval that returned no payload divided into any
   * inbound total is not an infinite amplification, it is a row that cannot answer the question, and
   * the two read completely differently in a table of ratios that H1 is judged on.
   */
  it('cannot be taken at all when nothing came back', () => {
    assert.equal(amplification(700_000, 0), null);
  });
});
