/**
 * Which level a viewer's player actually asked for, fragment by fragment.
 *
 * ## The question
 *
 * V2 went red three sittings running with one shape: the tab's download is capped, ABR asks for a
 * lower rung within a few seconds, hls.js's own bandwidth estimate collapses, and the player rides the
 * top rung for the whole cap with zero level changes while the picture advances at about half of real
 * time. Fragments are completing, slowly. Nothing in the harness could say WHICH level those fragments
 * belonged to, so two very different faults were indistinguishable: a player that kept requesting the
 * expensive rung despite its own estimate, or a player that requested a cheap rung and was served the
 * expensive one by something upstream.
 *
 * This is the reading that separates them. The client writes one line per fragment request through
 * `clientLog.ts`, the page console carries it, and what is below counts them per squeeze phase.
 *
 * ## The second question, and the second line
 *
 * The first reading this instrument took, on 2026-09-01, answered the first question and raised two
 * more. A capped viewer's stretch held one level-3 request and six level-0 ones, and the artifact had
 * bucketed them into counts, so nobody could say whether that was six fragments or ONE fragment asked
 * for six times. Nothing recorded when any attempt finished either. So the client now writes a second
 * line when an attempt ends, `fragmentSettled`, and both raw lists are carried into the artifact whole
 * rather than only as the buckets. ⛔ An aggregate is a convenience. The list is the evidence.
 *
 * ## ⛔ It records and it refuses nothing
 *
 * Owner ruling of 2026-08-29: an e2e suite checks that a feature works and is stable, never how fast
 * it is. Nothing here is a threshold, a timing or a gate, and no suite may key a refusal to it.
 *
 * ## ⛔⛔ Zero captured is not zero requested
 *
 * A run whose picture moved cannot have requested no fragments, so an empty capture on a moving
 * picture means the DEPLOYED CLIENT does not write the line: an image built before this instrument
 * existed, or a build that dropped it. Reporting that as "the player asked for nothing" would be a
 * wrong answer dressed as a measurement, which is the failure this project has been bitten by most
 * often. {@link judgeFragmentRequests} tells the two apart and {@link fragmentLogVerdict} says which.
 */

import { fragmentRequestedPattern, fragmentSettledPattern } from '@swarm-hls-stream/shared';
import type { Page } from 'playwright-core';

/** One fragment request the page announced, stamped when the harness heard it. */
export interface FragmentRequest {
  /** Wall clock in the harness, on the same clock the throttle window is stamped from. */
  atMs: number;
  /**
   * The level index hls.js named, as written. A word rather than a number where the client could not
   * read one, which is why this is not parsed to a number: see `CLIENT_LOG_UNKNOWN`.
   */
  level: string;
  /** The segment number, as written. Legally the word `initSegment`. */
  sn: string;
  /** The rung's own playlist address, `swarm://<owner>/<topic>`, which is the rung's identity. */
  rung: string;
}

/**
 * One page console line read as a fragment request, or null where it is not one.
 *
 * Matched through the shared pattern rather than a regex written out here, so the client cannot
 * reword the message without this failing to compile against it. See `clientLog.ts`.
 */
export function readFragmentRequest(text: string, atMs: number): FragmentRequest | null {
  const match = fragmentRequestedPattern().exec(text);
  return match === null ? null : { atMs, level: match[1], sn: match[2], rung: match[3] };
}

/** One fragment attempt the page announced the end of, stamped when the harness heard it. */
export interface FragmentSettle {
  /** Wall clock in the harness, on the same clock as {@link FragmentRequest.atMs}. */
  atMs: number;
  /** The level index hls.js named, as written, so it pairs against a request's without conversion. */
  level: string;
  /** The segment number, as written. Legally the word `initSegment`. */
  sn: string;
  /**
   * How the attempt ended, as the client wrote it.
   *
   * ⛔ Kept as the written word and checked against nothing. The client's set is closed and this reader's
   * is not, so a word the client gains reaches the report as itself instead of being dropped by a reader
   * built before it. A settle nobody can classify is still a settle, and losing it would understate the
   * run.
   */
  outcome: string;
  /**
   * What the attempt took, in milliseconds, or null where the client wrote something unreadable.
   *
   * ⛔⛔ Null is not zero. A missing duration leaves the attempt counted and out of the spread, because
   * folding it in as a zero would drag a median toward a number nothing measured.
   */
  elapsedMs: number | null;
}

