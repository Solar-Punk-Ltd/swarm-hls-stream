import { type Page } from 'playwright-core';

import { judgeRun } from './instrument.js';
import { playbackAdvances, STALLED_ADVANCE_RATIO, summarize, type ViewerSample } from './session.js';
import { type SampledStretch } from './watchLoop.js';

/**
 * Where the player publishes itself when built with `VITE_EXPOSE_PLAYER`.
 *
 * Mirrored rather than imported: `e2e` does not depend on `client`, and this is the string the
 * browser sees rather than a value either side computes. `packages/client/test/bundle.test.ts` holds
 * the other end.
 */
const PLAYER_HANDLE = '__swarmHlsPlayer';

/**
 * The ratio `LIVE_MAX_LATENCY_DURATION_S` keeps to the target it follows.
 *
 * ⛔ Applied on every arm rather than left alone. hls.js validates `liveMaxLatencyDuration >
 * liveSyncDuration` **at construction only**, so cutting the target at runtime does not throw, it
 * silently widens the ratio. `playerConfig.ts` records what that costs: above 2x the catch-up range
 * and the seek range stop meeting, and a viewer sat between 22 and 30 seconds behind with neither
 * running.
 */
const MAX_LATENCY_RATIO = 2;

export interface ArmSetup {
  /** What the player reports as its own target once set, which is not assumed to be `targetS`. */
  targetLatencyS: number | null;
  maxLatencyS: number | null;
  /** `#EXT-X-TARGETDURATION` as the player parsed it. Caps the stall penalty, and it ratchets. */
  targetDurationS: number | null;
  stallCountAtStart: number | null;
  failure: string | null;
}

/**
 * Point the player at a new buffer target, and read back what it actually took.
 *
 * ⭐ Uses `hls.targetLatency = x` rather than writing `config.liveSyncDuration` directly, because the
 * setter also does `stallCount = 0`. The stall penalty rides on the player instance, so without that
 * reset a stall in one arm follows the viewer into the next and every later arm reads high.
 *
 * ⛔ Reads the values back instead of trusting the write. The getter composes the target from config,
 * the playlist and the stall count, so what a viewer is actually held at is not the number handed in,
 * and an arm that failed to take is a silently useless arm.
 */
export async function setArm(page: Page, targetS: number): Promise<ArmSetup> {
  return page.evaluate(
    ({ handle, target, ratio }: { handle: string; target: number; ratio: number }) => {
      const player = (globalThis as unknown as Record<string, unknown>)[handle] as
        | {
            targetLatency: number | null;
            config: { liveSyncDuration?: number; liveMaxLatencyDuration?: number };
            latencyController?: { stallCount?: number };
            levels?: { details?: { targetduration?: number } }[];
            currentLevel?: number;
          }
        | undefined;

      if (!player) {
        return {
          targetLatencyS: null,
          maxLatencyS: null,
          targetDurationS: null,
          stallCountAtStart: null,
          failure:
            `no player at globalThis.${handle}. The client must be built with VITE_EXPOSE_PLAYER ` +
            'set, and the page must have mounted a player before an arm is set.',
        };
      }

      player.config.liveMaxLatencyDuration = target * ratio;
      // Last, because the setter is what clears the stall penalty and the line above must not land
      // between that reset and the start of the arm.
      player.targetLatency = target;

      const level = player.levels?.[player.currentLevel ?? 0];
      return {
        targetLatencyS: player.targetLatency,
        maxLatencyS: player.config.liveMaxLatencyDuration ?? null,
        targetDurationS: level?.details?.targetduration ?? null,
        stallCountAtStart: player.latencyController?.stallCount ?? null,
        failure: null,
      };
    },
    { handle: PLAYER_HANDLE, target: targetS, ratio: MAX_LATENCY_RATIO },
  );
}

/**
 * Whether an arm is worth counting, decided before its numbers are read.
 *
 * ⛔ The stall penalty is capped at `#EXT-X-TARGETDURATION`, and `ManifestManager` keeps that as a
 * running maximum of `ceil()` that never falls. So one force-closed segment raises the ceiling for
 * the rest of the broadcast, and an arm measured before that happened is not comparable with one
 * measured after. Recorded per arm rather than assumed constant across the sitting.
 */
