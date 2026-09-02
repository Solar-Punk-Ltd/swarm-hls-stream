/**
 * What the in-tab throttle probe collected, judged and rendered.
 *
 * ## The question, in one sentence
 *
 * A viewer whose download is capped at 2800 kbps could not get a 220 KB segment out of the node in
 * its own tab in twenty seconds, on a link that carries one in 0.63 s, and the same node served the
 * next one in 2.5 s the moment the cap lifted. This module holds the arithmetic that says which of
 * three mechanisms did that.
 *
 * ## The three pre-registered hypotheses
 *
 * H1, hedge amplification: every chunk retrieval starts a new attempt to the next peer each second
 * without an answer, up to twenty, and nothing calls the losers off, so a cap that stretches delivery
 * past a second makes the node multiply its own demand. Predicted at 1.0 to 1.3 unthrottled and at
 * least 3.0 capped.
 *
 * H2, idle background load: two hundred peers' hive, pricing and pseudosettle traffic take a
 * material share of the capped link before anything is asked for. Predicted at 30% of the cap or
 * more if it is the cause.
 *
 * H3, accounting refusals: peers refuse reservations and the node cycles its overdraft list.
 * Predicted as capped retrievals rejecting quickly.
 *
 * H0, the instrument: the cap must reach the WebSocket transport as one aggregate budget or none of
 * the capped figures mean anything. {@link h0Check} is that reading, and it is a sentence in the
 * report rather than a gate: a run that voids itself still has to say so in the artifact.
 *
 * ⛔ Nothing here asserts. The pre-registration is restated beside what was observed so a reader
 * compares them, and no figure refuses a run.
 *
 * @see `docs/bench/in-tab-throttle-probe-prediction-2026-09-02.md`
 */

import { costSection, type ResourceCost } from './resources.js';
import { type RungManifest, type RungName } from './rungManifest.js';
import { kbpsAsBytesPerSecond } from './throttle.js';
import {
  amplification,
  bytesBetween,
  type FrameDirection,
  framesBetween,
  openConnectionsAt,
  type PerSecondSample,
  perSecondSeries,
  type WebSocketTraffic,
} from './webSocketTraffic.js';

/**
 * Which part of the probe a retrieval belongs to.
 *
 * `canary` is the unthrottled 360p reference every round opens with, and `pair` is Part C, where two
 * references are started together under the cap because that is the shape a live viewer produced.
 */
export type ProbeArm = RungName | 'canary' | 'pair';

/**
 * How a retrieval ended.
 *
 * `budget` is the harness giving up, never the node. The page-side call keeps running afterwards,
 * which is the point: the bytes it was still pulling land in the tail window.
 */
export type RetrievalOutcome = 'resolved' | 'rejected' | 'budget';

/** One of Part A's three windows, in which the node was booted and nothing was requested. */
export interface IdleWindow {
  label: string;
  /** Null for the unthrottled window. */
  kbpsCap: number | null;
  startedAtMs: number;
  endedAtMs: number;
  perSecond: readonly PerSecondSample[];
  inBytesPerSecondMean: number;
  outBytesPerSecondMean: number;
  connectionsOpenStart: number;
  connectionsOpenEnd: number;
}

/** One retrieval through the client's own in-tab path, with the socket traffic around it. */
export interface RetrievalRow {
  arm: ProbeArm;
  kbpsCap: number | null;
  ref: string;
  startedAtMs: number;
  /** Null on a budget row, because the harness stopped waiting rather than the retrieval settling. */
  settledAtMs: number | null;
  outcome: RetrievalOutcome;
  byteLength: number | null;
  elapsedMs: number | null;
  budgetMs: number;
  inBytesDuring: number;
  outFramesDuring: number;
  /** Inbound bytes in the tail after it settled, or null when it never did. */
  inBytesTailAfter: number | null;
  amplification: number | null;
  roundDegraded: boolean;
  roundIndex: number;
}

