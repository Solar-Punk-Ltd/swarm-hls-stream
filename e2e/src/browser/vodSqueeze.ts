/**
 * What a squeezed link did to a recording playing back, in the two readings a rung timeline leaves out.
 *
 * ## The question
 *
 * A live viewer under a cap has two things going wrong at once: the link cannot carry the rung, and
 * the broadcast keeps moving away from them. A recording removes the second. There is no edge to fall
 * behind, every byte the player wants already exists, and a picture that still stops under the cap
 * stopped because of the byte source rather than because it ran out of runway.
 *
 * That makes a squeezed recording the control for a squeezed live watch, and it is the reading this
 * project was missing: the in-tab node's raw retrievals under a cap were measured on 2026-09-02, and
 * our own PLAYER under the same cap was not.
 *
 * ## What is here and what is not
 *
 * The rung timeline in `qualitySwitch.ts` already carries which rung the player chose per stretch and
 * how fast the picture moved. This adds the two things it has no field for: how many of a stretch's
 * intervals had a stopped picture, and how many bytes the tab's own sockets pulled across it. The
 * second is the only vantage point on an in-tab node's traffic, for the reason `webSocketTraffic.ts`
 * gives, and the sums come from that module's pure functions rather than from a second copy here.
 *
 * ## ⛔ It records and it refuses nothing ABOUT THE PRODUCT
 *
 * Owner ruling of 2026-08-29: an e2e suite checks that a feature works and stays stable, never how
 * fast it is. No ratio, no byte count and no stall count below is a threshold, and no suite may key a
 * refusal to one.
 *
 * ⛔⛔⛔ **The two INSTRUMENT proofs are the exception, and they are not about the product at all.**
 * Since weeb-3 0.0.341001 the node runs in a SharedWorker, so the page-scoped cap this driver used
 * reached nothing the node does and the page-scoped recorder counted nothing it moved. Every ratio
 * under an unapplied cap is a reading of a fast unconstrained link with a cap written beside it, and
 * that is not a weak reading but a false one. {@link judgeVodRecorder} and `capProof.ts` are the
 * refusals, and neither is a timing.
 */

import { type CapProof, capProofLine, judgeRecorderProof, type RecorderProof, recorderProofLine } from './capProof.js';
import { type RungTimeline, type ThrottleWindow } from './qualitySwitch.js';
import { phaseOf, STALLED_ADVANCE_RATIO, type ViewerSample } from './session.js';
import { bytesBetween, type WebSocketTraffic } from './webSocketTraffic.js';

/** The direction an in-tab node's segment bytes arrive in. Its own uploads are a different question. */
const INBOUND = 'in';

/**
 * One stretch of a squeezed playback, in the readings the rung timeline does not carry.
 *
 * Not exported: it is reachable as `VodSqueezeReading['during']` for anyone who needs to name it, and
 * an exported name with no importer is what the repo's unused-export ratchet exists to catch.
 */
interface VodSqueezePhase {
  /**
   * Intervals between samples in this stretch, which is what {@link stalledSamples} is out of.
   *
   * ⛔ Fewer than the stretch's samples by one at the start of a run, because an advance describes
   * the gap between two samples and the first sample opens no gap.
   */
  sampledIntervals: number;
  /** Intervals where playback gained less than {@link STALLED_ADVANCE_RATIO} of wall clock. */
  stalledSamples: number;
  /** Bytes the tab received over its WebSockets across this stretch. */
  webSocketInBytes: number;
}

/**
 * What each stretch of a squeezed recording cost the picture and pulled over the wire.
 *
 * Not exported for the reason {@link VodSqueezePhase} is not: it is reachable as
 * `VodSqueezeReport['phases']`, and every exported name is a promise something may import it.
 */
interface VodSqueezeReading {
  before: VodSqueezePhase;
  during: VodSqueezePhase;
  after: VodSqueezePhase;
  /**
   * Sockets the tab opened across the whole run.
   *
   * ⛔⛔ Read it beside a zero byte count. Zero bytes over no socket is a tab with no in-tab node in
   * it, and zero bytes over open sockets is a node that was quiet. Those are opposite findings about
   * a starved viewer and they print the same zero.
   */
  connections: number;
}

