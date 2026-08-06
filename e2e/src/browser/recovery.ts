/**
 * What a viewer experienced across a fault, read off the samples taken while it happened.
 *
 * ## The four questions, and why they are four rather than one
 *
 * "Did it recover" is not one question, and answering it as one is how a scenario passes while the
 * viewer's experience is bad:
 *
 * 1. **Did the picture stop, and for how long.** Some faults should be invisible. A viewer holds
 *    `LIVE_SYNC_DURATION_S` seconds of runway, so an outage shorter than that ought to cost them
 *    nothing at all.
 * 2. **Did it start again by itself.** Without a reload and without the viewer doing anything. A
 *    stream that needs a refresh has not recovered, it has been restarted by hand.
 * 3. **How long after the fault was lifted.** A gateway that came back twenty seconds ago and a
 *    picture still frozen is a different defect from one that never comes back, and both read as
 *    "recovered: false" if the run is short enough.
 * 4. **What the viewer was told while it was stopped.** A frozen frame that says why is a viewer who
 *    waits. A frozen frame that still claims to be live is a viewer who reloads, or leaves. This is
 *    the whole reason `FeedStateOverlay` exists in the client and nothing had ever watched it render.
 *
 * The phases are cut on the harness's own clock, which is the same clock that issued the `docker`
 * command, so the fault's time and the sample's time need no reconciling.
 */

import { type PlaybackAdvance, playbackAdvances, STALLED_ADVANCE_RATIO, type ViewerSample } from './session.js';

/** When the fault was applied and when it was lifted, on the clock that applied it. */
export interface FaultWindow {
  injectedAtMs: number;
  /**
   * When docker was asked to bring the container back, and returned.
   *
   * For a `restart` this is when docker was asked, since it brings the container back itself and
   * there is no separate moment to record.
   */
  liftedAtMs: number;
  /**
   * When the service itself answered again, which is later and is the moment recovery is judged from.
   *
   * ⚠️ **These two are not close together and reading them as one made every recovery figure this
   * project holds too large.** `docker start` returns when the container exists, not when the process
   * inside it works: on 2026-08-06 the bee gateway returned from `docker start` at t+79.1s, answered
   * its first request with a 503 at t+80.3s and did not serve a 200 until **t+86.3s, 7.2 seconds
   * later**. A viewer cannot recover before that, so charging those seconds to the client set a
   * target no client change could ever reach.
   *
   * Null when the readiness of the service could not be established, in which case
   * {@link liftedAtMs} is used and the report says the figure includes startup.
   */
  servingAtMs: number | null;
}

/** Media seconds per wall second over one stretch of a run, with the wall time it covers. */
export interface PhaseAdvance {
  ratio: number;
  wallMs: number;
  samples: number;
}

export interface RecoveryVerdict {
  before: PhaseAdvance;
  during: PhaseAdvance;
  after: PhaseAdvance;
  /** The longest unbroken stretch the picture did not move, anywhere in the run. */
  longestFreezeMs: number;
  /** Wall time from the fault being applied to the picture stopping. Null when it never stopped. */
  freezeStartedAfterFaultMs: number | null;
  /**
   * Wall time from the service **answering again** to the picture moving again.
   *
   * This is the figure a client change can move, and the only one worth setting a target against.
   * Measured from {@link FaultWindow.servingAtMs} rather than from `docker start` returning, which
   * is up to seven seconds earlier and belongs to the service rather than to the viewer.
   *
   * Negative when playback resumed before the service came back, which is not an anomaly: a viewer
   * whose buffer outlasted the outage never depended on it.
   */
  recoveredAfterLiftMs: number | null;
  /** How long the service took to answer after docker returned, which no client change can shorten. */
  serviceStartupMs: number | null;
  /** Whether playback was moving again by the last sample of the run. */
  recovered: boolean;
  /** Everything the client said to the viewer while the picture was stopped, in order, deduplicated. */
  saidWhileFrozen: string[];
  /**
   * Whether the client explained the freeze while it was happening.
   *
   * False with a non-zero {@link longestFreezeMs} is the failure this exists to catch: a stopped
   * picture and an overlay that still says the feed is live.
   */
  explainedTheFreeze: boolean;
  /** Where the player sat before the fault and where it ended up, so a resume in the past is visible. */
  latencyBeforeS: number | null;
  latencyAfterS: number | null;
}

interface Phase {
  samples: ViewerSample[];
  advances: PlaybackAdvance[];
}