export interface InTabProbeRun {
  measuredAt: string;
  clientUrl: string;
  chromeVersion: string;
  owner: string;
  manifests: readonly RungManifest[];
  joinedInMs: number;
  budgetMs: number;
  tailMs: number;
  capKbps: number;
  lowCapKbps: number;
  idleWindows: readonly IdleWindow[];
  retrievals: readonly RetrievalRow[];
  cost: ResourceCost;
}

interface AmplificationSummary {
  n: number;
  min: number;
  median: number;
  max: number;
}

/** One arm of a Part B round: a rung, under the cap or not. */
interface ProbeStep {
  arm: RungName;
  capped: boolean;
}

/** The window bounds a driver hands in, with everything about the traffic still to be counted. */
interface IdleWindowInput {
  label: string;
  kbpsCap: number | null;
  startedAtMs: number;
  endedAtMs: number;
}

/** What the driver watched happen to one retrieval, before any of it is counted. */
interface RetrievalObservation {
  arm: ProbeArm;
  kbpsCap: number | null;
  ref: string;
  roundIndex: number;
  roundDegraded: boolean;
  startedAtMs: number;
  settledAtMs: number | null;
  outcome: RetrievalOutcome;
  byteLength: number | null;
  elapsedMs: number | null;
  budgetMs: number;
  tailMs: number;
}

/**
 * Where hls.js abandons a fragment.
 *
 * Marked in every table because it is what turns a slow retrieval into something a viewer sees. A
 * row past this line is one the player would already have given up on.
 */
const HLSJS_ABANDONS_AT_MS = 20_000;

/** H1's pre-registered floor for a capped 360p retrieval. */
const H1_PREDICTED_AMPLIFICATION = 3.0;

/** H2's pre-registered share of the cap that idle traffic would have to take to be the cause. */
const H2_PREDICTED_IDLE_SHARE = 0.3;

const MS_PER_SECOND = 1_000;

