import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  judgeNativeSqueeze,
  nativeSqueezeConsoleLine,
  type NativeSqueezeResult,
  type NativeSqueezeSample,
  type NativeSqueezeWindows,
  type PhaseWindow,
  renderNativeSqueezeSection,
  shortRecordingRefusal,
  SQUEEZE_MEDIA_HEADROOM_S,
} from '../src/browser/nativeSqueeze.js';
import { type WebSocketFrame, type WebSocketTraffic } from '../src/browser/webSocketTraffic.js';

/**
 * The arithmetic a squeeze of weeb-3's own page is read out of, on hand-built series.
 *
 * ⛔ Nothing here asserts a ratio against a floor or a ceiling. What is tested is that a phase too
 * short to carry a ratio says so instead of reporting zero, that a sample on a phase boundary lands
 * in exactly one phase, and that the rendered section and the console line can both say "no ratio"
 * out loud. A phase reporting 0.000 for a window nobody sampled is the shape of defect this project
 * has already published once, and zero reads as a delivery failure rather than as a missing reading.
 */

const START_MS = 1_756_800_000_000;
const MS_PER_SECOND = 1_000;
const SETTLE_S = 45;
const SQUEEZE_S = 60;
const RECOVER_S = 60;
const CAP_KBPS = 2_800;

const APPLIED_AT_MS = START_MS + SETTLE_S * MS_PER_SECOND;
const LIFTED_AT_MS = APPLIED_AT_MS + SQUEEZE_S * MS_PER_SECOND;

const WINDOW_SECONDS = { settleS: SETTLE_S, squeezeS: SQUEEZE_S, recoverS: RECOVER_S };

function phaseWindow(fromMs: number, seconds: number): PhaseWindow {
  return { fromMs, toMs: fromMs + seconds * MS_PER_SECOND };
}

function windows(overrides: Partial<NativeSqueezeWindows> = {}): NativeSqueezeWindows {
  return {
    before: phaseWindow(START_MS, SETTLE_S),
    during: phaseWindow(APPLIED_AT_MS, SQUEEZE_S),
    after: phaseWindow(LIFTED_AT_MS, RECOVER_S),
    appliedAtMs: APPLIED_AT_MS,
    liftedAtMs: LIFTED_AT_MS,
    kbps: CAP_KBPS,
    ...overrides,
  };
}

interface SeriesShape {
  fromMs: number;
  seconds: number;
  /** Media seconds the playhead gains per wall second across this stretch. */
  ratio: number;
  currentTime: number;
  stalls?: number;
}

/** One sample a second, gaining media at a chosen ratio, which is what a phase is judged from. */
function series(shape: SeriesShape): NativeSqueezeSample[] {
  return Array.from({ length: shape.seconds }, (_unused, index) => ({
    atMs: shape.fromMs + index * MS_PER_SECOND,
    currentTime: shape.currentTime + index * shape.ratio,
    ...(shape.stalls === undefined ? {} : { stalls: shape.stalls }),
  }));
}

/** A run that played at real time, was capped and crawled, then recovered. */
function healthyThenCapped(): NativeSqueezeSample[] {
  return [
    ...series({ fromMs: START_MS, seconds: SETTLE_S, ratio: 1, currentTime: 0, stalls: 0 }),
    ...series({ fromMs: APPLIED_AT_MS, seconds: SQUEEZE_S, ratio: 0.4, currentTime: 100, stalls: 2 }),
    ...series({ fromMs: LIFTED_AT_MS, seconds: RECOVER_S, ratio: 1, currentTime: 200, stalls: 7 }),
  ];
}

const noTraffic: WebSocketTraffic = { connections: [], frames: [] };

function inbound(atMs: number, bytes: number): WebSocketFrame {
  return { atMs, direction: 'in', bytes };
}

function outbound(atMs: number, bytes: number): WebSocketFrame {
  return { atMs, direction: 'out', bytes };
}

function judged(samples: readonly NativeSqueezeSample[], traffic: WebSocketTraffic = noTraffic): NativeSqueezeResult {
  return judgeNativeSqueeze(samples, windows(), traffic);
}

