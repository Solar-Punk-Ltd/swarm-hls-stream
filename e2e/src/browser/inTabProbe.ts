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
 * H3, accounting exhaustion: every attempt reserves the chunk's price at its peer first, the closest
 * peer is asked first, and a peer whose balance plus reserve would pass its threshold refuses, so
 * hedges piling up under a cap can exhaust the closest peers and leave the node cycling its overdraft
 * list waiting for allowance that refreshes once a second per peer. Predicted, if it dominates, as a
 * capped retrieval that hangs with the link mostly idle and rejects when it answers. Under H1 the
 * link is full while goodput is low, so {@link linkOccupancy} is what tells the two apart, and H1 can
 * cause H3.
 *
 * H0, the instrument: the cap must reach the WebSocket transport as one aggregate budget or none of
 * the capped figures mean anything. {@link h0Check} is that reading, and it is a sentence in the
 * report rather than a gate: a run that voids itself still has to say so in the artifact.
 *
 * ⛔⛔⛔ **H0 NOW DEPENDS ON THE RECORDER FIRST, AND ON 2026-09-02 IT DID NOT.** The check compared an
 * idle mean against the cap and nothing else, so a page-scoped recorder's zero came in under every
 * ceiling and printed as a pass, over a run whose 1.2 MB retrievals had all succeeded and whose every
 * byte column read 0. A zero only means the cap held if the instrument was looking at the sockets the
 * bytes travel over. {@link judgeProbeRecorder} is that reading and `capProof.ts` holds both proofs.
 *
 * ## ⛔ The cap itself became the suspect
 *
 * The owner's correction of 2026-09-02 was that Chrome's `Network.emulateNetworkConditions` is a
 * prime suspect for what the probe found, rather than the node: it is one aggregate budget the
 * browser schedules across every transport itself, and how it divides one across an in-tab node's
 * ~200 WebSockets is not a fact about a link of that speed. So {@link CapSource} rides on every row,
 * every window and the run, an externally shaped run has no uncapped condition inside it at all, and
 * H0 is replaced rather than answered where the cap is a real shaper. See {@link externalCapRefusal}
 * for the one thing this module does refuse.
 *
 * ⛔ Nothing else here asserts. The pre-registration is restated beside what was observed so a
 * reader compares them, and no figure refuses a run.
 *
 * @see `docs/bench/in-tab-throttle-probe-prediction-2026-09-02.md`
 * @see `docs/bench/in-tab-throttle-probe-result-2026-09-02.md`, and its owner's correction.
 */

import { type CapProof, capProofLine, judgeRecorderProof, type RecorderProof, recorderProofLine } from './capProof.js';
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
 * `canary` is the 360p reference every round opens with, unthrottled under an emulated cap and under
 * the cap like everything else where the cap is a real shaper. `pair` is Part C, where two
 * references are started together under the cap because that is the shape a live viewer produced.
 * `proof` is the single capped 360p retrieval taken before Part B runs at all, whose only job is to
 * show that the cap reached the node. It is kept in the record and out of every arm's figures: it is
 * a reading of the instrument rather than of a condition.
 */
export type ProbeArm = RungName | 'canary' | 'pair' | 'proof';

/**
 * How many fresh references the cap proof consumes, once per run rather than per round.
 *
 * ⛔ Counted into the pool before the browser opens, for the reason every other reference is: a run
 * that discovered mid-sitting that it was out of fresh references would either repeat one, which is
 * a cache hit dressed as a retrieval, or abandon the arms it had not reached.
 */
export const CAP_PROOF_REFS = 1;

const CAP_SOURCES = ['cdp', 'external'] as const;

/**
 * What was holding the link down.
 *
 * `cdp` is Chrome's `Network.emulateNetworkConditions`, which is what every capped reading this
 * project has ever taken was made under. `external` is a real `tc` ingress policer on the
 * container's own interface, installed and proved by `deploy/scripts/shape-container-ingress.sh`
 * before the browser opens.
 *
 * ⛔⛔ On every row, every idle window and the run, and not as a footnote. The owner's correction of
 * 2026-09-02 was that the emulation is a prime suspect for what the probe found, so which cap a
 * figure was taken under is part of the figure. A report that did not carry it would be one more
 * artifact whose conditions have to be reconstructed from the command line that produced it.
 */
