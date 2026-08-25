import { BitrateSample } from '../types.js';

/**
 * How many consecutive segments the peak is measured across.
 *
 * RFC 8216 defines BANDWIDTH as the peak segment bit rate — segment size over its EXTINF duration,
 * maximised over segments. Taken literally on a live encoder that is wrong, because a segment cut
 * short is not a fast segment, it is a short one: SRS can only cut on a keyframe, so it regularly
 * emits fragments well under the target duration, and one of those carrying a full keyframe divides
 * a normal payload by a fraction of a second. Measured that way a 1.8 Mbps rendition advertised
 * 9.9 Mbps, which put it out of reach of hls.js's up-switch test and pinned every viewer to the
 * bottom rung.
 *
 * A window of three covers roughly four seconds, which no single short fragment can dominate, and
 * still reports a peak rather than a mean — hls.js needs the rate a burst actually costs.
 */
export const PEAK_WINDOW_SEGMENTS = 3;

export function emptyBitrateSample(): BitrateSample {
  return { totalBytes: 0, totalDuration: 0, peakBps: 0, window: [] };
}

/**
 * Folds one segment into the running measurement.
 *
 * Mutates and returns the sample, because it is also what gets persisted for recovery and there is
 * no value in copying it every segment.
 */
export function recordSegment(sample: BitrateSample, bytes: number, duration: number): BitrateSample {
  if (duration <= 0 || bytes <= 0) {
    return sample;
  }

  sample.totalBytes += bytes;
  sample.totalDuration += duration;

  const window = sample.window ?? (sample.window = []);
  window.push({ bytes, duration });
  if (window.length > PEAK_WINDOW_SEGMENTS) {
    window.shift();
  }

  // Nothing is reported until the window is full. A partial first segment would otherwise set a
  // peak that no later measurement can lower, and until then the encoder's own target is the
  // better answer anyway.
  if (window.length < PEAK_WINDOW_SEGMENTS) {
    return sample;
  }

  const windowBytes = window.reduce((total, segment) => total + segment.bytes, 0);
  const windowDuration = window.reduce((total, segment) => total + segment.duration, 0);
  sample.peakBps = Math.max(sample.peakBps, (windowBytes * 8) / windowDuration);

  return sample;
}

/** HLS's BANDWIDTH, falling back to the encoder's target until enough has been measured. */
export function peakBandwidth(sample: BitrateSample, fallbackBps: number): number {
  return Math.round(sample.peakBps || fallbackBps);
}

/** HLS's AVERAGE-BANDWIDTH, on the same terms. */
export function averageBandwidth(sample: BitrateSample, fallbackBps: number): number {
  const measured = sample.totalDuration > 0 ? (sample.totalBytes * 8) / sample.totalDuration : 0;
  return Math.round(measured || fallbackBps);
}