export function armIsComparable(arm: ArmSetup, firstTargetDurationS: number | null): string | null {
  if (arm.failure) {
    return arm.failure;
  }
  if (arm.targetLatencyS === null) {
    return 'the player reported no target latency, so nothing says the arm took';
  }
  if (arm.stallCountAtStart !== 0 && arm.stallCountAtStart !== null) {
    return `arm started with stallCount ${arm.stallCountAtStart}, so it carries the previous arm's penalty`;
  }
  if (firstTargetDurationS !== null && arm.targetDurationS !== null && arm.targetDurationS !== firstTargetDurationS) {
    return (
      `#EXT-X-TARGETDURATION moved from ${firstTargetDurationS} to ${arm.targetDurationS}, so the stall ` +
      'penalty ceiling is not the one earlier arms were measured under'
    );
  }
  return null;
}

/**
 * Per-arm contributions from a series of session totals.
 *
 * ⛔ `summarize` reads `rebufferCount`, `rebufferMs`, `fatalErrors` and `droppedFrames` through
 * `totalAcrossRestarts`, which takes the peak of a **monotonic session counter**. That is right for a
 * whole watch and wrong for one arm of a sweep: each arm would report everything its predecessors
 * accumulated, an arm that caused nothing would report the running total, and the column the sweep is
 * scored on would read flat whatever the buffer did.
 *
 * ⚠️ `stalledSamples` needs none of this. It counts samples inside the arm, which is why the two sat
 * side by side in one table looking like the same kind of number.
 *
 * A total that goes **down** is a player restart resetting its counter, so the drop is not negative
 * work: the arm contributed whatever it reached from zero.
 */
export function perArmFromSessionTotals(totals: readonly number[]): number[] {
  let previous = 0;
  return totals.map((total) => {
    // Against the previous reading rather than the running peak: after a restart the counter's own
    // baseline is what later arms are measured from, and carrying the old peak would credit every
    // arm after a restart with nothing until it climbed back past it.
    const contribution = total >= previous ? total - previous : total;
    previous = total;
    return contribution;
  });
}

/**
 * How many uneventful samples an arm keeps in the artefact.
 *
 * A sample costs about 400 bytes once `writeRunArtifacts` pretty-prints it, and a sitting is as many
 * arms as it has questions. Seventeen arms of 300s is 5,100 samples and a **2.54 MB** json committed
 * to git, against 1.29 MB for the largest file `docs/bench` holds and 9.9 MB for everything it has
 * accumulated. At this cap that sitting is 1.28 MB, the shipped four-plus-two arms of 240s go from
 * 0.72 MB to 0.36, and an uneventful stretch is sampled every other second.
 */
export const MAX_LOGGED_UNEVENTFUL_SAMPLES = 150;

/**
 * Which samples an arm cannot be read without.
 *
 * Everything the sweep is scored on, plus what the overlay was telling the viewer. Judged against
 * the preceding sample rather than read off this one, because the player reports all of these as
 * running totals for the session: a rebuffer is a step in a counter rather than a flag on a sample.
 *
 * The stall test is {@link playbackAdvances} against {@link STALLED_ADVANCE_RATIO}, which is the
 * arithmetic {@link summarize} counts `stalledSamples` with. A second definition of a stall here
 * would leave the kept samples disagreeing with the score they are the evidence for.
 */
function eventfulFlags(samples: readonly ViewerSample[]): boolean[] {
  // advances[i] describes the step from samples[i] to samples[i + 1], so it is indexed off by one.
  const advances = playbackAdvances(samples);

  return samples.map((sample, i) => {
    // The arm's first sample, which is what puts the arm on the wall clock the request log uses.
    if (i === 0) {
      return true;
    }
    const previous = samples[i - 1];
    return (
      advances[i - 1].ratio < STALLED_ADVANCE_RATIO ||
      sample.rebufferCount !== previous.rebufferCount ||
      sample.rebufferMs !== previous.rebufferMs ||
      sample.bufferStalls !== previous.bufferStalls ||
      sample.fatalErrors !== previous.fatalErrors ||
      sample.feedStateMessage !== previous.feedStateMessage
    );
  });
}

