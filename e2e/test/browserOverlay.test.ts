import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type OverlayRow, parseOverlayNumber, readOverlayMetrics } from '../src/browser/overlay.js';

/** The overlay as it renders once a stream is playing, in the units its own formatters emit. */
const PLAYING: OverlayRow[] = [
  { section: 'Startup', label: 'Startup Time', value: '1843 ms' },
  { section: 'Rebuffering', label: 'Count', value: '0' },
  { section: 'Rebuffering', label: 'Duration', value: '0 ms' },
  { section: 'Quality', label: 'Delivered Resolution', value: '1280×720' },
  { section: 'Quality', label: 'Dropped Frames', value: '4' },
  { section: 'Reliability', label: 'Fatal Errors', value: '0' },
  { section: 'Live', label: 'E2E Live Latency', value: '5.87 s' },
];

describe('reading the numbers off the shipped QoE overlay', () => {
  it('reads a playing session', () => {
    assert.deepEqual(readOverlayMetrics(PLAYING), {
      startupMs: 1843,
      rebufferCount: 0,
      rebufferMs: 0,
      resolution: '1280×720',
      droppedFrames: 4,
      fatalErrors: 0,
      liveLatencyS: 5.87,
    });
  });

  /**
   * The join is a label written as prose, so the failure mode is someone rewording the overlay and
   * every reading afterwards coming back empty. An empty latency and a six-second latency are not
   * distinguishable in a summary, so this stops instead.
   */
  it('refuses to read an overlay that no longer has the label it looks under', () => {
    const reworded = PLAYING.map((row) =>
      row.label === 'E2E Live Latency' ? { ...row, label: 'Live Latency' } : row,
    );

    assert.throws(() => readOverlayMetrics(reworded), /no 'E2E Live Latency' under 'Live'/);
  });

  it('refuses when a label moved to another section', () => {
    const moved = PLAYING.map((row) => (row.section === 'Live' ? { ...row, section: 'Latency' } : row));

    assert.throws(() => readOverlayMetrics(moved), /Update OVERLAY_FIELDS/);
  });

  /** Before hls.js has a latency the overlay shows its placeholder, which is not the same as zero. */
  it('reads a metric with no value yet as absent rather than as zero', () => {
    const early = PLAYING.map((row) => (row.label === 'E2E Live Latency' ? { ...row, value: '—' } : row));

    assert.equal(readOverlayMetrics(early).liveLatencyS, null);
  });

  it('reads a counter with no value yet as none, because a counter has one', () => {
    const early = PLAYING.map((row) => (row.label === 'Dropped Frames' ? { ...row, value: '—' } : row));

    assert.equal(readOverlayMetrics(early).droppedFrames, 0);
  });

  it('reads an unknown resolution as absent rather than as the placeholder text', () => {
    const early = PLAYING.map((row) => (row.label === 'Delivered Resolution' ? { ...row, value: '—' } : row));

    assert.equal(readOverlayMetrics(early).resolution, null);
  });
});

describe('parsing one overlay value', () => {
  it('takes the number and leaves the unit', () => {
    assert.equal(parseOverlayNumber('1843 ms'), 1843);
    assert.equal(parseOverlayNumber('5.87 s'), 5.87);
    assert.equal(parseOverlayNumber('12.3%'), 12.3);
  });

  it('reads the placeholder as absent', () => {
    assert.equal(parseOverlayNumber('—'), null);
  });

  it('reads a value that is not a number at all as absent', () => {
    assert.equal(parseOverlayNumber('in progress'), null);
  });
});