export type CapSource = (typeof CAP_SOURCES)[number];

/**
 * `PROBE_CAP_MODE` read strictly, and empty read as the emulation.
 *
 * ⛔ A spelling it does not know is refused rather than read as the default. `PROBE_CAP_MODE=extenal`
 * silently falling back to CDP would run the emulated arm, call every row externally capped in the
 * command line the operator remembers giving, and there would be nothing in the artifact to
 * disagree with them.
 */
export function readCapSource(raw: string): CapSource {
  const value = raw.trim();
  if (value === '') {
    return 'cdp';
  }
  if ((CAP_SOURCES as readonly string[]).includes(value)) {
    return value as CapSource;
  }
  throw new Error(
    `PROBE_CAP_MODE must be one of ${CAP_SOURCES.join(', ')} and is ${JSON.stringify(raw)}. Read as ` +
      'the default it would run the emulated cap while the operator believed a real shaper was in place.',
  );
}

/** The cap a row or a window ran under, spelled so the kind of cap is never left to be assumed. */
export function describeCap(kbpsCap: number | null, capSource: CapSource): string {
  if (kbpsCap === null) {
    return 'uncapped';
  }
  return capSource === 'external' ? `external ${kbpsCap} kbps` : `${kbpsCap} kbps`;
}

/**
 * Why an externally capped run must not be labelled with the cap it was told, or null.
 *
 * ⛔⛔ The label and the shaper have to agree. A run given `PROBE_CAP_KBPS=700` while the preflight
 * proved 350,000 bytes/s would stamp "external 700 kbps" on every row of an artifact measured at
 * 2800, and no reader and nothing downstream could ever catch it. The band is the shaper's own, so
 * the two gates cannot drift apart.
 */
export function externalCapRefusal(capKbps: number, measuredBps: number | null): string | null {
  if (measuredBps === null) {
    return (
      'this run says PROBE_CAP_MODE=external and carries no PROBE_EXTERNAL_CAP_MEASURED_BPS, so ' +
      'nothing establishes that a shaper was installed at all, let alone at what rate. ' +
      'deploy/scripts/shape-container-ingress.sh writes it, and bench-on-host.sh --shape-kbps is ' +
      'what runs the shaper before the driver.'
    );
  }
  const allowed = kbpsAsBytesPerSecond(capKbps);
  const floor = allowed * (1 - EXTERNAL_CAP_TOLERANCE_UNDER);
  const ceiling = allowed * (1 + EXTERNAL_CAP_TOLERANCE_OVER);
  if (measuredBps < floor || measuredBps > ceiling) {
    return (
      `this run would label every row "external ${capKbps} kbps", which allows ${grouped(allowed)} ` +
      `bytes/s, and the preflight proved ${grouped(measuredBps)} bytes/s. That disagrees by more than ` +
      `the ${grouped(floor)} to ${grouped(ceiling)} band, so PROBE_CAP_KBPS and --shape-kbps are not ` +
      'the same number and the artifact would name a cap the link was never under.'
    );
  }
  return null;
}

/**
 * How a retrieval ended.
 *
 * `budget` is the harness giving up, never the node. The page-side call keeps running afterwards,
 * which is the point: the bytes it was still pulling land in the tail window.
 */
export type RetrievalOutcome = 'resolved' | 'rejected' | 'budget';

/**
 * One of Part A's windows, in which the node was booted and nothing was requested.
 *
 * Three of them under an emulated cap, which can be lifted between them. One under an external
 * shaper, which cannot.
 */