/**
 * One page console line read as the end of a fragment attempt, or null where it is not one.
 *
 * Matched through the shared pattern for the same reason {@link readFragmentRequest} is. ⚠️ The elapsed
 * is parsed here rather than by the pattern: the pattern accepts any non-space so a clock stepped
 * backwards cannot silence the whole line, which leaves this the place where an unreadable one is named.
 */
export function readFragmentSettle(text: string, atMs: number): FragmentSettle | null {
  const match = fragmentSettledPattern().exec(text);
  if (match === null) {
    return null;
  }
  const elapsedMs = Number(match[4]);
  return {
    atMs,
    level: match[1],
    sn: match[2],
    outcome: match[3],
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
  };
}

/** What one viewer's console said about its fragments: every attempt, and how each one ended. */
export interface FragmentLog {
  requests: FragmentRequest[];
  settles: FragmentSettle[];
}

/**
 * Keep every fragment line the page announces, of either kind, for as long as the page is open.
 *
 * ⛔ Its own console listener rather than a hook into `openViewer`'s. That handler exists to FORWARD
 * the client's voice to the arm's stdout, and these lines must never reach it: they arrive several
 * times a second, every one is distinct, and `reportArmNarration` shows sixty distinct kinds. A flood
 * of them would push everything else the client said out of the arm log. Listening separately also
 * leaves the four other browser drivers untouched.
 *
 * ⭐ One listener for both halves rather than two. The pair is only worth having joined, and a second
 * subscription installed at a different moment would give the two lists different starts.
 *
 * ⭐ Install before navigating, beside `recordRequests`. A listener added afterwards misses whatever
 * the player asked for while the harness was still setting up, and a phase count short at one end is
 * indistinguishable from a player that was quiet.
 *
 * Unbounded on purpose. A squeeze arm is held to six minutes of broadcast by `MAX_ARM_MINUTES`, so
 * this is a few hundred small entries, and a cap that silently dropped lines would corrupt the very
 * counts the run is for.
 */
export function recordFragmentLog(page: Page, into: FragmentLog): void {
  page.on('console', (message) => {
    const heardAtMs = Date.now();
    const text = message.text();

    const request = readFragmentRequest(text, heardAtMs);
    if (request !== null) {
      into.requests.push(request);
      return;
    }

    const settle = readFragmentSettle(text, heardAtMs);
    if (settle !== null) {
      into.settles.push(settle);
    }
  });
}

/** One level the player asked for in a stretch, and how much of that stretch it accounted for. */
export interface LevelRequestCount {
  /** The level index as the client wrote it. */
  level: string;
  requests: number;
  /** Every distinct rung playlist those requests named, in first-seen order. */
  rungs: readonly string[];
}

/** What the player asked for across one stretch of the run. */
export interface FragmentRequestPhase {
  requests: number;
  /** Each distinct level asked for, in the order it was first asked for. */
  levels: readonly LevelRequestCount[];
}

/**
 * Whether the counts below are a reading at all.
 *
 * ⛔ Read this before any number in the timeline. `absent` and a phase of zero requests print the
 * same digits and mean opposite things.
 */
export type FragmentLogState =
  /** Lines were captured, so the counts are what the player asked for. */
  | 'recorded'
  /** None were captured and the picture moved, so the deployed client does not write them. */
  | 'absent'
  /** None were captured and the picture never moved, so the silence says nothing either way. */
  | 'unplayed';

