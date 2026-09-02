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
 * ## The third question, and the third line
 *
 * A settle of `aborted` covers two very different things on the in-tab path. `retrieveBytes` takes no
 * abort signal, so a fragment hls.js walked away from keeps costing the node until it answers, and that
 * answer is stamped `aborted` whether the bytes arrived far too late or never arrived at all. Under a
 * cap those are opposite findings: a retrieval that was merely slow against one that was never going to
 * finish, which is the bit V2 still needs. So the client writes a third line where that happens, and
 * {@link judgeAbandonedAnswers} counts it. ⛔ It is written BESIDE the settle rather than instead of it,
 * so the pairing above and every artifact already on disk read exactly as they did.
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

import {
  FRAGMENT_ANSWER_REJECTED,
  FRAGMENT_ANSWER_RESOLVED,
  fragmentAbandonedAnsweredPattern,
  fragmentRequestedPattern,
  fragmentSettledPattern,
} from '@swarm-hls-stream/shared';
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
  return {
    atMs,
    level: match[1],
    sn: match[2],
    outcome: match[3],
    elapsedMs: finiteOrNull(match[4]),
  };
}

/**
 * One in-tab retrieval that answered a player which had already walked away, as the harness heard it.
 *
 * ⭐ The reading a settle of `aborted` cannot give. On the in-tab path a retrieval takes no abort signal,
 * so an abandoned fragment keeps costing the node until it answers, and that answer reaches the settle
 * line as `aborted` whether the bytes arrived far too late or never arrived at all. Those are opposite
 * findings about a squeezed viewer, and which of the two happened under the cap is V2's open question.
 */
export interface FragmentAbandonedAnswer {
  /** Wall clock in the harness, on the same clock as {@link FragmentRequest.atMs}. */
  atMs: number;
  /** The level index hls.js named, as written, so it pairs against a request's without conversion. */
  level: string;
  /** The segment number, as written. Legally the word `initSegment`. */
  sn: string;
  /**
   * Which way it went, as the client wrote it.
   *
   * ⛔ Kept as the written word and checked against nothing, exactly as {@link FragmentSettle.outcome}
   * is. The client's set is closed and this reader's is not, so a word the client gains reaches the
   * report as itself rather than being dropped by a reader built before it.
   */
  answer: string;
  /**
   * What the node produced, in bytes, or null where the client had no count to write.
   *
   * ⛔⛔ Null is not zero, and here it matters most. A refusal produced nothing, and folding a run of
   * them in as real answers of zero bytes would say the node was answering when it was giving up.
   */
  byteLength: number | null;
  /** What the retrieval took, in milliseconds, or null where the client wrote something unreadable. */
  elapsedMs: number | null;
}

/**
 * One page console line read as a late answer, or null where it is not one.
 *
 * Matched through the shared pattern for the same reason {@link readFragmentRequest} is. ⚠️ Both numbers
 * are parsed here rather than by the pattern, which accepts any non-space so that an unreadable value
 * cannot silence the whole line and take the answer with it.
 */
export function readFragmentAbandonedAnswer(text: string, atMs: number): FragmentAbandonedAnswer | null {
  const match = fragmentAbandonedAnsweredPattern().exec(text);
  if (match === null) {
    return null;
  }

  return {
    atMs,
    level: match[1],
    sn: match[2],
    answer: match[3],
    byteLength: finiteOrNull(match[4]),
    elapsedMs: finiteOrNull(match[5]),
  };
}

function finiteOrNull(written: string): number | null {
  const value = Number(written);
  return Number.isFinite(value) ? value : null;
}