export interface IdleWindow {
  label: string;
  /** Null for the unthrottled window, which only an emulated run has. */
  kbpsCap: number | null;
  capSource: CapSource;
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
  capSource: CapSource;
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
  /**
   * The second, lower cap Part A holds an idle window at, or null where there is no second cap.
   *
   * Null on an external run and that is the honest type: a `tc` policer is installed once for the
   * life of the container, so there is one cap and one idle window. {@link h0Line} branches on
   * {@link InTabProbeRun.capSource} rather than going looking for a window that cannot exist.
   */
  lowCapKbps: number | null;
  capSource: CapSource;
  /**
   * What the shaper's preflight proved the external cap delivers, in bytes per second, or null.
   *
   * Null on an emulated run, where there is no shaper to have proved anything. On an external run
   * the driver refuses before the browser opens if this is absent or disagrees with `capKbps`. See
   * {@link externalCapRefusal}.
   */
  externalCapMeasuredBps: number | null;
  /** The quiet time after each row's cap lifted, before the next row started. */
  gapMs: number;
  /**
   * What one timed retrieval under the cap said about whether the cap reached the node, or null.
   *
   * ⛔⛔⛔ Null on an externally shaped run, where the shaper's own preflight is the proof and there
   * is no emulation to have missed the transport. On an emulated run it is never null in a published
   * artifact, because the driver refuses before Part B when this comes back negative. The arm 3
   * probe of 2026-09-02 had no such field and no such refusal, and every capped figure in it was a
   * reading of an uncapped link.
   */
  capProof: CapProof | null;
  /**
   * What the recorder counted against what the node is known to have delivered.
   *
   * ⛔⛔ Read this before any byte column below. The same arm 3 report printed **0** in every one of
   * them while 1.2 MB retrievals succeeded, and then read that zero as a healthy idle reading.
   */
  recorderProof: RecorderProof;
  idleWindows: readonly IdleWindow[];
  retrievals: readonly RetrievalRow[];
  /** Part C's pairs, each read as one thing. See {@link summarizePair}. */
  pairs: readonly PairSummary[];
  cost: ResourceCost;
}

/**
 * What a Part C pair did together.
 *
 * ⛔ Two retrievals on one link each count the other's bytes, so a per row ratio for either is a
 * number about both. The pair is read over the union of their windows against the sum of what they
 * returned, and that is the figure Part C is judged on.
 */
export interface PairSummary {
  roundIndex: number;
  startedAtMs: number;
  watchedUntilMs: number;
  inBytes: number;
  /** Null when neither row returned a payload. */
  payloadBytes: number | null;
  amplification: number | null;
  /** Inbound over the union window as a share of what the cap allowed, or null for an uncapped pair. */
  occupancy: number | null;
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
  capSource: CapSource;
  startedAtMs: number;
  endedAtMs: number;
}

