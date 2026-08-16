import { median } from '../bench/sweepAnalysis.js';

/**
 * One poll of a media element, reduced to what a live-edge question needs.
 *
 * Deliberately smaller than the drivers' own sample types. It exists so the judgements below can be
 * tested against series nobody had to broadcast for.
 */
export interface EdgeSample {
  atMs: number;
  currentTime: number;
  bufferedEnd: number | null;
  seekableEnd: number | null;
  duration: number | null;
}

/** How close to the end the playhead must sit before a window is a candidate for having run out. */
export const EXHAUSTED_EDGE_S = 2;

/** Media the playhead may gain across a whole window and still count as stopped. */
export const EXHAUSTED_ADVANCE_S = 1;

/**
 * Movement below this across a whole window is jitter rather than a live edge.
 *
 * A live edge advances about a second per wall second, so a window of any useful length separates
 * the two by orders of magnitude. The threshold is loose on purpose: it decides whether a result is
 * void, and voiding a real measurement is worse than reporting one that needs a second look.
 */
export const EXHAUSTED_EDGE_ADVANCE_S = 0.5;

/**
 * The newest media this page can actually play, in media seconds.
 *
 * `seekable` first because it is what the player would let a viewer reach. `buffered` is the fallback
 * for a page that reports no seekable range, and `duration` last because on a live stream it is
 * whatever the player chose to advertise.
 */
export function appendedEdge(sample: EdgeSample): number | null {
  return sample.seekableEnd ?? sample.bufferedEnd ?? sample.duration;
}

/**
 * How far the playhead sits behind the newest media this page has appended.
 *
 * ## ⛔⛔ This is NOT hls.js's `latency`, and the two must never share a column
 *
 * Checked in a real browser on 2026-08-16: weeb-3's page bundles hls.js as an ES module and exposes
 * no handle on `window`, no expando on the video element and no React fiber, so the player's own
 * latency figure is unreachable from outside it. What is left is the media element.
 *
 * ⛔⛔⛔ **A slower retrieval makes this number smaller**, because an edge only moves once a segment
 * has been fetched and appended. A segment the publisher advertised a moment ago but this node has
 * not yet pulled is not in `seekable` at all. So it is a floor on the real distance from live, and
 * it flatters whichever arm is struggling most. Rank arms on {@link behindProductionS}, which reads
 * a clock outside both viewers and cannot do that.
 */
export function appendedEdgeLagS(sample: EdgeSample): number | null {
  const edge = appendedEdge(sample);

  return edge === null ? null : edge - sample.currentTime;
}

/** Media seconds the newest appended media advanced across the window. Null if under two readings. */
export function edgeGrowthS(samples: readonly EdgeSample[]): number | null {
  const edges = samples.map(appendedEdge).filter((edge): edge is number => edge !== null);

  return edges.length < 2 ? null : edges[edges.length - 1] - edges[0];
}

/** Media seconds the playhead consumed across the window. */
export function playheadGrowthS(samples: readonly EdgeSample[]): number {
  return samples.length < 2 ? 0 : samples[samples.length - 1].currentTime - samples[0].currentTime;
}

/**
 * Did this window measure the media running out rather than the delivery of it?
 *
 * ## ⛔⛔⛔ A SNAPSHOT CANNOT TELL A LIVE EDGE FROM A RECORDING THAT ENDED
 *
 * The first version of this check was `duration - currentTime < 2` read once at the end. That is the
 * failure state on a recording and the **healthy** state on live, where a viewer is supposed to sit
 * a second or two behind an edge that keeps moving. Shipped as it was, every good live arm would
 * have been voided and the sitting would have come back with nothing.
 *
 * What separates them is whether the edge **moved**. On live it advances with the wall clock whether
 * or not this viewer keeps up. On a finished recording it is fixed and the playhead stops against it.
 *
 * ⭐ All three conditions have to hold together, and the third is what keeps a **live stall** out of
 * here: a viewer frozen against an advancing edge is a delivery failure worth reporting, not a void
 * window. Voiding it would delete the very result this instrument exists to catch.
 */
export function isExhausted(samples: readonly EdgeSample[]): boolean {
  const edgeGrowth = edgeGrowthS(samples);
  if (edgeGrowth === null) {
    return false;
  }

  const lag = appendedEdgeLagS(samples[samples.length - 1]);

  return (
    lag !== null &&
    lag < EXHAUSTED_EDGE_S &&
    edgeGrowth < EXHAUSTED_EDGE_ADVANCE_S &&
    playheadGrowthS(samples) < EXHAUSTED_ADVANCE_S
  );
}

/**
 * Wall seconds since the broadcast started, minus the media seconds the playhead has consumed.
 *
 * ⭐ The one number that ranks a live arm, because it is read off a clock **outside both viewers**
 * rather than off either player's self-report. A viewer that falls behind shows it here immediately,
 * however its own player chooses to describe itself. It needs only when the publisher started, which
 * the arms wrapper knows exactly because it starts the publisher.
 *
 * ⚠️ It assumes the encoder produced media at 1x. This project has a publisher that can outrun
 * ffmpeg's `-re`, so a sitting checks produced media against wall time separately. This function
 * asserts nothing about that and neither should a table built from it.
 */
export function behindProductionS(sample: EdgeSample, broadcastStartMs: number): number {
  return (sample.atMs - broadcastStartMs) / 1_000 - sample.currentTime;
}

export interface EdgeLagSummary {
  medianS: number | null;
  maxS: number | null;
  readings: number;
}

/** The distribution of {@link appendedEdgeLagS} across a window, for a driver that has to print one row. */
export function edgeLagSummary(samples: readonly EdgeSample[]): EdgeLagSummary {
  const lags = samples.map(appendedEdgeLagS).filter((lag): lag is number => lag !== null);
  if (lags.length === 0) {
    return { medianS: null, maxS: null, readings: 0 };
  }

  return { medianS: median(lags), maxS: Math.max(...lags), readings: lags.length };
}