/**
 * The instant the recover stretch closes, which is one millisecond past the last sample.
 *
 * The rule `judgeRungTimeline` closes its own `after` stretch on, restated here so the byte sums
 * cover exactly the stretches the advance ratios beside them describe. A frame that arrived while
 * the browser was closing then falls outside every stretch instead of inflating the last one.
 */
function watchedUntil(samples: readonly ViewerSample[], window: ThrottleWindow): number {
  return samples.length === 0 ? window.liftedAtMs : samples[samples.length - 1].atMs + 1;
}

function squeezePhase(
  samples: readonly ViewerSample[],
  traffic: WebSocketTraffic,
  from: number,
  to: number,
): VodSqueezePhase {
  const { advances } = phaseOf(samples, from, to);

  return {
    sampledIntervals: advances.length,
    stalledSamples: advances.filter((advance) => advance.ratio < STALLED_ADVANCE_RATIO).length,
    webSocketInBytes: bytesBetween(traffic.frames, from, to, INBOUND),
  };
}

export function judgeVodSqueeze(
  samples: readonly ViewerSample[],
  traffic: WebSocketTraffic,
  window: ThrottleWindow,
): VodSqueezeReading {
  const end = watchedUntil(samples, window);

  return {
    // The stretch before the cap opens at the run's first frame rather than at a wall clock, which is
    // what `Number.NEGATIVE_INFINITY` means to both `phaseOf` and `bytesBetween`.
    before: squeezePhase(samples, traffic, Number.NEGATIVE_INFINITY, window.appliedAtMs),
    during: squeezePhase(samples, traffic, window.appliedAtMs, window.liftedAtMs),
    after: squeezePhase(samples, traffic, window.liftedAtMs, end),
    connections: traffic.connections.length,
  };
}

/**
 * Whether the recorder saw the delivery the cap proof is known to have pulled.
 *
 * ⛔⛔ Only a weeb3 arm has an in-tab node, so only a weeb3 arm has WebSocket bytes to have counted.
 * On a gateway arm the segment bytes come over the page's own HTTP and a zero here is CORRECT, so
 * the driver reads the verdict and refuses on nothing. Handing this a gateway arm's numbers would
 * refuse a run for the absence of a node it never had.
 *
 * @param inboundBytes What the recorder counted over the proof retrieval's own window, tail included.
 *   ⛔ The proof's window rather than the whole capped phase, so the comparison is exact: the phase
 *   also carries whatever the player was fetching, which would pad the inbound side and let a
 *   partly blind recorder pass.
 */
export function judgeVodRecorder(capProof: CapProof, inboundBytes: number): RecorderProof {
  const payloadBytes = capProof.byteLength ?? 0;
  return judgeRecorderProof(payloadBytes, inboundBytes, payloadBytes > 0 ? 1 : 0);
}

/**
 * What a squeeze report is rendered from.
 *
 * The rung timeline and these phases are separate readings of one stretch, so they are passed
 * together rather than merged: the timeline is shared with the live squeeze arm and must keep meaning
 * there exactly what it means here.
 */
export interface VodSqueezeReport {
  throttle: ThrottleWindow;
  /** ⛔ `RungTimeline` rather than the full verdict, so this asks for only the fields it reads. */
  quality: RungTimeline;
  phases: VodSqueezeReading;
  /**
   * One retrieval under the cap, timed against the physical floor at that cap.
   *
   * ⛔⛔⛔ Through the in-tab node on a weeb3 arm and through a plain segment fetch on a gateway one,
   * because the proof has to travel the path the segment bytes travel. A page-scoped cap has reached
   * nothing the node does since weeb-3 0.0.341001, and the "1.000x under the cap" readings of
   * 2026-09-02 were taken with no such proof at all.
   */
  capProof: CapProof;
  /** ⛔ Meaningful on a weeb3 arm only. See {@link judgeVodRecorder}. */
  recorderProof: RecorderProof;
  /** Whether the segment bytes came from the in-tab node, which decides what the proofs can say. */
  throughTheNode: boolean;
}

