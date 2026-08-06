/**
 * Whether a long run held, or merely started well.
 *
 * ## The question a 150 second run cannot answer
 *
 * Everything this project has measured at a viewer is a startup figure. A run publishes for a couple
 * of minutes, the player joins, settles, and the run ends while it is still in the first stretch it
 * ever reached. The owner's actual question has always been steady state: does the stream hold, for
 * an hour, at a constant latency.
 *
 * A single median over an hour cannot answer that either. A run that spends its first half perfect
 * and its second half rebuffering has a respectable median and is a broken stream. So the run is cut
 * into equal windows and each window is reported on its own, which makes a trend visible as a column
 * of numbers rather than as a slope nobody computed.
 *
 * ## What to watch for, specifically
 *
 * The client's manifest state never trims: it appends every segment it has ever seen and rebuilds the
 * whole playlist string on every poll. At a 0.25s segment that is four segments a second, so an hour
 * is roughly 14,000 of them. If that costs anything, it costs more as the run goes on, and the shape
 * it would take is exactly this: early windows fine, late windows degrading. **The trend is the
 * measurement, not the average.**
 */

import { LIVE_SYNC_DURATION_S } from '../bench/clientTuning.js';

import { playbackAdvances, STALLED_ADVANCE_RATIO, type ViewerSample } from './session.js';

/**
 * How long a window covers.
 *
 * Five minutes is long enough that one rebuffer does not dominate a window, and short enough that an
 * hour is twelve of them rather than a number too small to see a trend in.
 */
export const WINDOW_MS = 5 * 60_000;

/**
 * How many windows a run needs before a trend means anything.
 *
 * Two points are a line through any two points. Four is the fewest that can show a direction rather
 * than a difference, and below that this whole section is left out of the report rather than printed
 * with a caveat nobody reads.
 */
export const MIN_WINDOWS_FOR_TREND = 4;

export interface StabilityWindow {
  index: number;
  fromMs: number;
  toMs: number;
  samples: number;
  /** Media seconds per wall second across the window, stalls included. */
  advanceRatio: number;
  /** Samples in this window where the picture did not move. */
  stalledSamples: number;
  medianLatencyS: number | null;
  medianBufferAheadS: number;
  /** Rebuffers the player counted **within** this window, not the running total it reports. */
  rebuffers: number;
}

export interface StabilityVerdict {
  windows: StabilityWindow[];
  /**
   * Change in median latency from the first window to the last, in seconds.
   *
   * Positive means a viewer fell further behind as the run went on, which is the failure a short run
   * structurally cannot see.
   */
  latencyDriftS: number | null;
  /** Advance ratio of the last window against the first. Below 1 means it got worse. */
  advanceDrift: number | null;
  /** Whether every window held its media rate, which is the thing being claimed. */
  heldEveryWindow: boolean;
  /** Whether every window stayed within tolerance of the configured target. */
  heldTargetEveryWindow: boolean;
}

/** Below this, a window did not keep up with real time and the picture was frozen for the rest. */
export const WINDOW_ADVANCE_FLOOR = 0.99;

/** How far a window's median latency may sit from the target before it counts as drifted off it. */
export const WINDOW_LATENCY_TOLERANCE_S = 2;

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * How much of a window has to be covered for it to be reported.
 *
 * A run almost never ends on a window boundary, so the last window is nearly always short by
 * something. Dropping it whenever it is short by anything threw away the final five minutes of every
 * thirty minute run, which is exactly the stretch a long run exists to look at. Dropping it only
 * when it is genuinely a fragment keeps the comparison between windows fair without discarding the
 * end of the run.
 */
export const MIN_WINDOW_COVERAGE = 0.9;

function summarizeWindow(
  index: number,
  samples: readonly ViewerSample[],
  /**
   * The rebuffer count as the previous window ended, or this window's own first sample for the
   * first window.
   *
   * A rebuffer between the last sample of one window and the first of the next belongs to the second
   * one, and measuring within the window alone charged it to neither: both ends read the same total.
   */
  rebuffersBefore: number,
): StabilityWindow {
  const advances = playbackAdvances(samples);
  const wallMs = advances.reduce((total, advance) => total + advance.wallMs, 0);
  const mediaMs = advances.reduce((total, advance) => total + advance.ratio * advance.wallMs, 0);
  const latencies = samples.map((s) => s.liveLatencyS).filter((v): v is number => v !== null);

  return {
    index,
    fromMs: index * WINDOW_MS,
    toMs: (index + 1) * WINDOW_MS,
    samples: samples.length,
    advanceRatio: wallMs > 0 ? mediaMs / wallMs : 0,
    stalledSamples: advances.filter((a) => a.ratio < STALLED_ADVANCE_RATIO).length,
    medianLatencyS: median(latencies),
    medianBufferAheadS: median(samples.map((s) => s.bufferAheadS)) ?? 0,
    rebuffers: samples[samples.length - 1].rebufferCount - rebuffersBefore,
  };
}