/**
 * Keep every sample where something happened, and an evenly spread sample of the rest.
 *
 * ⭐ **The series is what says _when_ inside an arm a rebuffer landed**, which a count cannot.
 * `docs/bench/gop-floor-replicate-2026-08-12.md` established that our own uploader publishes a
 * segment's reference about 100ms before its bytes are retrievable, and the refusals that follow from
 * it are already in the `.requests.json` beside the report with their `startedAtMs`. Whether the
 * rebuffers a small buffer target produces are those refusals is a question about two timestamps, and
 * both sides are `Date.now()` on the host that launched the browser, so they subtract.
 *
 * Thinned on `thinRequestLog`'s pattern and for its reason: an event is why anyone opens the file,
 * and the uneventful majority is there to give the events a background. One pass, in order.
 *
 * An event's predecessor is kept as well. These counters only report that something has already
 * happened, so the sample before one is what bounds when it started, and without it that bracket
 * would widen with the thinning rate rather than staying at a sampling interval. A refusal lasts
 * about 100ms, so a bracket that grew with the cap would be the thinning quietly dissolving the
 * comparison the samples are kept for.
 *
 * ⛔ Every figure the report scores is computed over the **whole** series before this runs, so no
 * number in a sweep report changes.
 */
export function thinSamples(samples: readonly ViewerSample[]): ViewerSample[] {
  const eventful = eventfulFlags(samples);
  const keep = eventful.map((flag, i) => flag || eventful[i + 1] === true);

  const uneventful = keep.reduce((total, flag) => total + (flag ? 0 : 1), 0);
  if (uneventful <= MAX_LOGGED_UNEVENTFUL_SAMPLES) {
    return [...samples];
  }

  const everyNth = Math.ceil(uneventful / MAX_LOGGED_UNEVENTFUL_SAMPLES);
  let thinned = 0;
  return samples.filter((_, i) => (keep[i] ? true : thinned++ % everyNth === 0));
}

export interface ArmPlan {
  label: string;
  targetS: number;
  /** False for the warm-up arms, which are measured and then thrown away. */
  counted: boolean;
}

export interface ArmResult {
  label: string;
  requestedTargetS: number;
  counted: boolean;
  setup: ArmSetup;
  excludedBecause: string | null;
  /** How many samples the arm took, which is more than {@link samples} holds once thinned. */
  sampleCount: number;
  /** The arm's own series, thinned by {@link thinSamples}. */
  samples: readonly ViewerSample[];
  /**
   * Rebuffers this arm caused, not the session total at the end of it.
   *
   * ⛔ Left as the session total by {@link armResultFrom} and replaced once the sweep ends, because
   * the counter behind it is monotonic across the whole sweep and one arm's contribution is not
   * knowable until its predecessor's total is. See {@link perArmFromSessionTotals}.
   *
   * ⚠️ `stalledSamples` beside it needs no such treatment: it counts samples inside the arm.
   */
  rebufferCount: number;
  stalledSamples: number;
  medianLatencyS: number | null;
  instrumentSound: boolean;
  instrumentFailures: string[];
}

/**
 * Everything an arm is worth, in one place, so a runner cannot report a figure the arm did not
 * measure.
 *
 * The summary and the instrument verdict are taken over the whole stretch, before
 * {@link thinSamples} touches anything.
 *
 * ⛔ {@link ArmResult.rebufferCount} comes out of here as the **session** total. Nothing inside one
 * arm can difference it, so the runner replaces it through {@link perArmFromSessionTotals} once the
 * sweep has every arm's reading.
 */
export function armResultFrom(
  arm: ArmPlan,
  setup: ArmSetup,
  firstTargetDurationS: number | null,
  stretch: SampledStretch,
): ArmResult {
  const summary = summarize(stretch.samples);
  const instrument = judgeRun(stretch.readings);

  return {
    label: arm.label,
    requestedTargetS: arm.targetS,
    counted: arm.counted,
    setup,
    excludedBecause: arm.counted ? armIsComparable(setup, firstTargetDurationS) : 'warm-up',
    sampleCount: stretch.samples.length,
    samples: thinSamples(stretch.samples),
    rebufferCount: summary.rebufferCount,
    stalledSamples: summary.stalledSamples,
    medianLatencyS: summary.latency.medianLatencyS ?? null,
    instrumentSound: instrument.sound,
    instrumentFailures: instrument.failures,
  };
}
