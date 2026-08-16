import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appendedEdge,
  appendedEdgeLagS,
  behindProductionS,
  edgeGrowthS,
  type EdgeSample,
  isExhausted,
  playheadGrowthS,
} from '../src/browser/liveEdge.js';

const BASE: EdgeSample = {
  atMs: 0,
  currentTime: 0,
  bufferedEnd: null,
  seekableEnd: null,
  duration: null,
};

/** A viewer holding a live edge: the edge advances with the wall clock and the playhead follows it. */
function liveSeries(count: number, lagS = 2): EdgeSample[] {
  return Array.from({ length: count }, (_unused, i) => ({
    ...BASE,
    atMs: i * 1_000,
    currentTime: 100 + i,
    seekableEnd: 100 + i + lagS,
    duration: 100 + i + lagS,
  }));
}

/** A recording whose playhead reached the final frame: nothing advances, and the lag is near zero. */
function exhaustedSeries(count: number): EdgeSample[] {
  return Array.from({ length: count }, (_unused, i) => ({
    ...BASE,
    atMs: i * 1_000,
    currentTime: 1_190.08,
    seekableEnd: 1_190.3,
    duration: 1_190.3,
  }));
}

describe('appendedEdge', () => {
  it('prefers the seekable end, because that is what the player would let a viewer reach', () => {
    const edge = appendedEdge({ ...BASE, seekableEnd: 42, bufferedEnd: 30, duration: 50 });

    assert.equal(edge, 42);
  });

  it('falls back to the buffered end when nothing reported a seekable range', () => {
    const edge = appendedEdge({ ...BASE, seekableEnd: null, bufferedEnd: 30, duration: 50 });

    assert.equal(edge, 30);
  });

  it('returns null when the media element reported no edge at all', () => {
    const edge = appendedEdge({ ...BASE });

    assert.equal(edge, null);
  });
});

describe('appendedEdgeLagS', () => {
  it('measures the distance from the playhead to the newest appended media', () => {
    const lag = appendedEdgeLagS({ ...BASE, currentTime: 100, seekableEnd: 102.5 });

    assert.equal(lag, 2.5);
  });

  it('is null rather than zero when there is no edge, so a dead player is not reported as caught up', () => {
    const lag = appendedEdgeLagS({ ...BASE, currentTime: 0 });

    assert.equal(lag, null);
  });
});

describe('edgeGrowthS', () => {
  it('reports how far the edge advanced across the window', () => {
    const growth = edgeGrowthS(liveSeries(11));

    assert.equal(growth, 10);
  });

  it('reports zero for a recording whose edge is fixed', () => {
    const growth = edgeGrowthS(exhaustedSeries(11));

    assert.equal(growth, 0);
  });

  it('is null when fewer than two samples carried an edge', () => {
    const growth = edgeGrowthS([{ ...BASE, seekableEnd: 5 }]);

    assert.equal(growth, null);
  });
});

describe('playheadGrowthS', () => {
  it('reports the media the playhead consumed across the window', () => {
    assert.equal(playheadGrowthS(liveSeries(11)), 10);
  });

  it('reports zero when the playhead never moved', () => {
    assert.equal(playheadGrowthS(exhaustedSeries(11)), 0);
  });
});

describe('isExhausted', () => {
  it('refuses a window whose playhead sat on the final frame of a finished recording', () => {
    assert.equal(isExhausted(exhaustedSeries(11)), true);
  });

  it('⛔ does NOT fire on a live edge, where sitting two seconds behind is the healthy state', () => {
    assert.equal(isExhausted(liveSeries(11)), false);
  });

  it('does not fire on a live edge held as tight as half a second', () => {
    assert.equal(isExhausted(liveSeries(11, 0.5)), false);
  });

  it('does not fire mid-recording, where the playhead advances far behind a fixed end', () => {
    const midRecording = Array.from({ length: 11 }, (_unused, i) => ({
      ...BASE,
      atMs: i * 1_000,
      currentTime: 100 + i,
      seekableEnd: 1_190.3,
      duration: 1_190.3,
    }));

    assert.equal(isExhausted(midRecording), false);
  });

  it('⛔ does NOT fire on a live viewer that stalled, because that is a delivery failure to report and not a void window', () => {
    const stalledOnLive = Array.from({ length: 11 }, (_unused, i) => ({
      ...BASE,
      atMs: i * 1_000,
      currentTime: 100,
      seekableEnd: 102 + i,
      duration: 102 + i,
    }));

    assert.equal(isExhausted(stalledOnLive), false);
  });

  it('cannot judge a window with no edge readings, and says so rather than guessing', () => {
    assert.equal(isExhausted([{ ...BASE }, { ...BASE, atMs: 1_000 }]), false);
  });
});

describe('behindProductionS', () => {
  it('is the wall seconds since the broadcast started minus the media the playhead consumed', () => {
    const lag = behindProductionS({ ...BASE, atMs: 65_000, currentTime: 60 }, 0);

    assert.equal(lag, 5);
  });

  it('grows when the playhead falls behind a publisher that keeps producing', () => {
    const early = behindProductionS({ ...BASE, atMs: 10_000, currentTime: 8 }, 0);
    const late = behindProductionS({ ...BASE, atMs: 100_000, currentTime: 80 }, 0);

    assert.ok(late > early, `expected the lag to grow, got ${early} then ${late}`);
  });
});