/**
 * Whether the settle half of the instrument is a reading at all.
 *
 * ⛔ Its own state rather than a share of {@link FragmentLogState}. The two lines are written by the
 * same client and can still arrive apart, because one shipped before the other: an artifact whose
 * requests are full and whose settles are empty is a client carrying half the pair, which is a
 * deployment to rebuild rather than a run in which nothing ever finished.
 */
export type FragmentSettleState =
  /** Settle lines were captured, so the outcomes and the durations are what the attempts did. */
  | 'recorded'
  /** Requests were captured and no settle was, so the deployed client writes only the first half. */
  | 'absent'
  /** Neither kind was captured, so this half adds nothing to what {@link FragmentLogState} already says. */
  | 'unheard';

/**
 * The min, median and max of one stretch's attempt durations, over the ones that carried a duration.
 *
 * ⚠️ The client stamps an attempt when hls.js asks for it, which is in front of the request stagger, so
 * at a nonzero `GATEWAY_REQUEST_JITTER_MS` these durations carry the stagger wait as well as the
 * transfer, and at the shipped bound of zero they carry only the transfer.
 */
interface ElapsedSpread {
  minMs: number;
  medianMs: number;
  maxMs: number;
  /** How many attempts the three numbers are over, which is not every attempt in the stretch. */
  samples: number;
}

/** One way attempts ended in a stretch, and how many ended that way. */
interface SettleOutcomeCount {
  /** The outcome as the client wrote it. */
  outcome: string;
  settled: number;
}

/** How the attempts in one stretch of the run ended. ⛔ Observations, every one of them. */
export interface FragmentSettlePhase {
  settled: number;
  /** Each distinct outcome, in the order it was first seen. */
  outcomes: readonly SettleOutcomeCount[];
  /** Null where no attempt in the stretch carried a readable duration, which is not the same as zero. */
  elapsed: ElapsedSpread | null;
  /**
   * How many of these attempts name a level and segment number that some request in the run also named.
   *
   * ⛔ A check on the join, not a finding. Paired against the WHOLE run rather than the stretch, because
   * a fragment asked for just before a cap lands routinely finishes after it. A phase whose settles pair
   * with nothing means the two halves are describing different fragments, and every count beside it
   * should be read as suspect.
   */
  pairedToRequests: number;
}

/** How each attempt ended, either side of the treatment, and whether that can be believed. */
export interface FragmentSettleReading {
  before: FragmentSettlePhase;
  during: FragmentSettlePhase;
  after: FragmentSettlePhase;
  /** Every settle line captured across the whole run, phases included and excluded alike. */
  captured: number;
  state: FragmentSettleState;
  /**
   * Every settle the run heard, in the order it heard them, aggregated away nowhere.
   *
   * The aggregates above cannot say when one particular attempt finished, and a request list without
   * that is half an answer.
   */
  settles: readonly FragmentSettle[];
}

/** What the player asked for either side of a treatment, and whether that can be believed. */
export interface FragmentRequestTimeline {
  before: FragmentRequestPhase;
  during: FragmentRequestPhase;
  after: FragmentRequestPhase;
  /** Every line captured across the whole run, phases included and excluded alike. */
  captured: number;
  state: FragmentLogState;
  /**
   * Every request the run heard, in the order it heard them, aggregated away nowhere.
   *
   * ⛔⛔ **The buckets above cannot separate six fragments from one fragment asked for six times**, and
   * on 2026-09-01 that was exactly the question a squeeze arm left open. The segment numbers here answer
   * it. ⚠️ Null ONLY when read back out of an artifact written before this list existed: every driver
   * writes an array, an empty one included, so a null is an old file rather than a quiet run.
   */
  requests: readonly FragmentRequest[] | null;
  /**
   * How the attempts ended. ⚠️ Null on the same terms as {@link requests}, and for the same reason: the
   * artifact predates the reading rather than the run lacking one.
   */
  settled: FragmentSettleReading | null;
}