/**
 * Split on the interval rather than on the sample.
 *
 * An advance describes the gap between two samples, so the interval that straddles the fault belongs
 * to neither side cleanly. It is assigned to the phase it **ends** in, which is the pessimistic
 * reading: an interval half of which was already faulted counts as faulted. The alternative would
 * report the first frozen interval of every outage as part of the healthy baseline.
 */
function phaseOf(samples: readonly ViewerSample[], from: number, to: number): Phase {
  const advances = playbackAdvances(samples);
  const kept: PlaybackAdvance[] = [];
  const keptSamples: ViewerSample[] = [];

  samples.forEach((sample, i) => {
    if (sample.atMs < from || sample.atMs >= to) {
      return;
    }
    keptSamples.push(sample);
    if (i > 0) {
      kept.push(advances[i - 1]);
    }
  });

  return { samples: keptSamples, advances: kept };
}

function advanceOf(phase: Phase): PhaseAdvance {
  const wallMs = phase.advances.reduce((total, advance) => total + advance.wallMs, 0);
  const mediaMs = phase.advances.reduce((total, advance) => total + advance.ratio * advance.wallMs, 0);
  return { ratio: wallMs > 0 ? mediaMs / wallMs : 0, wallMs, samples: phase.samples.length };
}

/** Was the picture moving between this sample and the one before it? */
function isFrozenAt(samples: readonly ViewerSample[], index: number): boolean {
  if (index === 0) {
    return false;
  }
  const advances = playbackAdvances(samples);
  return advances[index - 1].ratio < STALLED_ADVANCE_RATIO;
}

function longestFreezeMs(samples: readonly ViewerSample[]): number {
  let longest = 0;
  let current = 0;

  playbackAdvances(samples).forEach((advance) => {
    current = advance.ratio < STALLED_ADVANCE_RATIO ? current + advance.wallMs : 0;
    longest = Math.max(longest, current);
  });

  return longest;
}

function lastLatency(samples: readonly ViewerSample[]): number | null {
  const observed = samples.map((sample) => sample.liveLatencyS).filter((value): value is number => value !== null);
  return observed.length > 0 ? observed[observed.length - 1] : null;
}

export function judgeRecovery(samples: readonly ViewerSample[], fault: FaultWindow): RecoveryVerdict {
  // The moment the outage actually ended for a viewer. Falls back to `docker start` returning only
  // when readiness could not be established, and the report says so when it does.
  const servingAtMs = fault.servingAtMs ?? fault.liftedAtMs;

  const before = phaseOf(samples, Number.NEGATIVE_INFINITY, fault.injectedAtMs);
  const during = phaseOf(samples, fault.injectedAtMs, servingAtMs);
  const after = phaseOf(samples, servingAtMs, Number.POSITIVE_INFINITY);

  // The first stalled interval at or after the fault, and the first moving one after that. Indices
  // rather than timestamps while scanning, because "frozen" is a property of the gap between two
  // samples and only one of the two can date it.
  const firstFrozen = samples.findIndex((sample, i) => sample.atMs >= fault.injectedAtMs && isFrozenAt(samples, i));
  const movingAgain = firstFrozen === -1 ? -1 : samples.findIndex((_, i) => i > firstFrozen && !isFrozenAt(samples, i));

  const frozenSamples = samples.filter((_, i) => isFrozenAt(samples, i));
  const saidWhileFrozen = [
    ...new Set(frozenSamples.map((sample) => sample.feedStateMessage).filter((m): m is string => m !== null)),
  ];

  const freeze = longestFreezeMs(samples);
  return {
    before: advanceOf(before),
    during: advanceOf(during),
    after: advanceOf(after),
    longestFreezeMs: freeze,
    freezeStartedAfterFaultMs: firstFrozen === -1 ? null : samples[firstFrozen].atMs - fault.injectedAtMs,
    recoveredAfterLiftMs: movingAgain === -1 ? null : samples[movingAgain].atMs - servingAtMs,
    serviceStartupMs: fault.servingAtMs === null ? null : fault.servingAtMs - fault.liftedAtMs,
    // Judged on the end of the run rather than on `movingAgain`, so a picture that started again and
    // then stopped for good does not read as recovered.
    recovered: samples.length > 1 && !isFrozenAt(samples, samples.length - 1),
    saidWhileFrozen,
    explainedTheFreeze: freeze === 0 || saidWhileFrozen.length > 0,
    latencyBeforeS: lastLatency(before.samples),
    latencyAfterS: lastLatency(after.samples),
  };
}
