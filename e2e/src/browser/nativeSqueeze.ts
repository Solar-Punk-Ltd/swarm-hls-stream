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
 * ## ⛔⛔⛔ THE SQUEEZE RUNS OF 2026-09-02 ARE VOID, AND FOR OUR REASONS
 *
 * His page runs the node in a SharedWorker exactly as our client does. The cap was applied to the
 * page's own debug session, which the node's sockets do not belong to, and the recorder listened on
 * the same page. So "1.000x under the cap" was a reading of an unconstrained link taken by an
 * instrument that could not see it, and nothing in the run said so. `workerTargets.ts` attaches both
 * to the worker targets now, and {@link judgeNativeSqueezeInstrument} is what refuses.
 *
 * ⛔ Those two checks are ONE SIDED and the report says so wherever it prints them. His page
 * publishes no handle a known-size payload could be timed through, so unlike our own client's
 * squeeze this run cannot PROVE its cap landed. It can only rule out the two failures above.
 *
 * @see `docs/bench/in-tab-throttle-probe-result-2026-09-02.md` for the run this is the control for.
 */

import { blindWhileDeliveringRefusal, capExceededRefusal } from './capProof.js';
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
 * the slack for the three windows overrunning their own lengths by a poll each, and for a playhead
 * that keeps moving between the reading and the first sample.
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

/**
 * The wait between weeb-3's page having decodable media and its own player moving a playhead.
 *
 * ⛔⛔ Sampled and carried rather than assumed. His player took 26.1 s to start on 2026-08-16, and a
 * settle window that opened the moment `readyState` reached 2 spent all of that inside its own
 * baseline. The series is kept so a reader can see a playhead that genuinely sat still, rather than
 * having to take the driver's word for how long it waited.
 */
export interface NativeSqueezeStartup {
  /** Wall seconds between the seek and the playhead having advanced past where it landed. */
  startedMovingAfterS: number;
  /** The bound the wait was given, so a fast start reads differently from one that nearly timed out. */
  waitBudgetS: number;
  samples: readonly NativeSqueezeSample[];
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
  startup: NativeSqueezeStartup;
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
  startup: NativeSqueezeStartup,
): NativeSqueezeResult {
  return {
    windows,
    startup,
    before: judgePhase('before', windows.before, samples, traffic),
    during: judgePhase('during', windows.during, samples, traffic),
    after: judgePhase('after', windows.after, samples, traffic),
  };
}

/**
 * Why this run's capped phase is not a reading, or nulls.
 *
 * ## ⛔⛔⛔ Both are ONE SIDED, and that is the honest limit of his page
 *
 * Our own client publishes `retrieveBytes`, so a squeeze there times a known-size payload through
 * the node and gets a two-sided proof: too fast means the cap never landed. weeb-3's own page
 * publishes no such handle and no player handle either, so the strongest readings available are
 * these two, and neither can PROVE the cap landed:
 *
 * - **Over the cap** has no benign explanation, so it refuses. **Under it proves nothing**, because
 *   an idle node and a blind recorder read the same way.
 * - **Media gained with zero inbound** is arithmetically impossible on a sighted instrument, so it
 *   refuses. **Zero media with zero inbound is a starved viewer**, which is a result rather than a
 *   fault, and it is not refused.
 *
 * ⛔ So a run that passes both has not shown its cap landed. What it has shown is that the two
 * failures which voided the readings of 2026-09-02 did not happen again, and the report says exactly
 * that rather than implying more.
 */