/**
 * When a treatment was applied and when it was lifted, on the clock that applied it.
 *
 * Not exported: every caller passes either an object literal or a `ThrottleWindow`, which is
 * structurally this. Naming it here rather than importing keeps this module free of the quality
 * verdict, since a rung outage is the same question asked about a different treatment.
 */
interface TreatmentWindow {
  appliedAtMs: number;
  liftedAtMs: number;
}

function phaseOf(requests: readonly FragmentRequest[], from: number, to: number): FragmentRequestPhase {
  const within = requests.filter((request) => request.atMs >= from && request.atMs < to);
  const byLevel = new Map<string, { requests: number; rungs: string[] }>();

  for (const request of within) {
    const counted = byLevel.get(request.level) ?? { requests: 0, rungs: [] };
    counted.requests += 1;
    if (!counted.rungs.includes(request.rung)) {
      counted.rungs.push(request.rung);
    }
    byLevel.set(request.level, counted);
  }

  return {
    requests: within.length,
    levels: [...byLevel].map(([level, counted]) => ({ level, requests: counted.requests, rungs: counted.rungs })),
  };
}

/**
 * What the player asked for before, during and after a treatment.
 *
 * ⛔ `pictureMoved` is what makes an empty capture legible, and it is a parameter rather than
 * something derived here because only the caller holds the samples. Pass the run's overall advance
 * ratio being above zero. Getting it wrong in the false direction turns a client with no instrument
 * into a "run that played nothing", which is the reading this whole module exists to prevent.
 *
 * Split on the request's own instant, unlike the sample phases in `session.ts`, which split on the
 * interval between two samples because an advance describes a gap. A fragment request is a point.
 */
export function judgeFragmentRequests(
  log: FragmentLog,
  window: TreatmentWindow,
  pictureMoved: boolean,
): FragmentRequestTimeline {
  const { requests } = log;
  const state: FragmentLogState = requests.length > 0 ? 'recorded' : pictureMoved ? 'absent' : 'unplayed';

  return {
    before: phaseOf(requests, Number.NEGATIVE_INFINITY, window.appliedAtMs),
    during: phaseOf(requests, window.appliedAtMs, window.liftedAtMs),
    after: phaseOf(requests, window.liftedAtMs, Number.POSITIVE_INFINITY),
    captured: requests.length,
    state,
    requests: [...requests],
    settled: judgeFragmentSettles(log, window),
  };
}

/** Every level and segment number the run asked for, as the join key a settle carries. */
function askedAddresses(requests: readonly FragmentRequest[]): Set<string> {
  return new Set(requests.map((request) => `${request.level} ${request.sn}`));
}

function settlePhaseOf(
  settles: readonly FragmentSettle[],
  asked: ReadonlySet<string>,
  from: number,
  to: number,
): FragmentSettlePhase {
  const within = settles.filter((settle) => settle.atMs >= from && settle.atMs < to);
  const byOutcome = new Map<string, number>();

  for (const settle of within) {
    byOutcome.set(settle.outcome, (byOutcome.get(settle.outcome) ?? 0) + 1);
  }

  return {
    settled: within.length,
    outcomes: [...byOutcome].map(([outcome, settled]) => ({ outcome, settled })),
    elapsed: spreadOf(within.map((settle) => settle.elapsedMs).filter((ms): ms is number => ms !== null)),
    pairedToRequests: within.filter((settle) => asked.has(`${settle.level} ${settle.sn}`)).length,
  };
}

/**
 * ⛔ Null rather than three zeroes when nothing carried a duration. A spread of zeroes reads as a run of
 * instant retrievals, which is the most flattering possible misreading of no data at all.
 */
function spreadOf(durations: readonly number[]): ElapsedSpread | null {
  if (durations.length === 0) {
    return null;
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return {
    minMs: sorted[0],
    medianMs: sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle],
    maxMs: sorted[sorted.length - 1],
    samples: sorted.length,
  };
}

