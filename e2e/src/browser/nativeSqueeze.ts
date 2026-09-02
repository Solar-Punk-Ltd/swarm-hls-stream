/**
 * What a cap did to weeb-3's own player, phase by phase.
 *
 * ## The question, in one sentence
 *
 * Our client, driving our pinned weeb-3 build, could not keep a 360p recording moving once Chrome's
 * emulation capped the tab at 2800 kbps. Abel's own published page is the same node in a client we
 * did not write, so running it against the same recording under the same cap says whether the cap
 * beats the node or beats our harness.
 *
 * ## ⛔ Nothing here asserts, and a phase nobody sampled says so
 *
 * Owner ruling of 2026-08-29: a ratio, a duration and a byte rate are measured, printed under a
 * heading that says they are observations, and refuse nothing. The one thing this module is strict
 * about is the difference between a reading of zero and no reading at all. A phase with fewer than
 * two samples has no pair to subtract, so every figure derived from a pair comes back null. Zero is
 * what a starved viewer produces, and a window nobody sampled must not borrow that reading.
 *
 * ## Where the byte figures come from
 *
 * weeb-3 exposes no retrieval telemetry, and its page exposes no player handle either, so the tab's
 * WebSocket frames are the only vantage point on what the node pulled. See `webSocketTraffic.ts`:
 * yamux multiplexes many streams onto one socket, so bytes are readable and attempts are not, and
 * nothing here claims an attempt count.
 *
 * @see `docs/bench/in-tab-throttle-probe-result-2026-09-02.md` for the run this is the control for.
 */

import { kbpsAsBytesPerSecond } from './throttle.js';
import { bytesBetween, type WebSocketTraffic } from './webSocketTraffic.js';

const MS_PER_SECOND = 1_000;

/** Decimal places a ratio is reported to, one place finer than the differences it has to show. */
const RATIO_DIGITS = 4;

/**
 * Media that must exist beyond the three windows before a squeeze run may start.
 *
 * ⛔⛔ Without it a run measures the recording ending rather than the delivery of it. The first run
 * of this driver counted 180 seconds with the playhead on the final frame and reported a realtime
 * ratio of 0.068, which reads as a delivery failure and is nothing of the kind. Twenty seconds is
 * the slack for a seek that lands late and for a boot that overruns.
 */
export const SQUEEZE_MEDIA_HEADROOM_S = 20;

/**
 * One poll of weeb-3's page, reduced to what a squeeze question needs.
 *
 * Deliberately smaller than the driver's own sample type, so the judgements below can be tested
 * against series nobody had to broadcast for. `stalls` is optional because the driver polls the
 * page's stall counter only in squeeze mode, where a per-phase delta is wanted.
 */
export interface NativeSqueezeSample {
  atMs: number;
  currentTime: number;
  stalls?: number | null;
}

/** One stretch of a run on the driver's own wall clock. Half open, `[fromMs, toMs)`. */
export interface PhaseWindow {
  fromMs: number;
  toMs: number;
}

/**
 * The three stretches a squeeze run is read in, and the two moments the cap itself moved.
 *
 * ⛔ The cap's own timestamps are carried beside the windows rather than derived from them. Applying
 * a cap is an await, so the moment it landed is not the moment the settle window stopped being
 * sampled, and a report that conflated the two would date the treatment by the instrument.
 */
export interface NativeSqueezeWindows {
  before: PhaseWindow;
  during: PhaseWindow;
  after: PhaseWindow;
  appliedAtMs: number;
  liftedAtMs: number;
  kbps: number;
}

/** How long each window is asked to run for, in seconds, which is what a recording has to hold. */
interface SqueezeWindowSeconds {
  settleS: number;
  squeezeS: number;
  recoverS: number;
}

type PhaseName = 'before' | 'during' | 'after';

/**
 * One phase, with every figure the run can offer about it.
 *
 * Not exported: it is reachable as `NativeSqueezeResult['during']` for anyone who needs to name it,
 * and an exported name with no importer is what the unused-export ratchet exists to catch.
 */
interface NativeSqueezePhase {
  name: PhaseName;
  window: PhaseWindow;
  samples: number;
  mediaGainedS: number | null;
  wallSpentS: number | null;
  realtimeRatio: number | null;
  stallsDelta: number | null;
  inboundBytes: number;
  inboundBytesPerSecondMean: number | null;
  /** Inbound bytes per second of media the playhead gained, or null where it gained none. */
  inboundBytesPerMediaSecond: number | null;
}

export interface NativeSqueezeResult {
  windows: NativeSqueezeWindows;
  before: NativeSqueezePhase;
  during: NativeSqueezePhase;
  after: NativeSqueezePhase;
}

function samplesIn(samples: readonly NativeSqueezeSample[], window: PhaseWindow): NativeSqueezeSample[] {
  return samples.filter((sample) => sample.atMs >= window.fromMs && sample.atMs < window.toMs);
}