/** What the driver watched happen to one retrieval, before any of it is counted. */
interface RetrievalObservation {
  arm: ProbeArm;
  kbpsCap: number | null;
  capSource: CapSource;
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

/**
 * How far a proved external rate may sit from the cap the rows are labelled with.
 *
 * The shaper's own band, so a reading it accepted cannot be refused here and the two gates cannot
 * drift apart. Asymmetric for the shaper's reason: an ingress policer drops rather than queues and
 * TCP answers a drop by backing off, while coming in over the cap has no benign explanation.
 */
const EXTERNAL_CAP_TOLERANCE_UNDER = 0.25;
const EXTERNAL_CAP_TOLERANCE_OVER = 0.15;

/**
 * Where the uncapped comparison for an externally shaped run lives, which is not in the run.
 *
 * ⛔ Said in the artifact rather than left to a reader. An external policer holds for the life of
 * the container, so such a run has no unthrottled idle window and no free arm, and an absence that
 * goes unexplained reads as a measurement that came back empty.
 */
const UNCAPPED_LIVES_ELSEWHERE =
  '⛔ **There is no uncapped condition inside an externally capped run.** The `tc` policer is ' +
  'installed for the life of the container and cannot be lifted for one window or one row, so ' +
  'this run carries one idle window and no free arm. **The uncapped comparison is the CDP run of ' +
  'the same day**, which measured the same client against the same references with the cap applied ' +
  "by Chrome instead. Read the two side by side, and read nothing here as this node's unconstrained " +
  'behaviour.';

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
 * The arms of a Part B round, in the order this round runs them.
 *
 * ⛔ Alternated every round rather than fixed. Sustained retrieval degrades a weeb-3 node after two
 * or three rounds, and both sittings of the concurrency sweep watched it happen, so a fixed order
 * would hand the last arm every round's worst conditions and the report would read that as a
 * property of the arm rather than of when it ran.
 *
 * ⛔ Two arms under an external cap, not four. A `tc` policer is installed once for the life of the
 * container, so there is no free condition to alternate against: a "free" arm would be a capped arm
 * with the wrong label on it. The uncapped comparison is the emulated run, which is a different run.
 *
 * ⭐ Not `counterbalancedOrder`, which is the two-condition rule and rotates every four rounds. This
 * is conditions alternating every round, which is a different rule and gets its own name rather
 * than a second reading of that one.
 */
export function probeArmOrder(roundIndex: number, capSource: CapSource): readonly ProbeStep[] {
  const capped: readonly ProbeStep[] = [
    { arm: '360p', capped: true },
    { arm: '1080p', capped: true },
  ];
  const free: readonly ProbeStep[] = [
    { arm: '360p', capped: false },
    { arm: '1080p', capped: false },
  ];
  const forward = capSource === 'external' ? capped : [...capped, ...free];
  return roundIndex % 2 === 0 ? forward : [...forward].reverse();
}

/**
 * How many fresh references one round of Part B needs, per rung.
 *
 * ⭐ Counted off {@link probeArmOrder} rather than written down beside it. The pool is sized before
 * the browser opens and no reference is fetched twice, so a count that drifted from the arms would
 * either run the pool dry mid-sitting or leave the last arms unrun, and either way the artifact is
 * already half written by the time anyone notices.
 */
export function refsNeededPerRound(capSource: CapSource): Record<RungName, number> {
  const steps = probeArmOrder(0, capSource);
  const perArm = (arm: RungName): number => steps.filter((step) => step.arm === arm).length;
  // The canary is always 360p, and always one more than the arms need.
  return { '360p': 1 + perArm('360p'), '1080p': perArm('1080p') };
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

/** Inbound bytes as a share of what a cap allowed over a stretch, or null where there was no cap. */
function shareOfCap(inBytes: number, kbpsCap: number | null, watchedMs: number): number | null {
  if (kbpsCap === null || watchedMs <= 0) {
    return null;
  }
  return inBytes / (kbpsAsBytesPerSecond(kbpsCap) * (watchedMs / MS_PER_SECOND));
}

/**
 * How full the capped link was while this row ran.
 *
 * ⛔ The reading that separates H1 from H3. Both leave a capped retrieval unanswered for tens of
 * seconds, and they differ in what the link was doing meanwhile: full of hedged chunks under H1,
 * mostly idle under H3 while the node waits on allowance. A budget row is read over the budget, which
 * is how long the harness watched.
 */
export function linkOccupancy(row: RetrievalRow): number | null {
  const watchedUntilMs = row.settledAtMs ?? row.startedAtMs + row.budgetMs;
  return shareOfCap(row.inBytesDuring, row.kbpsCap, watchedUntilMs - row.startedAtMs);
}

export function summarizePair(rows: readonly RetrievalRow[], traffic: WebSocketTraffic): PairSummary {
  const [first] = rows;
  if (first === undefined) {
    throw new Error('a pair summary needs at least one row, and none was handed in');
  }
  const startedAtMs = Math.min(...rows.map((row) => row.startedAtMs));
  const watchedUntilMs = Math.max(...rows.map((row) => row.settledAtMs ?? row.startedAtMs + row.budgetMs));
  const returned = rows.map((row) => row.byteLength).filter((bytes): bytes is number => bytes !== null);
  const payloadBytes = returned.length === 0 ? null : returned.reduce((total, bytes) => total + bytes, 0);
  const inBytes = bytesBetween(traffic.frames, startedAtMs, watchedUntilMs, 'in');

  return {
    roundIndex: first.roundIndex,
    startedAtMs,
    watchedUntilMs,
    inBytes,
    payloadBytes,
    amplification: amplification(inBytes, payloadBytes ?? 0),
    occupancy: shareOfCap(inBytes, first.kbpsCap, watchedUntilMs - startedAtMs),
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
  return summarizeValues(rows.map((row) => row.amplification));
}

/** The spread of {@link linkOccupancy} across rows, over those that ran under a cap. */
function summarizeOccupancy(rows: readonly RetrievalRow[]): AmplificationSummary | null {
  return summarizeValues(rows.map(linkOccupancy));
}

function summarizeValues(values: readonly (number | null)[]): AmplificationSummary | null {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (finite.length === 0) {
    return null;
  }
  return { n: finite.length, min: Math.min(...finite), median: median(finite), max: Math.max(...finite) };
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function describeShare(summary: AmplificationSummary | null): string {
  if (summary === null) {
    return 'no capped row to read';
  }
  return `${percent(summary.min)} / ${percent(summary.median)} / ${percent(summary.max)} (n=${summary.n})`;
}

/**
 * Every retrieval that returned a payload, judged as one reading of the recorder.
 *
 * ⛔⛔ Part B rows only, because their windows never overlap. Part C starts two retrievals together
 * on one link, so each of its rows counts the other's bytes and summing the pair would inflate the
 * inbound side of the comparison and make a blind recorder look sighted.
 *
 * ⭐ The window a row is credited is its own PLUS its tail. The frames are stamped by the harness on
 * receipt and the settle instant comes off the client's own clock, so a chunk that arrived a
 * moment before a retrieval resolved can be stamped just after it. The tail is ten quiet seconds,
 * which is far more slack than that skew, and the payload bytes are inside the union either way.
 */
export function judgeProbeRecorder(rows: readonly RetrievalRow[]): RecorderProof {
  const resolved = rows.filter((row) => row.arm !== 'pair' && row.outcome === 'resolved' && row.byteLength !== null);
  const payloadBytes = resolved.reduce((total, row) => total + (row.byteLength ?? 0), 0);
  const inboundBytes = resolved.reduce((total, row) => total + row.inBytesDuring + (row.inBytesTailAfter ?? 0), 0);

  return judgeRecorderProof(payloadBytes, inboundBytes, resolved.length);
}

/**
 * Whether the cap reached the transport, which every capped figure in the report depends on.
 *
 * ⛔⛔⛔ Chromium applies `Network.emulateNetworkConditions` itself, and whether it reaches a given
 * transport is the browser's business rather than something a harness can assert from outside. If
 * aggregate idle inbound under the low cap exceeds what that cap allows, the cap is per connection
 * or absent, and every capped ratio here is a number about an uncapped link.
 *
 * ⛔⛔⛔ **A ZERO ONLY MEANS THE CAP HELD IF THE RECORDER COULD SEE.** This compared an idle mean
 * against the cap and nothing else until 2026-09-02, and on 2026-09-02 it read a **blind** recorder's
 * zero, found it comfortably under the ceiling, and printed "✅ H0 holds" over a run in which 1.2 MB
 * retrievals had succeeded and every byte column read 0. So the recorder proof comes first, and a
 * run whose recorder was not proved to see reads "instrument blind, run refused" instead of holding.
 *
 * ⛔ A sentence rather than a refusal. A run that voids itself still has to say so in its own
 * artifact, where the reader who would otherwise quote the ratios is standing. What refuses is the
 * driver, off the same proofs.
 */
export function h0Check(idle: IdleWindow, recorder: RecorderProof): string {
  if (recorder.verdict !== 'saw the delivery') {
    return (
      '⛔ **H0 cannot hold: instrument blind, run refused.** ' +
      `${recorderProofLine(recorder)}. An idle reading under a cap is only evidence the cap held if ` +
      'the recorder was attached to the sockets the bytes travel over, and this one was not shown to ' +
      'be. A zero from a blind instrument is what made this line read as a pass on 2026-09-02, over a ' +
      'run whose 1.2 MB retrievals had all succeeded. Nothing below is a reading of anything.'
    );
  }

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
      `✅ **H0 holds.** ${recorderProofLine(recorder)}, and idle inbound under the ${idle.kbpsCap} kbps ` +
      `cap averaged ${observed} bytes/s against the ${grouped(ceiling)} bytes/s that cap allows, so the ` +
      'emulation reaches the WebSocket transport as one aggregate budget and the capped ratios below ' +
      'mean what they say.'
    );
  }

  return (
    `⛔ **H0 fails, and every capped figure in this report is void.** Idle inbound under the ` +
    `${idle.kbpsCap} kbps cap averaged ${observed} bytes/s against the ${grouped(ceiling)} bytes/s that ` +
    'cap allows. The cap is therefore per connection or absent, so nothing below is a reading of a ' +
    'capped link and no hypothesis here has been tested.'
  );
}

/**
 * The H0 line for a run, whichever kind of cap it was under.
 *
 * ⛔⛔ H0 exists because Chromium applies its own emulation and a harness cannot assert from outside
 * that it reached a given transport. A `tc` policer on the container's interface is not that: it
 * sits under every socket the tab opens and the shaper measured what it delivers before the browser
 * opened. So the question does not apply, and the honest line says that and names the proved rate
 * rather than answering a question about the emulation with a reading of a shaper.
 */
function h0Line(run: InTabProbeRun): string {
  if (run.capSource === 'external') {
    if (run.externalCapMeasuredBps === null) {
      return (
        '⛔ **H0 cannot be answered and this run should not exist.** It says its cap was external and ' +
        'carries no preflight reading, so nothing establishes that a shaper was installed at all. The ' +
        'driver refuses this before the browser opens, so an artifact reaching here has bypassed it.'
      );
    }
    return (
      `✅ **H0 does not apply, the cap is a real shaper proved by the preflight at ` +
      `${grouped(run.externalCapMeasuredBps)} B/s.** H0 asks whether Chromium's emulation reached the ` +
      'WebSocket transport, and there is no emulation here: the cap is a `tc` ingress policer on the ' +
      "container's own interface, under every socket the tab opens, and " +
      '`deploy/scripts/shape-container-ingress.sh` measured what it delivers against a real download ' +
      'from the host before this run was allowed to start.'
    );
  }

  const low = idleAt(run, run.lowCapKbps);
  if (low === undefined) {
    return (
      `⛔ **H0 was not checked.** This run recorded no idle window at the ${run.lowCapKbps} kbps cap, so ` +
      'nothing establishes that the cap reached the transport, and no capped figure below can be relied on.'
    );
  }
  return h0Check(low, run.recorderProof);
}

/**
 * The two proofs, above every figure they decide the meaning of.
 *
 * ⛔ First in the report and not a footnote. A reader who quotes a capped ratio without having read
 * these is the reader the arm 3 report of 2026-09-02 produced, and the fault was the report's for
 * putting nothing in their way.
 */
function proofSection(run: InTabProbeRun): string[] {
  const proofRows = run.retrievals.filter((row) => row.arm === 'proof');
  const unproved: CapProof = {
    byteLength: null,
    elapsedMs: null,
    minimumMs: null,
    requiredMs: null,
    capBytesPerSecond: kbpsAsBytesPerSecond(run.capKbps),
    verdict: 'no reading',
  };

  return [
    '## The instrument, proved by effect before anything below it means anything',
    '',
    run.capSource === 'external'
      ? '⛔ **The cap here is a real `tc` policer, so the timed proof does not apply.** The shaper ' +
        'measured what it delivers against a real download from the host before the browser opened, ' +
        'and that reading is the proof. See H0 below.'
      : `- ${capProofLine(run.capProof ?? unproved)}`,
    `- ${recorderProofLine(run.recorderProof)}`,
    '',
    "⛔⛔ Both are readings of OUR HARNESS, not of the node. Since weeb-3 0.0.341001 the node's " +
      'WebSockets belong to a SharedWorker target, so a page-scoped cap reaches nothing it does and a ' +
      'page-scoped recorder counts nothing it moves. The cap proof times a known-size payload through ' +
      'the node against the physical floor at the cap, and the recorder proof compares what the node ' +
      'delivered against what the recorder counted arriving. **A run that fails either is refused by ' +
      'the driver**, and this artifact exists so a refused one still says why.',
    '',
    ...(proofRows.length === 0
      ? []
      : [
          '### The retrieval the cap proof was taken from',
          '',
          ...RETRIEVAL_HEADER,
          ...proofRows.map(retrievalRow),
          '',
        ]),
  ];
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
  const occupancy = linkOccupancy(row);
  return [
    `| ${row.roundIndex}`,
    row.arm,
    describeCap(row.kbpsCap, row.capSource),
    `\`${row.ref.slice(0, 12)}\``,
    `${describeRetrieval(row)}${past20s || row.outcome === 'budget' ? ' ⛔' : ''}`,
    grouped(row.inBytesDuring),
    String(row.outFramesDuring),
    row.inBytesTailAfter === null ? '—' : grouped(row.inBytesTailAfter),
    row.amplification === null ? '—' : row.amplification.toFixed(2),
    `${occupancy === null ? '—' : percent(occupancy)} |`,
  ].join(' | ');
}

const RETRIEVAL_HEADER = [
  '| round | arm | cap | reference | outcome | inbound during | out frames | inbound in the tail | ×payload | of the cap |',
  '| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
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
    // Which cap held the link down leads, because the owner's correction of 2026-09-02 made the
    // emulation itself a suspect. A figure here means something different depending on this line.
    run.capSource === 'external'
      ? `**The cap is a real shaped link, not Chrome's emulation.** A \`tc\` ingress policer at ` +
        `${run.capKbps} kbit/s on the container's own interface, under every socket the tab opens, ` +
        `proved by \`deploy/scripts/shape-container-ingress.sh\` at ` +
        `${run.externalCapMeasuredBps === null ? 'no measured rate' : `${grouped(run.externalCapMeasuredBps)} B/s`} ` +
        'against a real download from the host before the browser opened.'
      : `**The cap is Chrome's \`Network.emulateNetworkConditions\`**, applied over CDP at ` +
        `${run.capKbps} kbit/s. ⚠️ That is one aggregate budget the browser schedules across every ` +
        "transport itself, and how it divides one across an in-tab node's ~200 WebSockets is not a " +
        'fact about a link of that speed. H0 below is what this report can say about it.',
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

  const perWindow = secondsLabel(run.idleWindows[0].endedAtMs - run.idleWindows[0].startedAtMs);
  return [
    '## Part A, idle',
    '',
    run.capSource === 'external'
      ? `The node booted and nothing requested, for ${perWindow} s under the shaped link. This is H2.`
      : `The node booted and nothing requested, for ${perWindow} s per window. This is H2, and the last ` +
        'row is H0.',
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
    ...(run.capSource === 'external' ? [UNCAPPED_LIVES_ELSEWHERE, ''] : []),
  ];
}

function h0Section(run: InTabProbeRun): string[] {
  return ['### H0, the instrument', '', h0Line(run), ''];
}

/** Part B's arms in the order the report reads them, capped first because that is the condition. */
const PART_B_ARMS: readonly RungName[] = ['360p', '1080p'];

function partBSection(run: InTabProbeRun): string[] {
  const clean = run.retrievals.filter((row) => !row.roundDegraded);
  const degraded = run.retrievals.filter((row) => row.roundDegraded && row.arm !== 'proof');
  // ⛔ The proof row is out of this table and out of every ratio in it. It is a reading of whether
  // the cap reached the node, and counting it as an arm would put the instrument's own retrieval in
  // the pre-registration's column.
  const partB = clean.filter((row) => row.arm !== 'pair' && row.arm !== 'proof');

  // No uncapped column under an external cap, because no row could have filled one and a column of
  // dashes reads as a measurement that came back empty.
  const caps: readonly (number | null)[] = run.capSource === 'external' ? [run.capKbps] : [run.capKbps, null];
  const ratios = PART_B_ARMS.flatMap((arm) =>
    caps.map((cap) => {
      const summary = summarizeAmplification(armRows(run, arm, cap).filter((row) => !row.roundDegraded));
      return `| ${arm} | ${describeCap(cap, run.capSource)} | ${describeAmplification(summary)} |`;
    }),
  );

  // ⛔ The canary is unthrottled only where the cap can be lifted for one row. Under an external
  // policer it runs capped like everything else, so a degraded round there means the node could not
  // answer UNDER THE CAP rather than at all, which is a weaker exclusion and has to say so.
  const canaryLine =
    run.capSource === 'external'
      ? 'Every round opens with a 360p canary, which runs **under the same cap as every other row**: ' +
        'the policer cannot be lifted for one retrieval. So a degraded round here means the node ' +
        "could not answer under the cap rather than at all, which excludes less than the CDP run's " +
        'unthrottled canary does.'
      : 'Every round opens with an unthrottled 360p canary.';

  return [
    '## Part B, one fragment at a time',
    '',
    `${canaryLine} The budget is ${secondsLabel(run.budgetMs)} s, and a ` +
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
    `Two fresh 360p references started together under the ${describeCap(run.capKbps, run.capSource)} cap. ` +
      'Sitting five had up to three 360p retrievals overlapping, so this is the shape the viewer actually ' +
      'produced.',
    '',
    ...RETRIEVAL_HEADER,
    ...pairs.map(retrievalRow),
    '',
    "⛔ Two rows on one link each count the other's bytes, so a per row ratio above is a number about " +
      'both. Read each pair together:',
    '',
    ...run.pairs.map(
      (pair) =>
        `- Pair ${pair.roundIndex} together: ${grouped(pair.inBytes)} bytes inbound over ` +
        `${secondsLabel(pair.watchedUntilMs - pair.startedAtMs)} s against ` +
        `${pair.payloadBytes === null ? 'no' : grouped(pair.payloadBytes)} payload bytes, ` +
        `${pair.amplification === null ? 'no ratio' : `×${pair.amplification.toFixed(2)}`}, link at ` +
        `${pair.occupancy === null ? '—' : percent(pair.occupancy)} of the cap.`,
    ),
    '',
  ];
}

function predictionsSection(run: InTabProbeRun): string[] {
  const capped360 = summarizeAmplification(armRows(run, '360p', run.capKbps).filter((row) => !row.roundDegraded));
  const free360 = summarizeAmplification(armRows(run, '360p', null).filter((row) => !row.roundDegraded));
  const idleCapped = idleAt(run, run.capKbps);
  const h2Predicted = kbpsAsBytesPerSecond(run.capKbps) * H2_PREDICTED_IDLE_SHARE;

  const cappedRows = run.retrievals.filter((row) => row.kbpsCap !== null && !row.roundDegraded && row.arm !== 'proof');
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
      `${
        run.capSource === 'external'
          ? 'NOT RUN, see the uncapped comparison in the CDP run of the same day'
          : describeAmplification(free360)
      } |`,
    `| **H2** idle background load | idle inbound at **${grouped(h2Predicted)} bytes/s** or more, which is ` +
      `${(H2_PREDICTED_IDLE_SHARE * 100).toFixed(0)}% of the ${run.capKbps} kbps cap | ` +
      `${idleCapped === undefined ? 'not measured' : `${grouped(idleCapped.inBytesPerSecondMean)} bytes/s`} |`,
    `| **H3** accounting exhaustion | a capped retrieval hangs with the link mostly idle, well under the cap, ` +
      'and rejects when it answers. Under H1 the link is full while goodput is low | ' +
      `${rejected.length} of ${cappedRows.length} capped rows rejected, ` +
      `${rejectedQuickly.length} of them inside ${secondsLabel(HLSJS_ABANDONS_AT_MS)} s. Link at ` +
      `${describeShare(summarizeOccupancy(cappedRows))} of the cap while capped rows ran |`,
    '',
  ];
}

export function renderInTabProbeReport(run: InTabProbeRun): string {
  return [
    ...whatRanSection(run),
    '## Everything below is observations, none of them asserted',
    '',
    'This is a measurement, not a suite. No figure here refuses a run, and a value that hit its budget ' +
      'is reported as not completing rather than as a duration. ⛔ The two INSTRUMENT proofs below are ' +
      'the exception and always were: a cap that cannot prove itself and a recorder that cannot prove ' +
      'it saw are not weak readings, they are false ones, and the driver refuses on both.',
    '',
    ...proofSection(run),
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