describe('what each phase of a squeeze gained', () => {
  it('reads a phase that kept up as a ratio of about one', () => {
    const result = judged(healthyThenCapped());

    assert.equal(result.before.realtimeRatio, 1);
    assert.equal(result.before.mediaGainedS, SETTLE_S - 1);
    assert.equal(result.before.wallSpentS, SETTLE_S - 1);
  });

  it('reads the capped phase off its own window rather than off the whole run', () => {
    const result = judged(healthyThenCapped());

    assert.ok(result.during.realtimeRatio !== null);
    assert.ok(Math.abs(result.during.realtimeRatio - 0.4) < 1e-9);
  });

  it('reads the recovery phase separately from the cap it followed', () => {
    const result = judged(healthyThenCapped());

    assert.equal(result.after.realtimeRatio, 1);
  });

  /**
   * ⛔ Zero is the reading a starved viewer produces, so a phase nobody sampled must not borrow it.
   * A single sample carries no pair to subtract and therefore no ratio of any kind.
   */
  it('reports no ratio rather than zero for a phase with one sample', () => {
    const single = series({ fromMs: APPLIED_AT_MS, seconds: 1, ratio: 1, currentTime: 100 });
    const result = judged(single);

    assert.equal(result.during.samples, 1);
    assert.equal(result.during.realtimeRatio, null);
    assert.equal(result.during.mediaGainedS, null);
    assert.equal(result.during.wallSpentS, null);
  });

  it('reports no ratio rather than zero for a phase with no samples at all', () => {
    const result = judged([]);

    assert.equal(result.before.samples, 0);
    assert.equal(result.before.realtimeRatio, null);
    assert.equal(result.during.realtimeRatio, null);
    assert.equal(result.after.realtimeRatio, null);
  });

  /**
   * ⛔ Half open, so three windows laid end to end count every sample exactly once. A sample counted
   * in both halves of a boundary would move media into a phase that did not play it.
   */
  it('gives a sample taken exactly when the cap lifted to the phase after it', () => {
    const boundary: NativeSqueezeSample[] = [
      { atMs: APPLIED_AT_MS, currentTime: 10 },
      { atMs: LIFTED_AT_MS - 1, currentTime: 20 },
      { atMs: LIFTED_AT_MS, currentTime: 30 },
      { atMs: LIFTED_AT_MS + MS_PER_SECOND, currentTime: 40 },
    ];
    const result = judged(boundary);

    assert.equal(result.during.samples, 2);
    assert.equal(result.after.samples, 2);
  });

  it('carries the windows it was judged against, so a reader needs no second file', () => {
    const result = judged(healthyThenCapped());

    assert.equal(result.windows.kbps, CAP_KBPS);
    assert.equal(result.windows.appliedAtMs, APPLIED_AT_MS);
    assert.equal(result.windows.liftedAtMs, LIFTED_AT_MS);
  });
});

describe('the stalls a phase added', () => {
  it('reads the delta across the phase rather than the counter itself', () => {
    const stalling: NativeSqueezeSample[] = [
      { atMs: APPLIED_AT_MS, currentTime: 100, stalls: 2 },
      { atMs: APPLIED_AT_MS + MS_PER_SECOND, currentTime: 100.2, stalls: 5 },
      { atMs: APPLIED_AT_MS + 2 * MS_PER_SECOND, currentTime: 100.4, stalls: 9 },
    ];
    const result = judged(stalling);

    assert.equal(result.during.stallsDelta, 7);
  });

  it('reports no delta when the driver never polled the counter', () => {
    const unpolled = series({ fromMs: APPLIED_AT_MS, seconds: 5, ratio: 0.4, currentTime: 100 });
    const result = judged(unpolled);

    assert.equal(result.during.stallsDelta, null);
  });

  it('reports no delta from a single sample, which has nothing to subtract', () => {
    const single: NativeSqueezeSample[] = [{ atMs: APPLIED_AT_MS, currentTime: 100, stalls: 4 }];
    const result = judged(single);

    assert.equal(result.during.stallsDelta, null);
  });
});