/**
 * How the attempts ended, phase by phase.
 *
 * ⛔ The state is decided against the REQUESTS, not against the picture. A run that heard requests and
 * no settle is a client writing half the pair, and it is the one silence a reader of this half must
 * never print as "nothing finished".
 */
function judgeFragmentSettles(log: FragmentLog, window: TreatmentWindow): FragmentSettleReading {
  const { requests, settles } = log;
  const state: FragmentSettleState = settles.length > 0 ? 'recorded' : requests.length > 0 ? 'absent' : 'unheard';
  const asked = askedAddresses(requests);

  return {
    before: settlePhaseOf(settles, asked, Number.NEGATIVE_INFINITY, window.appliedAtMs),
    during: settlePhaseOf(settles, asked, window.appliedAtMs, window.liftedAtMs),
    after: settlePhaseOf(settles, asked, window.liftedAtMs, Number.POSITIVE_INFINITY),
    captured: settles.length,
    state,
    settles: [...settles],
  };
}

/**
 * The sentence that has to be read before any count in the timeline.
 *
 * ⛔ The `absent` wording names the CLIENT rather than the player, because that is the difference
 * between a deployment to rebuild and a defect to chase.
 */
export function fragmentLogVerdict(timeline: FragmentRequestTimeline): string {
  if (timeline.state === 'absent') {
    return (
      'instrument absent from the deployed client: the picture moved and not one fragment request line ' +
      'was captured, so this run cannot say which level was asked for. The client this arm watched was ' +
      'built before the instrument existed, or is not writing it'
    );
  }
  if (timeline.state === 'unplayed') {
    return (
      'no fragment request line was captured and the picture never moved, so the silence says nothing ' +
      'either way about the instrument or about the player'
    );
  }
  return `${timeline.captured} fragment request(s) recorded`;
}

/** One phase as a reader sees it: each level asked for, with how many fragments went to it. */
export function describeLevelRequests(phase: FragmentRequestPhase): string {
  if (phase.levels.length === 0) {
    return 'none';
  }
  return phase.levels.map((level) => `level ${level.level} x${level.requests}`).join(', ');
}

/**
 * The sentence that has to be read before any outcome or duration below it.
 *
 * ⛔ The `absent` wording names the CLIENT and says which half it is missing, because a client writing
 * requests and no settles is a build to redeploy rather than a player whose fragments never finished.
 */
export function fragmentSettleVerdict(settled: FragmentSettleReading | null): string {
  if (settled === null) {
    return (
      'how the attempts ended is not in this artifact at all: it was written before the settle line ' +
      'existed, so this run can say what was asked for and not what came of it'
    );
  }
  if (settled.state === 'absent') {
    return (
      'settle instrument absent from the deployed client: fragment requests were captured and not one ' +
      'line saying how an attempt ended, so the client this arm watched writes the first half of the ' +
      'pair and not the second. It was built before the settle line existed, or is not writing it'
    );
  }
  if (settled.state === 'unheard') {
    return (
      'no line of either kind was captured, so nothing here says anything about how attempts ended. ' +
      'Read the fragment request verdict, which is where that silence is explained'
    );
  }
  return `${settled.captured} settled attempt(s) recorded`;
}

/** One phase as a reader sees it: each way an attempt ended, with how many ended that way. */
export function describeSettleOutcomes(phase: FragmentSettlePhase): string {
  if (phase.outcomes.length === 0) {
    return 'none';
  }
  return phase.outcomes.map((outcome) => `${outcome.outcome} x${outcome.settled}`).join(', ');
}

/**
 * One phase's durations as a reader sees them.
 *
 * ⛔ Says how many attempts the three numbers cover, because a spread over two attempts and a spread
 * over two hundred print identically and mean very different things.
 */
export function describeElapsed(phase: FragmentSettlePhase): string {
  const { elapsed } = phase;
  if (elapsed === null) {
    return 'no attempt carried a duration';
  }
  return `${elapsed.minMs} / ${elapsed.medianMs} / ${elapsed.maxMs} ms over ${elapsed.samples}`;
}