export function judgeStability(samples: readonly ViewerSample[]): StabilityVerdict {
  if (samples.length === 0) {
    return {
      windows: [],
      latencyDriftS: null,
      advanceDrift: null,
      heldEveryWindow: false,
      heldTargetEveryWindow: false,
    };
  }

  const startedAtMs = samples[0].atMs;
  const byWindow = new Map<number, ViewerSample[]>();
  samples.forEach((sample) => {
    const index = Math.floor((sample.atMs - startedAtMs) / WINDOW_MS);
    byWindow.set(index, [...(byWindow.get(index) ?? []), sample]);
  });

  // A trailing fragment is dropped rather than reported short, since it covers less wall clock than
  // the others and would read as a change in the thing being measured. Judged on what the window
  // actually spans rather than on where the run happened to stop.
  const spanned = ([, inWindow]: [number, ViewerSample[]]): number =>
    inWindow[inWindow.length - 1].atMs - inWindow[0].atMs;
  const complete = [...byWindow.entries()]
    .sort(([a], [b]) => a - b)
    .filter((entry) => spanned(entry) >= WINDOW_MS * MIN_WINDOW_COVERAGE);

  let rebuffersBefore = samples[0].rebufferCount;
  const windows = complete.map(([index, inWindow]) => {
    const window = summarizeWindow(index, inWindow, rebuffersBefore);
    rebuffersBefore = inWindow[inWindow.length - 1].rebufferCount;
    return window;
  });
  if (windows.length === 0) {
    return { windows, latencyDriftS: null, advanceDrift: null, heldEveryWindow: false, heldTargetEveryWindow: false };
  }

  const first = windows[0];
  const last = windows[windows.length - 1];
  const floor = LIVE_SYNC_DURATION_S - WINDOW_LATENCY_TOLERANCE_S;
  const ceiling = LIVE_SYNC_DURATION_S + WINDOW_LATENCY_TOLERANCE_S;

  return {
    windows,
    latencyDriftS:
      first.medianLatencyS !== null && last.medianLatencyS !== null ? last.medianLatencyS - first.medianLatencyS : null,
    advanceDrift: first.advanceRatio > 0 ? last.advanceRatio / first.advanceRatio : null,
    heldEveryWindow: windows.every((w) => w.advanceRatio >= WINDOW_ADVANCE_FLOOR),
    heldTargetEveryWindow: windows.every(
      (w) => w.medianLatencyS !== null && w.medianLatencyS >= floor && w.medianLatencyS <= ceiling,
    ),
  };
}

export function stabilitySection(verdict: StabilityVerdict): string[] {
  if (verdict.windows.length < MIN_WINDOWS_FOR_TREND) {
    return [];
  }

  const minutes = (ms: number): string => `${Math.round(ms / 60_000)}`;
  const orDash = (v: number | null): string => (v === null ? '—' : v.toFixed(2));

  const lines = [
    '## Did it hold, or did it only start well',
    '',
    `The run cut into ${verdict.windows.length} windows of ${WINDOW_MS / 60_000} minutes. A median over the ` +
      'whole run cannot tell a stream that held from one that was perfect for half of it, so each window ' +
      'is reported on its own and the trend is the measurement.',
    '',
    '| window | media s per wall s | frozen samples | behind live, median | buffered, median | rebuffers |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...verdict.windows.map(
      (w) =>
        `| ${minutes(w.fromMs)}–${minutes(w.toMs)} min | ${w.advanceRatio.toFixed(3)} | ${w.stalledSamples} | ` +
        `${orDash(w.medianLatencyS)}s | ${w.medianBufferAheadS.toFixed(2)}s | ${w.rebuffers} |`,
    ),
    '',
  ];

  if (verdict.heldEveryWindow) {
    lines.push(
      `✅ **Every window kept up with real time**, at or above ${WINDOW_ADVANCE_FLOOR}. The stream did not ` +
        'degrade as it went on.',
      '',
    );
  } else {
    const worst = verdict.windows.reduce((a, b) => (a.advanceRatio <= b.advanceRatio ? a : b));
    lines.push(
      `⛔ **Not every window kept up.** The worst was ${minutes(worst.fromMs)}–${minutes(worst.toMs)} min at ` +
        `${worst.advanceRatio.toFixed(3)}, with ${worst.stalledSamples} frozen samples. Read the column rather ` +
        'than the average: where in the run it happened is the whole finding.',
      '',
    );
  }

  if (verdict.latencyDriftS !== null) {
    const drift = verdict.latencyDriftS;
    lines.push(
      Math.abs(drift) <= WINDOW_LATENCY_TOLERANCE_S
        ? `✅ **Latency did not drift.** ${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s from the first window to the ` +
            'last, which is the constant latency the whole exercise is for.'
        : `⛔ **Latency drifted by ${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s** across the run. A viewer ` +
            `${drift > 0 ? 'fell further behind' : 'crept toward the edge'} the longer they watched, which no ` +
            'short run could have shown.',
      '',
    );
  }

  return lines;
}