export function judgeNativeSqueezeInstrument(result: NativeSqueezeResult): {
  capRefusal: string | null;
  recorderRefusal: string | null;
} {
  const { during, windows } = result;
  const capBytesPerSecond = kbpsAsBytesPerSecond(windows.kbps);

  return {
    capRefusal: capExceededRefusal(
      during.inboundBytes,
      during.window.toMs - during.window.fromMs,
      capBytesPerSecond,
      'the capped phase',
    ),
    recorderRefusal: blindWhileDeliveringRefusal(during.mediaGainedS, during.inboundBytes, 'the capped phase'),
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
 * Why the media ahead of the playhead cannot carry a squeeze run, or null.
 *
 * ⛔ Its own predicate so the driver can refuse before it spends three windows, and so the reason
 * reaching an operator is a sentence rather than a ratio of 0.068 nobody can explain.
 *
 * ⛔⛔ Read at the moment the settle window opens, off `duration - currentTime`, rather than off the
 * recording's length before the seek. Two things happen between those moments that no up-front
 * figure can account for: the seek itself, and however long weeb-3's own player takes to start
 * moving. His page opens a broadcast at its live edge, which on a finished recording is the end of
 * it, so a 600 s recording can have 600 s of media and nothing at all ahead of the playhead.
 *
 * @param mediaAheadS Media seconds between the playhead and the end, or null where none is knowable.
 */
export function shortRecordingRefusal(mediaAheadS: number | null, seconds: SqueezeWindowSeconds): string | null {
  const needed = seconds.settleS + seconds.squeezeS + seconds.recoverS + SQUEEZE_MEDIA_HEADROOM_S;

  if (mediaAheadS === null) {
    return (
      "weeb-3's page reported no finite duration for this broadcast, so there is no way to tell whether " +
      `the ${needed} s a squeeze run consumes exists ahead of the playhead. Squeeze mode is for a ` +
      'FINISHED recording: a live playlist reports an endless duration, and a run against one would ' +
      'measure the live edge while its report said it had measured a recording'
    );
  }

  if (mediaAheadS < needed) {
    return (
      `${mediaAheadS.toFixed(1)} s of media sit ahead of the playhead and a squeeze run needs ${needed} s: ` +
      `${seconds.settleS} s to settle, ${seconds.squeezeS} s capped, ${seconds.recoverS} s to recover and ` +
      `${SQUEEZE_MEDIA_HEADROOM_S} s of headroom. Read where the settle window would have opened, which is ` +
      "after the seek and after weeb-3's own player started moving, so it already accounts for both. A run " +
      'that outlasts its media measures the media running out rather than the delivery of it, and that reads ' +
      'exactly like a delivery failure'
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
  const { startup, windows } = result;
  const cappedForS = (windows.liftedAtMs - windows.appliedAtMs) / MS_PER_SECOND;

  return [
    "## What a cap did to weeb-3's own player: observations, none of them asserted",
    '',
    `The tab's download was capped at **${windows.kbps} kbps** for ${cappedForS.toFixed(1)}s, applied over the ` +
      "page's own debug session from inside this process, so the moment the cap landed and the moment a " +
      'sample was taken come off one clock. Nothing below refuses a run.',
    '',
    `⭐ **His player started moving ${startup.startedMovingAfterS.toFixed(1)}s after media was ready, and the ` +
      `settle window opened then**, not at the earlier moment, out of a ${startup.waitBudgetS.toFixed(0)}s budget. ` +
      'Every row below is therefore a session already in motion, which is the only thing that makes the ' +
      'uncapped one a baseline. A run that opened at the earlier moment read 0.087 uncapped, 0.000 capped ' +
      'and 0.000 after, which was one startup measured three times.',
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
    "⛔⛔ The inbound figures are the tab's WebSocket frames, on the PAGE and on every worker target " +
      'the browser made, which is the only vantage point on a node that publishes no retrieval ' +
      'telemetry. yamux multiplexes many streams onto one socket, so these are bytes and never ' +
      'attempts, and no attempt count is claimed here.',
    '',
    ...instrumentLines(result),
  ];
}

/**
 * What this run can and cannot say about its own cap, in the report rather than in a comment.
 *
 * ⛔⛔⛔ His page runs the node in a SharedWorker exactly as our client does, so until 2026-09-02 the
 * cap was applied to a page session the node's sockets do not belong to and the recorder listened on
 * the same page. The "1.000x under the cap" readings of that day were taken under both faults, and
 * they are void. This section is what stops the next such run being quoted.
 */
function instrumentLines(result: NativeSqueezeResult): string[] {
  const { during, windows } = result;
  const capBytesPerSecond = kbpsAsBytesPerSecond(windows.kbps);
  const { capRefusal, recorderRefusal } = judgeNativeSqueezeInstrument(result);
  const meanLabel =
    during.inboundBytesPerSecondMean === null ? 'no reading' : `${grouped(during.inboundBytesPerSecondMean)} B/s`;

  return [
    '### The instrument, and the limit of what it can prove here',
    '',
    `The ${windows.kbps} kbps cap allows **${grouped(capBytesPerSecond)} B/s**, and the capped phase ` +
      `pulled ${meanLabel} across page and worker targets together.`,
    '',
    `- ${capRefusal === null ? '✅ **nothing crossed the wire faster than the cap allows.**' : `⛔ **${capRefusal}**`}`,
    `- ${
      recorderRefusal === null
        ? '✅ **the recorder was not silent over a phase that delivered media.**'
        : `⛔ **${recorderRefusal}**`
    }`,
    '',
    "⛔⛔⛔ **BOTH ARE ONE SIDED, and passing them is not evidence the cap landed.** weeb-3's own page " +
      'publishes no retrieval handle, so a known-size payload cannot be timed through his node the way ' +
      "our own client's `retrieveBytes` allows. Inbound UNDER a cap proves nothing at all, because an " +
      'idle node and a blind recorder read identically, and zero media beside zero bytes is a starved ' +
      'viewer rather than a fault. What these two rule out is the pair of failures that voided the ' +
      'readings of 2026-09-02: a cap on the wrong target, and a recorder on the wrong target.',
    '',
  ];
}

/** The one line a squeeze run prints as it finishes, which is what an operator reads first. */
export function nativeSqueezeConsoleLine(result: NativeSqueezeResult): string {
  return (
    `realtime ratio ${ratioLabel(result.before.realtimeRatio)} before, ` +
    `${ratioLabel(result.during.realtimeRatio)} capped at ${result.windows.kbps} kbps, ` +
    `${ratioLabel(result.after.realtimeRatio)} after. His player started moving ` +
    `${result.startup.startedMovingAfterS.toFixed(1)}s after media was ready, the settle window opened then`
  );
}

/**
 * The one line about the instrument an operator reads before the ratio line above.
 *
 * ⛔ First, and it says what it cannot prove. A run whose console printed only a ratio is how the
 * readings of 2026-09-02 came to be believed.
 */
export function nativeSqueezeInstrumentLine(result: NativeSqueezeResult): string {
  const { capRefusal, recorderRefusal } = judgeNativeSqueezeInstrument(result);
  const failed = [capRefusal, recorderRefusal].filter((why): why is string => why !== null);

  return failed.length === 0
    ? 'the instrument: ✅ nothing beat the cap and nothing went silent over a phase that delivered ' +
        'media. ⛔ Both checks are ONE SIDED and neither proves the cap landed, because his page ' +
        'publishes no handle a known-size payload could be timed through'
    : `the instrument: ⛔ ${failed.join(' AND ')}`;
}