/** Digits grouped without going through a locale, so an artifact reads the same on every machine. */
function grouped(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `90000` reads `90`, `2512` reads `2.5`. A whole number of seconds keeps no decimal point. */
function secondsLabel(ms: number): string {
  const seconds = ms / MS_PER_SECOND;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The four arms of a Part B round, in the order this round runs them.
 *
 * ⛔ Alternated every round rather than fixed. Sustained retrieval degrades a weeb-3 node after two
 * or three rounds, and both sittings of the concurrency sweep watched it happen, so a fixed order
 * would hand the last arm every round's worst conditions and the report would read that as a
 * property of the arm rather than of when it ran.
 *
 * ⭐ Not `counterbalancedOrder`, which is the two-condition rule and rotates every four rounds. This
 * is four conditions alternating every round, which is a different rule and gets its own name rather
 * than a second reading of that one.
 */
export function probeArmOrder(roundIndex: number): readonly ProbeStep[] {
  const forward: readonly ProbeStep[] = [
    { arm: '360p', capped: true },
    { arm: '1080p', capped: true },
    { arm: '360p', capped: false },
    { arm: '1080p', capped: false },
  ];
  return roundIndex % 2 === 0 ? forward : [...forward].reverse();
}

/**
 * One idle window, with every sum taken over the frames the recorder collected.
 *
 * ⛔ The mean divides by the whole window rather than by the seconds something arrived in. H2 asks
 * what share of a capped link the node's background chatter takes, and a mean over only the busy
 * seconds answers a different question with the same units.
 */
export function summarizeIdleWindow(input: IdleWindowInput, traffic: WebSocketTraffic): IdleWindow {
  const seconds = (input.endedAtMs - input.startedAtMs) / MS_PER_SECOND;
  const perSecondMean = (direction: FrameDirection): number =>
    seconds <= 0 ? 0 : bytesBetween(traffic.frames, input.startedAtMs, input.endedAtMs, direction) / seconds;

  return {
    ...input,
    perSecond: perSecondSeries(traffic.frames, input.startedAtMs, input.endedAtMs),
    inBytesPerSecondMean: perSecondMean('in'),
    outBytesPerSecondMean: perSecondMean('out'),
    connectionsOpenStart: openConnectionsAt(traffic.connections, input.startedAtMs),
    connectionsOpenEnd: openConnectionsAt(traffic.connections, input.endedAtMs),
  };
}

/**
 * One retrieval row, with the socket traffic around it counted.
 *
 * ⛔⛔ A row the harness stopped waiting for is measured over the **budget**, which is how long the
 * harness watched, and is given no tail at all. It has no settle to measure a tail from, and the
 * retrieval it abandoned is still running, so any window after the budget would be counting a
 * retrieval that had not finished against one that had.
 */
export function buildRetrievalRow(observation: RetrievalObservation, traffic: WebSocketTraffic): RetrievalRow {
  const { startedAtMs, settledAtMs, budgetMs, tailMs } = observation;
  const watchedUntilMs = settledAtMs ?? startedAtMs + budgetMs;

  return {
    ...observation,
    inBytesDuring: bytesBetween(traffic.frames, startedAtMs, watchedUntilMs, 'in'),
    outFramesDuring: framesBetween(traffic.frames, startedAtMs, watchedUntilMs, 'out'),
    inBytesTailAfter:
      settledAtMs === null ? null : bytesBetween(traffic.frames, settledAtMs, settledAtMs + tailMs, 'in'),
    amplification: amplification(
      bytesBetween(traffic.frames, startedAtMs, watchedUntilMs, 'in'),
      observation.byteLength ?? 0,
    ),
  };
}

/**
 * Whether the round this canary opened can be read.
 *
 * ⛔ The budget is a parameter rather than taken off the row. Both sittings of the concurrency sweep
 * watched a weeb-3 node degrade after two or three rounds of sustained retrieval, one falling from
 * 154 peers to 72 and timing out on references it had served minutes earlier. A round whose
 * unthrottled canary could not land is a round in which the node was already the variable, so its
 * capped rows say nothing about the cap.
 */
export function judgeRoundDegraded(canary: RetrievalRow, budgetMs: number): boolean {
  if (canary.outcome !== 'resolved') {
    return true;
  }
  return canary.elapsedMs === null || canary.elapsedMs > budgetMs;
}

/**
 * One retrieval in words.
 *
 * ⛔⛔ A row that hit the budget has no duration and never gets one. The harness stopped waiting,
 * the page-side call kept running, and printing the budget as an elapsed time would publish a
 * measurement of the harness's own patience as a measurement of the node.
 */
export function describeRetrieval(row: RetrievalRow): string {
  if (row.outcome === 'budget') {
    return `did not complete in ${secondsLabel(row.budgetMs)} s`;
  }
  const elapsed = row.elapsedMs === null ? 'an unrecorded time' : `${secondsLabel(row.elapsedMs)} s`;
  if (row.outcome === 'rejected') {
    return `rejected after ${elapsed}`;
  }
  return `${elapsed}, ${row.byteLength === null ? 'no' : grouped(row.byteLength)} bytes`;
}

/** The spread of inbound bytes per payload byte across rows, over those that carry a ratio. */
export function summarizeAmplification(rows: readonly RetrievalRow[]): AmplificationSummary | null {
  const ratios = rows
    .map((row) => row.amplification)
    .filter((ratio): ratio is number => ratio !== null && Number.isFinite(ratio));

  if (ratios.length === 0) {
    return null;
  }
  return { n: ratios.length, min: Math.min(...ratios), median: median(ratios), max: Math.max(...ratios) };
}

/**
 * Whether the cap reached the transport, which every capped figure in the report depends on.
 *
 * ⛔⛔⛔ Chromium applies `Network.emulateNetworkConditions` itself, and whether it reaches a given
 * transport is the browser's business rather than something a harness can assert from outside. If
 * aggregate idle inbound under the low cap exceeds what that cap allows, the cap is per connection
 * or absent, and every capped ratio here is a number about an uncapped link.
 *
 * ⛔ A sentence rather than a refusal. A run that voids itself still has to say so in its own
 * artifact, where the reader who would otherwise quote the ratios is standing.
 */
export function h0Check(idle: IdleWindow): string {
  if (idle.kbpsCap === null) {
    return (
      '⛔ **H0 could not be checked.** The idle window handed in was not capped, so nothing here says ' +
      'whether a cap reaches the WebSocket transport, and no capped figure below can be relied on.'
    );
  }

  const ceiling = kbpsAsBytesPerSecond(idle.kbpsCap);
  const observed = grouped(idle.inBytesPerSecondMean);

  if (idle.inBytesPerSecondMean <= ceiling) {
    return (
      `✅ **H0 holds.** Idle inbound under the ${idle.kbpsCap} kbps cap averaged ${observed} bytes/s ` +
      `against the ${grouped(ceiling)} bytes/s that cap allows, so the emulation reaches the WebSocket ` +
      'transport as one aggregate budget and the capped ratios below mean what they say.'
    );
  }

  return (
    `⛔ **H0 fails, and every capped figure in this report is void.** Idle inbound under the ` +
    `${idle.kbpsCap} kbps cap averaged ${observed} bytes/s against the ${grouped(ceiling)} bytes/s that ` +
    'cap allows. The cap is therefore per connection or absent, so nothing below is a reading of a ' +
    'capped link and no hypothesis here has been tested.'
  );
}

function idleAt(run: InTabProbeRun, kbpsCap: number | null): IdleWindow | undefined {
  return run.idleWindows.find((window) => window.kbpsCap === kbpsCap);
}

function armRows(run: InTabProbeRun, arm: ProbeArm, kbpsCap: number | null): RetrievalRow[] {
  return run.retrievals.filter((row) => row.arm === arm && row.kbpsCap === kbpsCap);
}

function describeAmplification(summary: AmplificationSummary | null): string {
  if (summary === null) {
    return 'no row returned a payload';
  }
  return `${summary.min.toFixed(2)} / ${summary.median.toFixed(2)} / ${summary.max.toFixed(2)} (n=${summary.n})`;
}

function retrievalRow(row: RetrievalRow): string {
  const past20s = row.elapsedMs !== null && row.elapsedMs > HLSJS_ABANDONS_AT_MS;
  return [
    `| ${row.roundIndex}`,
    row.arm,
    row.kbpsCap === null ? 'uncapped' : `${row.kbpsCap} kbps`,
    `\`${row.ref.slice(0, 12)}\``,
    `${describeRetrieval(row)}${past20s || row.outcome === 'budget' ? ' ⛔' : ''}`,
    grouped(row.inBytesDuring),
    String(row.outFramesDuring),
    row.inBytesTailAfter === null ? '—' : grouped(row.inBytesTailAfter),
    `${row.amplification === null ? '—' : row.amplification.toFixed(2)} |`,
  ].join(' | ');
}

const RETRIEVAL_HEADER = [
  '| round | arm | cap | reference | outcome | inbound during | out frames | inbound in the tail | ×payload |',
  '| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
];

function whatRanSection(run: InTabProbeRun): string[] {
  return [
    '# Why a capped in-tab node delivers nothing: the probe',
    '',
    `**${run.measuredAt}.** ${run.chromeVersion}, headed against an X display on the deployment host, ` +
      `driving the shipped client at \`${run.clientUrl}\`. No broadcast: the node in the tab is booted ` +
      "through the client's own switch and every retrieval goes through the client's own fetch backend, " +
      'so this is the product path rather than a stand-in.',
    '',
    `The node joined the network in ${secondsLabel(run.joinedInMs)} s. Owner \`${run.owner}\`.`,
    '',
    '| rung | topic | segments | `EXT-X-TARGETDURATION` | typical `#EXTINF` |',
    '| --- | --- | ---: | ---: | ---: |',
    ...run.manifests.map(
      (manifest) =>
        `| ${manifest.rung} | \`${manifest.topicHex}\` | ${manifest.segmentCount} | ` +
        `${manifest.targetDurationS ?? '—'} | ` +
        `${manifest.medianSegmentSeconds === null ? '—' : `${manifest.medianSegmentSeconds.toFixed(3)}s`} |`,
    ),
    '',
    '⚠️ Segment **bytes** are not in a manifest and are not read from one. They are the payload each ' +
      'retrieval below returned. What a manifest declares is a duration, and that is what this table ' +
      'carries.',
    '',
    "⚠️ **No reference is fetched twice in this run.** A repeat is answered out of the node's own " +
      'cache in single digit milliseconds and would score as a miracle.',
    '',
  ];
}

function partASection(run: InTabProbeRun): string[] {
  if (run.idleWindows.length === 0) {
    return ['## Part A, idle', '', '⛔ This run recorded no idle window, so H2 and H0 are both unanswered.', ''];
  }

  return [
    '## Part A, idle',
    '',
    `The node booted and nothing requested, for ${secondsLabel(
      run.idleWindows[0].endedAtMs - run.idleWindows[0].startedAtMs,
    )} s ` + 'per window. This is H2, and the last row is H0.',
    '',
    '| window | mean inbound | mean outbound | connections, start → end |',
    '| --- | ---: | ---: | ---: |',
    ...run.idleWindows.map(
      (window) =>
        `| ${window.label} | ${grouped(window.inBytesPerSecondMean)} B/s | ` +
        `${grouped(window.outBytesPerSecondMean)} B/s | ` +
        `${window.connectionsOpenStart} → ${window.connectionsOpenEnd} |`,
    ),
    '',
  ];
}

function h0Section(run: InTabProbeRun): string[] {
  const low = idleAt(run, run.lowCapKbps);
  return [
    '### H0, the instrument',
    '',
    low === undefined
      ? `⛔ **H0 was not checked.** This run recorded no idle window at the ${run.lowCapKbps} kbps cap, so ` +
        'nothing establishes that the cap reached the transport, and no capped figure below can be relied on.'
      : h0Check(low),
    '',
  ];
}

/** Part B's arms in the order the report reads them, capped first because that is the condition. */
const PART_B_ARMS: readonly RungName[] = ['360p', '1080p'];

function partBSection(run: InTabProbeRun): string[] {
  const clean = run.retrievals.filter((row) => !row.roundDegraded);
  const degraded = run.retrievals.filter((row) => row.roundDegraded);
  const partB = clean.filter((row) => row.arm !== 'pair');

  const ratios = PART_B_ARMS.flatMap((arm) =>
    [run.capKbps, null].map((cap) => {
      const summary = summarizeAmplification(armRows(run, arm, cap).filter((row) => !row.roundDegraded));
      return `| ${arm} | ${cap === null ? 'uncapped' : `${cap} kbps`} | ${describeAmplification(summary)} |`;
    }),
  );

  return [
    '## Part B, one fragment at a time',
    '',
    `Every round opens with an unthrottled 360p canary. The budget is ${secondsLabel(run.budgetMs)} s, and a ` +
      'row that hit it is reported as not completing rather than as a duration: the harness stopped ' +
      'waiting, the retrieval did not stop. The tail column is inbound bytes in the ' +
      `${secondsLabel(run.tailMs)} s after a row settled, which is where the late answers land.`,
    '',
    `⛔ A ⛔ in the outcome column is a row past **${secondsLabel(HLSJS_ABANDONS_AT_MS)} s**, which is where ` +
      'hls.js abandons a fragment. A viewer would already have given up on it.',
    '',
    ...RETRIEVAL_HEADER,
    ...partB.map(retrievalRow),
    '',
    '### Inbound bytes per payload byte',
    '',
    '| arm | cap | min / median / max |',
    '| --- | --- | ---: |',
    ...ratios,
    '',
    ...degradedLines(degraded),
  ];
}

function degradedLines(degraded: readonly RetrievalRow[]): string[] {
  if (degraded.length === 0) {
    return ["✅ **Every round's canary landed, so no round was degraded** and no row above was excluded.", ''];
  }
  return [
    `⚠️ **${degraded.length} row(s) come from a degraded round** and are excluded from every ratio above. ` +
      'A round whose unthrottled canary could not land is one in which the node was already the ' +
      'variable, and averaging its capped rows in would blame the cap for that.',
    '',
    ...RETRIEVAL_HEADER,
    ...degraded.map(retrievalRow),
    '',
  ];
}

function partCSection(run: InTabProbeRun): string[] {
  const pairs = run.retrievals.filter((row) => row.arm === 'pair');
  if (pairs.length === 0) {
    return [];
  }
  return [
    '## Part C, two at once',
    '',
    `Two fresh 360p references started together under the ${run.capKbps} kbps cap. Sitting five had up to ` +
      'three 360p retrievals overlapping, so this is the shape the viewer actually produced.',
    '',
    ...RETRIEVAL_HEADER,
    ...pairs.map(retrievalRow),
    '',
  ];
}

function predictionsSection(run: InTabProbeRun): string[] {
  const capped360 = summarizeAmplification(armRows(run, '360p', run.capKbps).filter((row) => !row.roundDegraded));
  const free360 = summarizeAmplification(armRows(run, '360p', null).filter((row) => !row.roundDegraded));
  const idleCapped = idleAt(run, run.capKbps);
  const h2Predicted = kbpsAsBytesPerSecond(run.capKbps) * H2_PREDICTED_IDLE_SHARE;

  const cappedRows = run.retrievals.filter((row) => row.kbpsCap !== null && !row.roundDegraded);
  const rejected = cappedRows.filter((row) => row.outcome === 'rejected');
  const rejectedQuickly = rejected.filter((row) => row.elapsedMs !== null && row.elapsedMs < HLSJS_ABANDONS_AT_MS);

  return [
    '## The pre-registration, against what was observed',
    '',
    'Written before the driver existed and before anything ran, so none of it can have been fitted to ' +
      'the result. `docs/bench/in-tab-throttle-probe-prediction-2026-09-02.md` is the plan.',
    '',
    '| | predicted | observed |',
    '| --- | --- | --- |',
    `| **H1** hedge amplification | capped 360p at **${H1_PREDICTED_AMPLIFICATION.toFixed(1)}** or more, ` +
      `uncapped near 1.0 to 1.3 | capped ${describeAmplification(capped360)}, uncapped ` +
      `${describeAmplification(free360)} |`,
    `| **H2** idle background load | idle inbound at **${grouped(h2Predicted)} bytes/s** or more, which is ` +
      `${(H2_PREDICTED_IDLE_SHARE * 100).toFixed(0)}% of the ${run.capKbps} kbps cap | ` +
      `${idleCapped === undefined ? 'not measured' : `${grouped(idleCapped.inBytesPerSecondMean)} bytes/s`} |`,
    `| **H3** accounting refusals | capped retrievals reject quickly, with few inbound bytes | ` +
      `${rejected.length} of ${cappedRows.length} capped rows rejected, ` +
      `${rejectedQuickly.length} of them inside ${secondsLabel(HLSJS_ABANDONS_AT_MS)} s |`,
    '',
  ];
}

export function renderInTabProbeReport(run: InTabProbeRun): string {
  return [
    ...whatRanSection(run),
    '## Everything below is observations, none of them asserted',
    '',
    'This is a measurement, not a suite. No figure here refuses a run, and a value that hit its budget ' +
      'is reported as not completing rather than as a duration.',
    '',
    ...partASection(run),
    ...h0Section(run),
    ...partBSection(run),
    ...partCSection(run),
    ...predictionsSection(run),
    ...costSection(run.cost),
    '## What this cannot say',
    '',
    '- **Which peers.** The node exposes no per peer view, and yamux frames are not one to one with ' +
      'attempts. Bytes per payload byte is robust to that, and no attempt count is claimed here.',
    '- **Whether a fix works.** That needs the fix.',
    '- **The live edge.** These are VOD references. The retrieval path does not know whether the ' +
      "playlist was live, so the mechanism transfers, but a live viewer's overlapping requests are " +
      'only approximated by Part C.',
    '',
  ].join('\n');
}
