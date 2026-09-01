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

import { fragmentRequestedPattern } from '@swarm-hls-stream/shared';
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

/**
 * Keep every fragment request the page announces, for as long as the page is open.
 *
 * ⛔ Its own console listener rather than a hook into `openViewer`'s. That handler exists to FORWARD
 * the client's voice to the arm's stdout, and these lines must never reach it: they arrive several
 * times a second, every one is distinct, and `reportArmNarration` shows sixty distinct kinds. A flood
 * of them would push everything else the client said out of the arm log. Listening separately also
 * leaves the four other browser drivers untouched.
 *
 * ⭐ Install before navigating, beside `recordRequests`. A listener added afterwards misses whatever
 * the player asked for while the harness was still setting up, and a phase count short at one end is
 * indistinguishable from a player that was quiet.
 *
 * Unbounded on purpose. A squeeze arm is held to six minutes of broadcast by `MAX_ARM_MINUTES`, so
 * this is a few hundred small entries, and a cap that silently dropped lines would corrupt the very
 * counts the run is for.
 */
export function recordFragmentRequests(page: Page, into: FragmentRequest[]): void {
  page.on('console', (message) => {
    const request = readFragmentRequest(message.text(), Date.now());
    if (request !== null) {
      into.push(request);
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

/** What the player asked for either side of a treatment, and whether that can be believed. */
export interface FragmentRequestTimeline {
  before: FragmentRequestPhase;
  during: FragmentRequestPhase;
  after: FragmentRequestPhase;
  /** Every line captured across the whole run, phases included and excluded alike. */
  captured: number;
  state: FragmentLogState;
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
  requests: readonly FragmentRequest[],
  window: TreatmentWindow,
  pictureMoved: boolean,
): FragmentRequestTimeline {
  const state: FragmentLogState = requests.length > 0 ? 'recorded' : pictureMoved ? 'absent' : 'unplayed';

  return {
    before: phaseOf(requests, Number.NEGATIVE_INFINITY, window.appliedAtMs),
    during: phaseOf(requests, window.appliedAtMs, window.liftedAtMs),
    after: phaseOf(requests, window.liftedAtMs, Number.POSITIVE_INFINITY),
    captured: requests.length,
    state,
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