describe('what the tab pulled over its own sockets in each phase', () => {
  const traffic: WebSocketTraffic = {
    connections: [],
    frames: [
      inbound(START_MS + MS_PER_SECOND, 1_000),
      outbound(START_MS + MS_PER_SECOND, 40_000),
      inbound(APPLIED_AT_MS, 7_000),
      inbound(APPLIED_AT_MS + MS_PER_SECOND, 5_000),
      outbound(APPLIED_AT_MS + MS_PER_SECOND, 900),
      inbound(LIFTED_AT_MS, 2_000),
    ],
  };

  it('sums the inbound frames inside the phase window and leaves the outbound ones out', () => {
    const result = judged(healthyThenCapped(), traffic);

    assert.equal(result.before.inboundBytes, 1_000);
    assert.equal(result.during.inboundBytes, 12_000);
    assert.equal(result.after.inboundBytes, 2_000);
  });

  /**
   * ⛔ The mean divides by the whole window rather than by the seconds something arrived in. The
   * question is what share of the phase the node's traffic took, and a mean over only the busy
   * seconds answers a different one in the same units.
   */
  it('divides the mean by the whole window rather than by the busy seconds', () => {
    const result = judged(healthyThenCapped(), traffic);

    assert.equal(result.during.inboundBytesPerSecondMean, 12_000 / SQUEEZE_S);
  });

  it('reports inbound bytes per second of media the playhead actually gained', () => {
    const result = judged(healthyThenCapped(), traffic);

    assert.ok(result.during.mediaGainedS !== null);
    assert.equal(result.during.inboundBytesPerMediaSecond, 12_000 / result.during.mediaGainedS);
  });

  /**
   * ⛔ Null rather than Infinity or zero. A phase whose playhead never moved has not shown an
   * infinite cost per media second, it has shown a row that cannot answer the question.
   */
  it('reports no per-media-second figure when the playhead gained nothing', () => {
    const frozen: NativeSqueezeSample[] = [
      { atMs: APPLIED_AT_MS, currentTime: 100 },
      { atMs: LIFTED_AT_MS - MS_PER_SECOND, currentTime: 100 },
    ];
    const result = judged(frozen, traffic);

    assert.equal(result.during.mediaGainedS, 0);
    assert.equal(result.during.inboundBytesPerMediaSecond, null);
  });

  it('reports no mean at all for a window of no length', () => {
    const empty = windows({ during: { fromMs: APPLIED_AT_MS, toMs: APPLIED_AT_MS } });
    const result = judgeNativeSqueeze(healthyThenCapped(), empty, traffic);

    assert.equal(result.during.inboundBytesPerSecondMean, null);
  });
});

describe('whether the recording is long enough to be squeezed at all', () => {
  const enough = SETTLE_S + SQUEEZE_S + RECOVER_S + SQUEEZE_MEDIA_HEADROOM_S;

  it('lets a recording through when it holds the three windows and the headroom', () => {
    assert.equal(shortRecordingRefusal(enough + 1, WINDOW_SECONDS), null);
  });

  it('lets a recording through that holds exactly the three windows and the headroom', () => {
    assert.equal(shortRecordingRefusal(enough, WINDOW_SECONDS), null);
  });

  it('refuses a recording a second short, and says how much media it needed', () => {
    const refusal = shortRecordingRefusal(enough - 1, WINDOW_SECONDS);

    assert.ok(refusal !== null);
    assert.match(refusal, new RegExp(String(enough)));
  });

  /**
   * ⛔ A page reporting no finite duration is refused rather than waved through. A live playlist
   * reports Infinity, and a squeeze run against one would seek nowhere and measure the live edge
   * while its report said it had measured a recording.
   */
  it('refuses when the page reported no finite duration', () => {
    const refusal = shortRecordingRefusal(null, WINDOW_SECONDS);

    assert.ok(refusal !== null);
    assert.match(refusal, /duration/i);
  });
});

describe('the section a squeeze run files beside its report', () => {
  const rendered = (samples: NativeSqueezeSample[], traffic = noTraffic): string =>
    renderNativeSqueezeSection(judged(samples, traffic)).join('\n');

  it('says out loud that nothing in it is asserted', () => {
    assert.match(rendered(healthyThenCapped()), /none of them asserted/);
  });

  it('names all three phases and the cap the middle one ran under', () => {
    const section = rendered(healthyThenCapped());

    assert.match(section, /before/);
    assert.match(section, /capped/);
    assert.match(section, /after/);
    assert.match(section, new RegExp(String(CAP_KBPS)));
  });

  /**
   * ⛔ The cap's own allowance, in the units the table reports, so the reader standing in front of
   * the capped row can see whether the cap reached the transport at all. Chromium applies the
   * emulation and whether it reaches a WebSocket is the browser's business, so a capped row pulling
   * more than its cap is an uncapped link, and a note asking for arithmetic nobody does is not a
   * check. This project has already published capped figures whose instrument nothing had read.
   */
  it('prints what the cap allows in the same units as the inbound column', () => {
    assert.match(rendered(healthyThenCapped()), /350,000 B\/s/);
  });

  /** The ratio cell is the bolded one, so a bolded zero could only be a phase claiming a reading. */
  it('prints a missing ratio in words rather than as a number', () => {
    const section = rendered([]);

    assert.match(section, /\*\*no ratio\*\*/);
    assert.doesNotMatch(section, /\*\*0\.000\*\*/);
  });
});

describe('the line a squeeze run prints as it finishes', () => {
  it('names the three ratios and the cap they bracket', () => {
    const line = nativeSqueezeConsoleLine(judged(healthyThenCapped()));

    assert.match(line, /1\.000/);
    assert.match(line, /0\.400/);
    assert.match(line, new RegExp(String(CAP_KBPS)));
  });

  it('says so rather than printing zero when a phase carries no ratio', () => {
    const line = nativeSqueezeConsoleLine(judged([]));

    assert.doesNotMatch(line, /0\.000/);
  });
});
