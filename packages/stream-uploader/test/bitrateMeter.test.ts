import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  averageBandwidth,
  emptyBitrateSample,
  PEAK_WINDOW_SEGMENTS,
  peakBandwidth,
  recordSegment,
} from '../src/libs/BitrateMeter.js';

const FALLBACK = 2_800_000;

/** Bytes for `duration` seconds at `kbps`, i.e. a segment of that sustained rate. */
function bytesFor(kbps: number, duration: number): number {
  return (kbps * 1000 * duration) / 8;
}

function meter(segments: Array<[number, number]>) {
  const sample = emptyBitrateSample();
  for (const [kbps, duration] of segments) {
    recordSegment(sample, bytesFor(kbps, duration), duration);
  }
  return sample;
}

describe('BitrateMeter', () => {
  it('reports the encoder target until the window has filled', () => {
    const sample = emptyBitrateSample();
    for (let i = 0; i < PEAK_WINDOW_SEGMENTS - 1; i++) {
      recordSegment(sample, bytesFor(1800, 1.5), 1.5);
    }

    assert.equal(peakBandwidth(sample, FALLBACK), FALLBACK, 'too few segments to call a peak');

    recordSegment(sample, bytesFor(1800, 1.5), 1.5);
    assert.equal(peakBandwidth(sample, FALLBACK), 1_800_000);
  });

  it('is not fooled by a short segment, which is the bug this exists for', () => {
    // SRS cuts only on keyframes, so it regularly emits a fragment well under the target duration.
    // Dividing a normal payload by a fraction of a second is what advertised a 1.8 Mbps rendition
    // at 9.9 Mbps, putting it out of reach of hls.js's up-switch test.
    const steady = meter([
      [1800, 1.5],
      [1800, 1.5],
      [1800, 1.5],
    ]);
    const withShortSegment = meter([
      [1800, 1.5],
      [1800, 1.5],
      [1800, 1.5],
      [1800, 0.25], // same rate, a quarter of the length — not a burst
      [1800, 1.5],
      [1800, 1.5],
    ]);

    assert.equal(peakBandwidth(steady, FALLBACK), 1_800_000);
    assert.ok(
      peakBandwidth(withShortSegment, FALLBACK) < 1_900_000,
      `a short segment must not inflate the peak, got ${peakBandwidth(withShortSegment, FALLBACK)}`,
    );
  });

  it('still reports a genuine burst as a peak, well above the mean', () => {
    const sample = meter([
      [500, 1.5],
      [500, 1.5],
      [500, 1.5],
      [4000, 1.5],
      [4000, 1.5],
      [4000, 1.5],
      [500, 1.5],
      [500, 1.5],
      [500, 1.5],
    ]);

    assert.equal(peakBandwidth(sample, FALLBACK), 4_000_000, 'a sustained burst is the peak');
    assert.equal(averageBandwidth(sample, FALLBACK), 1_666_667, 'the mean is well below it');
  });

  it('never lets the peak fall below the average', () => {
    const sample = meter([
      [900, 1.5],
      [1100, 1.5],
      [1000, 1.5],
      [1000, 1.5],
    ]);

    assert.ok(peakBandwidth(sample, FALLBACK) >= averageBandwidth(sample, FALLBACK));
  });

  it('never lets the average exceed the peak before the window has filled', () => {
    // A keyframe-heavy opening segment measures above the encoder target, but the peak is still that
    // target until PEAK_WINDOW_SEGMENTS have arrived. An unclamped average would then report
    // AVERAGE-BANDWIDTH above BANDWIDTH, which RFC 8216 forbids.
    const sample = meter([[5000, 1.5]]);

    assert.equal(peakBandwidth(sample, FALLBACK), FALLBACK, 'one segment is too few to call a peak');
    assert.ok(
      averageBandwidth(sample, FALLBACK) <= peakBandwidth(sample, FALLBACK),
      `average ${averageBandwidth(sample, FALLBACK)} exceeded peak ${peakBandwidth(sample, FALLBACK)}`,
    );
  });

  it('ignores empty and zero-length segments rather than dividing by them', () => {
    const sample = emptyBitrateSample();
    recordSegment(sample, 0, 1.5);
    recordSegment(sample, 1000, 0);
    recordSegment(sample, 1000, -1);

    assert.equal(sample.totalBytes, 0);
    assert.equal(sample.window?.length, 0);
    assert.equal(peakBandwidth(sample, FALLBACK), FALLBACK);
    assert.equal(averageBandwidth(sample, FALLBACK), FALLBACK);
  });

  it('keeps the window bounded however long the stream runs', () => {
    const sample = emptyBitrateSample();
    for (let i = 0; i < 500; i++) {
      recordSegment(sample, bytesFor(1800, 1.5), 1.5);
    }

    assert.equal(sample.window?.length, PEAK_WINDOW_SEGMENTS);
  });
});