/** A counter's movement across the phase, or null where the phase cannot show one. */
function stallsDelta(phase: readonly NativeSqueezeSample[]): number | null {
  if (phase.length < 2) {
    return null;
  }
  const first = phase[0].stalls;
  const last = phase[phase.length - 1].stalls;
  if (first === undefined || first === null || last === undefined || last === null) {
    return null;
  }
  return last - first;
}

function rounded(value: number): number {
  return Number(value.toFixed(RATIO_DIGITS));
}

function judgePhase(
  name: PhaseName,
  window: PhaseWindow,
  samples: readonly NativeSqueezeSample[],
  traffic: WebSocketTraffic,
): NativeSqueezePhase {
  const phase = samplesIn(samples, window);
  const windowSeconds = (window.toMs - window.fromMs) / MS_PER_SECOND;
  const inboundBytes = bytesBetween(traffic.frames, window.fromMs, window.toMs, 'in');

  // ⭐ Rounded once, here, and every figure below divides the rounded values. An artifact whose
  // numerator, denominator and quotient do not multiply out invites exactly the recomputation that
  // finds a defect in the reader rather than in the run.
  const paired = phase.length >= 2;
  const mediaGainedS = paired ? rounded(phase[phase.length - 1].currentTime - phase[0].currentTime) : null;
  const wallSpentS = paired ? rounded((phase[phase.length - 1].atMs - phase[0].atMs) / MS_PER_SECOND) : null;

  return {
    name,
    window,
    samples: phase.length,
    mediaGainedS,
    wallSpentS,
    realtimeRatio:
      mediaGainedS === null || wallSpentS === null || wallSpentS <= 0 ? null : rounded(mediaGainedS / wallSpentS),
    stallsDelta: stallsDelta(phase),
    inboundBytes,
    inboundBytesPerSecondMean: windowSeconds > 0 ? inboundBytes / windowSeconds : null,
    inboundBytesPerMediaSecond: mediaGainedS !== null && mediaGainedS > 0 ? inboundBytes / mediaGainedS : null,
  };
}

export function judgeNativeSqueeze(
  samples: readonly NativeSqueezeSample[],
  windows: NativeSqueezeWindows,
  traffic: WebSocketTraffic,
): NativeSqueezeResult {
  return {
    windows,
    before: judgePhase('before', windows.before, samples, traffic),
    during: judgePhase('during', windows.during, samples, traffic),
    after: judgePhase('after', windows.after, samples, traffic),
  };
}

/**
 * Media the playhead must gain past the seek before weeb-3's own player counts as having started.
 *
 * A whole second rather than a frame. His page reports decodable media and then buffers, and a
 * playhead that twitches by a fraction during that has not begun a session anything can be read off.
 */
const PLAYHEAD_STARTED_ADVANCE_S = 1;

/**
 * Whether the playhead has advanced far enough past the seek to call his player started.
 *
 * ⛔⛔ The judgement a settle window has to wait on. weeb-3's page reaches `readyState >= 2` tens of
 * seconds before its playhead moves, 26.1 s on 2026-08-16, and a window opened at the earlier moment
 * reads his startup and then files it as the uncapped baseline the capped phase is judged against.
 * The run of 2026-09-02 17:57 did exactly that and reported 0.087 before the cap, 0.000 under it and
 * 0.000 after, which is a startup measured three times rather than a cap measured once.
 *
 * @param startSample The poll taken where the seek left the playhead, which advance is measured from.
 * @see `docs/bench/weeb3-native-arm-2026-08-16.md` for the 26.1 s reading.
 */
export function playheadHasMoved(
  startSample: NativeSqueezeSample,
  sample: NativeSqueezeSample,
  minAdvanceS: number = PLAYHEAD_STARTED_ADVANCE_S,
): boolean {
  return sample.currentTime - startSample.currentTime >= minAdvanceS;
}

/**
 * The sentence a squeeze run stops on when his player never moved its playhead at all.
 *
 * ⛔ A refusal rather than three phases of zero. The env var it names belongs to the driver, and it
 * is named here because this sentence is the only thing an operator sees.
 *
 * @param peers The page's own peer count, or null where the page never reported one.
 */
export function playheadNeverMovedRefusal(waitedS: number, peers: number | null): string {
  const peerLabel = peers === null ? 'a peer count the page did not report' : `${peers} peers`;

  return (
    `weeb-3's page reported decodable media and then held its playhead still for ${waitedS.toFixed(0)} s, ` +
    `with ${peerLabel}. His player never started, so nothing measured below this point would be a cap ` +
    'reading: a settle window opened here would have read his startup and then stood in as the uncapped ' +
    'baseline the capped phase is judged against. Give the wait longer with WEEB3_NATIVE_START_WAIT_S'
  );
}

/**
 * Why this recording cannot carry a squeeze run, or null.
 *
 * ⛔ Its own predicate so the driver can refuse before it spends three windows, and so the reason
 * reaching an operator is a sentence rather than a ratio of 0.068 nobody can explain.
 */