const stalls = (phase: VodSqueezePhase): string => `${phase.stalledSamples} of ${phase.sampledIntervals}`;

/** The stretch names, once, so the table and the printed line cannot drift apart. */
const BEFORE = 'before the cap';
const DURING = 'while capped';
const AFTER = 'after the cap lifted';

/** How long the cap was on, in seconds, which the report states rather than the reader deriving it. */
const cappedForS = (throttle: ThrottleWindow): string =>
  ((throttle.liftedAtMs - throttle.appliedAtMs) / 1000).toFixed(1);

export function vodSqueezeSection(report: VodSqueezeReport): string[] {
  const { quality, phases, throttle } = report;
  const row = (named: string, ratio: number, phase: VodSqueezePhase): string =>
    `| ${named} | ${ratio.toFixed(3)} | ${stalls(phase)} | ${phase.webSocketInBytes.toLocaleString()} |`;

  return [
    '## What the cap did to a recording playing back',
    '',
    `The tab's download was capped at **${throttle.kbps} kbps** for ${cappedForS(throttle)}s, part way ` +
      'through a finished recording rather than a live broadcast. Nothing here is a live edge to fall ' +
      'behind, and every byte the player wanted already existed, so a picture that stopped under the ' +
      'cap stopped on the byte source rather than on running out of runway.',
    '',
    '### The instrument, proved by effect',
    '',
    `- ${capProofLine(report.capProof)}, timed through ` +
      `${report.throughTheNode ? "the client's own in-tab retrieval path" : 'a plain fetch of a segment'}`,
    `- ${
      report.throughTheNode
        ? recorderProofLine(report.recorderProof)
        : '✅ **the recorder is not the instrument on a gateway arm**: the segment bytes come over the ' +
          "page's own HTTP, so there is no in-tab node for the WebSocket recorder to have counted and " +
          'a zero in the byte column below is correct rather than blind'
    }`,
    '',
    "⛔⛔ Both are readings of OUR HARNESS. Since weeb-3 0.0.341001 the node's WebSockets belong to a " +
      'SharedWorker target, so a page-scoped cap reaches nothing it does and a page-scoped recorder ' +
      'counts nothing it moves, and the squeeze readings of 2026-09-02 were taken under exactly that. ' +
      '**A run that fails either proof is refused by the driver.**',
    '',
    '| | media seconds per wall second | stalled intervals | WebSocket bytes in |',
    '| --- | ---: | ---: | ---: |',
    row(BEFORE, quality.before.advance.ratio, phases.before),
    row(DURING, quality.during.advance.ratio, phases.during),
    row(AFTER, quality.after.advance.ratio, phases.after),
    '',
    `The tab opened **${phases.connections} WebSocket(s)** across the run. ⛔ Read that beside the byte ` +
      'column: zero bytes over no socket is a tab with no in-tab node in it, and zero bytes over open ' +
      'sockets is a node that was quiet, which are opposite findings printed as one zero.',
    '',
    '⛔ Observations, none of them asserted, and no rate above is held against a ceiling. Owner ruling of',
    '2026-08-29: an e2e suite checks that the feature works and is stable, never how fast it is.',
    '',
  ];
}

/**
 * The three advance ratios as the driver prints them.
 *
 * ⛔ Under a heading that says so, because a rate printed on its own reads as a threshold that was
 * met. The heading is the whole point of the line.
 */
export function vodSqueezeObservations(report: VodSqueezeReport): string[] {
  const { quality } = report;

  return [
    // ⛔ The proofs first and above the heading that says nothing below them is asserted, because
    // they are the exception: an unproved cap makes every ratio under it a reading of a fast link.
    `the instrument: ${capProofLine(report.capProof)}`,
    ...(report.throughTheNode ? [`the instrument: ${recorderProofLine(report.recorderProof)}`] : []),
    'observations, none of them asserted',
    `  the picture advanced ${quality.before.advance.ratio.toFixed(3)}x ${BEFORE}, ` +
      `${quality.during.advance.ratio.toFixed(3)}x ${DURING}, and ` +
      `${quality.after.advance.ratio.toFixed(3)}x ${AFTER}`,
  ];
}