/** What one viewer's console said about its fragments: every attempt, how it ended, and what came late. */
export interface FragmentLog {
  requests: FragmentRequest[];
  settles: FragmentSettle[];
  abandonedAnswers: FragmentAbandonedAnswer[];
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
 * ⭐ One listener for all three kinds rather than one each. They are only worth having joined, and a
 * second subscription installed at a different moment would give the lists different starts.
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
      return;
    }

    const answer = readFragmentAbandonedAnswer(text, heardAtMs);
    if (answer !== null) {
      into.abandonedAnswers.push(answer);
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

/** What the node did in one stretch with attempts nobody was waiting for. ⛔ Observations, all of them. */
export interface FragmentAbandonedAnswerPhase {
  answered: number;
  resolved: number;
  rejected: number;
  /**
   * What the node produced for that work, in bytes.
   *
   * ⛔ Null where no answer in the stretch carried a count, which is not the same as zero. A stretch of
   * refusals produced nothing, and a zero there reads as empty segments the node genuinely served.
   */
  bytes: number | null;
}

/**
 * Whether the late-answer half is a reading at all.
 *
 * ⛔⛔⛔ Two states rather than three, and the silence here means something very different from the
 * silence the other two halves have. A run that heard no request over a moving picture is a client
 * without the instrument. A run that heard no LATE ANSWER is the ordinary case: the gateway path writes
 * none by construction, and an in-tab run that abandoned nothing late writes none either. There is no
 * `absent` because nothing in this reading can tell a client that cannot say from a node with nothing
 * to say.
 */
export type FragmentAbandonedAnswerState =
  /** At least one was heard, so the counts are what the node did after the player walked away. */
  | 'recorded'
  /** None was heard, which is evidence about neither the client nor the node. */
  | 'silent';

/** What became of the abandoned retrievals, either side of the treatment. */
export interface FragmentAbandonedAnswerReading {
  before: FragmentAbandonedAnswerPhase;
  during: FragmentAbandonedAnswerPhase;
  after: FragmentAbandonedAnswerPhase;
  /** Every late answer captured across the whole run, phases included and excluded alike. */
  captured: number;
  state: FragmentAbandonedAnswerState;
  /** Every one the run heard, in the order it heard them, aggregated away nowhere. */
  answers: readonly FragmentAbandonedAnswer[];
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
  /**
   * Which way the retrievals went that answered after the player had walked away. ⚠️ Null on the same
   * terms as {@link settled}: the artifact predates the reading. A run that heard none reads as `silent`
   * rather than as null.
   */
  abandonedAnswers: FragmentAbandonedAnswerReading | null;
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
    abandonedAnswers: judgeAbandonedAnswers(log, window),
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

function abandonedAnswerPhaseOf(
  answers: readonly FragmentAbandonedAnswer[],
  from: number,
  to: number,
): FragmentAbandonedAnswerPhase {
  const within = answers.filter((answer) => answer.atMs >= from && answer.atMs < to);
  const counted = within.map((answer) => answer.byteLength).filter((bytes): bytes is number => bytes !== null);

  return {
    answered: within.length,
    resolved: within.filter((answer) => answer.answer === FRAGMENT_ANSWER_RESOLVED).length,
    rejected: within.filter((answer) => answer.answer === FRAGMENT_ANSWER_REJECTED).length,
    bytes: counted.length === 0 ? null : counted.reduce((total, bytes) => total + bytes, 0),
  };
}

/**
 * What the node did with the retrievals the player had already walked away from, phase by phase.
 *
 * ⛔ The state is decided on this half alone, and it has only two values. A run that heard none of these
 * lines is not a client missing an instrument: the gateway path never writes one, and an in-tab run that
 * abandoned nothing late writes none either. See {@link FragmentAbandonedAnswerState}.
 */
function judgeAbandonedAnswers(log: FragmentLog, window: TreatmentWindow): FragmentAbandonedAnswerReading {
  const { abandonedAnswers } = log;

  return {
    before: abandonedAnswerPhaseOf(abandonedAnswers, Number.NEGATIVE_INFINITY, window.appliedAtMs),
    during: abandonedAnswerPhaseOf(abandonedAnswers, window.appliedAtMs, window.liftedAtMs),
    after: abandonedAnswerPhaseOf(abandonedAnswers, window.liftedAtMs, Number.POSITIVE_INFINITY),
    captured: abandonedAnswers.length,
    state: abandonedAnswers.length > 0 ? 'recorded' : 'silent',
    answers: [...abandonedAnswers],
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

/**
 * One stretch's late answers as a reader sees them.
 *
 * ⛔ An answer word this reader does not know is named rather than dropped, because the total above it
 * counts it and a reader who could not see where the difference went would take the two named counts for
 * the whole of it.
 */
export function describeAbandonedAnswers(phase: FragmentAbandonedAnswerPhase): string {
  if (phase.answered === 0) {
    return 'none';
  }

  const produced = phase.bytes === null ? '' : ` (${phase.bytes} bytes)`;
  const unclassified = phase.answered - phase.resolved - phase.rejected;
  const parts = [`${phase.resolved} resolved${produced}`, `${phase.rejected} rejected`];
  if (unclassified > 0) {
    parts.push(`${unclassified} the reader could not classify`);
  }

  return parts.join(', ');
}

/**
 * What the node did with work nobody was waiting for, over the whole run, as one line.
 *
 * ⛔⛔ The `silent` wording says why the silence proves nothing, and it has to. Every other verdict in
 * this module names a thing to go and fix, so a reader arriving here expects one, and there is none: a
 * gateway arm writes no such line at all, and an in-tab run that abandoned nothing late writes none
 * either.
 */
export function abandonedAnswerVerdict(answers: FragmentAbandonedAnswerReading | null): string {
  if (answers === null) {
    return (
      'whether an abandoned retrieval ever answered is not in this artifact: it was written before that ' +
      'line existed, so this run can say an attempt was aborted and not what became of it'
    );
  }
  if (answers.state === 'silent') {
    return (
      'abandoned attempts the node later answered: none. That is evidence about neither the client nor ' +
      'the node, because the gateway path writes no such line and a run that abandoned nothing late ' +
      'writes none either'
    );
  }

  const whole = abandonedAnswerPhaseOf(answers.answers, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
  return `abandoned attempts the node later answered: ${describeAbandonedAnswers(whole)}`;
}