export function shortRecordingRefusal(durationS: number | null, seconds: SqueezeWindowSeconds): string | null {
  const needed = seconds.settleS + seconds.squeezeS + seconds.recoverS + SQUEEZE_MEDIA_HEADROOM_S;

  if (durationS === null) {
    return (
      "weeb-3's page reported no finite duration for this broadcast, so there is no way to tell whether " +
      `the ${needed} s a squeeze run consumes exists ahead of the playhead. Squeeze mode is for a ` +
      'FINISHED recording: a live playlist reports an endless duration, and a run against one would ' +
      'measure the live edge while its report said it had measured a recording'
    );
  }

  if (durationS < needed) {
    return (
      `this recording is ${durationS.toFixed(1)} s long and a squeeze run needs ${needed} s of media ahead ` +
      `of the playhead: ${seconds.settleS} s to settle, ${seconds.squeezeS} s capped, ${seconds.recoverS} s ` +
      `to recover and ${SQUEEZE_MEDIA_HEADROOM_S} s of headroom. A run that outlasts its recording measures ` +
      'the media running out rather than the delivery of it, and that reads exactly like a delivery failure'
    );
  }

  return null;
}

function ratioLabel(ratio: number | null): string {
  return ratio === null ? 'no ratio' : ratio.toFixed(3);
}

/** Digits grouped without going through a locale, so an artifact reads the same on every machine. */
function grouped(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function secondsLabel(seconds: number | null): string {
  return seconds === null ? 'not measurable' : `${seconds.toFixed(1)}s`;
}

function bytesLabel(bytes: number | null, unit: string): string {
  return bytes === null ? 'not measurable' : `${grouped(bytes)} ${unit}`;
}

const PHASE_HEADINGS: Record<PhaseName, string> = {
  before: 'before, uncapped',
  during: 'capped',
  after: 'after the lift',
};

function phaseRow(phase: NativeSqueezePhase): string {
  return [
    `| ${PHASE_HEADINGS[phase.name]}`,
    secondsLabel((phase.window.toMs - phase.window.fromMs) / MS_PER_SECOND),
    String(phase.samples),
    secondsLabel(phase.mediaGainedS),
    secondsLabel(phase.wallSpentS),
    `**${ratioLabel(phase.realtimeRatio)}**`,
    phase.stallsDelta === null ? 'not polled' : String(phase.stallsDelta),
    bytesLabel(phase.inboundBytes, 'B'),
    bytesLabel(phase.inboundBytesPerSecondMean, 'B/s'),
    `${bytesLabel(phase.inboundBytesPerMediaSecond, 'B')} |`,
  ].join(' | ');
}

/** The section a squeeze run's report carries, so nothing has to be reconstructed by hand later. */
export function renderNativeSqueezeSection(result: NativeSqueezeResult): string[] {
  const { windows } = result;
  const cappedForS = (windows.liftedAtMs - windows.appliedAtMs) / MS_PER_SECOND;

  return [
    "## What a cap did to weeb-3's own player: observations, none of them asserted",
    '',
    `The tab's download was capped at **${windows.kbps} kbps** for ${cappedForS.toFixed(1)}s, applied over the ` +
      "page's own debug session from inside this process, so the moment the cap landed and the moment a " +
      'sample was taken come off one clock. Nothing below refuses a run.',
    '',
    '| phase | window | samples | media gained | wall spent | realtime ratio | stalls added | inbound | mean inbound | inbound per media second |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    phaseRow(result.before),
    phaseRow(result.during),
    phaseRow(result.after),
    '',
    '⛔ A phase with fewer than two samples reads **no ratio**, never 0.000. Zero is what a starved ' +
      'viewer produces, and a window nobody sampled must not borrow that reading.',
    '',
    "⛔⛔ The inbound figures are the tab's WebSocket frames, which is the only vantage point on a node " +
      'that publishes no retrieval telemetry. yamux multiplexes many streams onto one socket, so these ' +
      'are bytes and never attempts, and no attempt count is claimed here.',
    '',
    "⚠️ The cap is applied by Chromium and reaching a given transport is the browser's business. The " +
      `${windows.kbps} kbps cap allows **${grouped(kbpsAsBytesPerSecond(windows.kbps))} B/s**, so read the ` +
      'capped row against that figure before believing anything in it: a capped phase pulling more than ' +
      'its cap is an uncapped link with a cap written beside it, and every capped figure here would then ' +
      'be a reading of an unconstrained one.',
    '',
  ];
}

/** The one line a squeeze run prints as it finishes, which is what an operator reads first. */
export function nativeSqueezeConsoleLine(result: NativeSqueezeResult): string {
  return (
    `realtime ratio ${ratioLabel(result.before.realtimeRatio)} before, ` +
    `${ratioLabel(result.during.realtimeRatio)} capped at ${result.windows.kbps} kbps, ` +
    `${ratioLabel(result.after.realtimeRatio)} after`
  );
}
