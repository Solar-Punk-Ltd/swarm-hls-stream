/**
 * Whether the segments arriving are the length this uploader was told they would be.
 *
 * ⛔⛔⛔ **`HLS_FRAGMENT` is one variable that two containers read, and only one of them is
 * restarted when it changes.** The engine cuts segments with it. The uploader never measures a date:
 * it derives every `#EXT-X-PROGRAM-DATE-TIME` from the broadcast start plus the sequence times this
 * same number, which is what keeps four rungs stamping one piece of media identically. Both
 * containers read the variable from one env file and both re-read it only when they are recreated,
 * and the operator's control plane recreates the engine alone on a segment length change. So an
 * uploader believing 0.5 can sit behind an engine cutting 1.0, which is what this deployment was
 * measured doing on 2026-09-04 and again in the week of 2026-09-15.
 *
 * What that costs is not a wrong reading, it is a wrong recording. Every stamp drifts by the
 * difference, cumulatively, so a viewer's timeline runs at a different rate from the media, and the
 * recording keeps those dates for ever. After a reconnect the four rungs can even mint separate
 * dating lines from it. The uploader holds both numbers on every single segment and nothing had ever
 * compared them, and nothing on the deploy path compares them either.
 *
 * ⚠️ **Only a ladder makes a difference a fault.** With `ABR_ENABLED` on, `engines/srs/entrypoint.sh`
 * gives every rung a keyframe every `ABR_FPS x HLS_FRAGMENT` frames and refuses a product that is not
 * a whole number of frames, and SRS cuts on that keyframe, so a rung's segment holds exactly the
 * configured length of media. With the ladder off the publisher's own keyframe interval decides the
 * segment and `HLS_FRAGMENT` is a floor, so longer segments are the stage working as designed.
 *
 * This is a signal and never a brake. Nothing here changes a date, refuses a segment or ends a
 * broadcast.
 */

/**
 * How many measured segments one verdict is taken over.
 *
 * Wide enough for a median to survive one odd reading, because SRS force-closes a segment at
 * `HLS_FRAGMENT x HLS_AOF_RATIO` whether a keyframe arrived or not, and short enough that a
 * mis-deployed stage is named inside the first playlist window rather than after the broadcast.
 * Eight segments is four seconds of media at the shipping 0.5s profile.
 */
export const FRAGMENT_SAMPLE_COUNT = 8;

/**
 * How far a measured median may sit from the configured length before the two are called different.
 *
 * Five percent is two orders of magnitude above the spread a correct ladder produces and twenty
 * times below the smallest mismatch a stale container can produce. Under a ladder the segment is an
 * exact whole number of frames of the configured length, so the only spread left is 90kHz tick
 * rounding at a frame rate that does not divide it, which is a fraction of a percent. A mismatch, by
 * contrast, is always two different configured numbers, and both measured cases were a factor of two.
 *
 * ⚠️ Not tighter, because a false positive here takes `/health` to 503 and the compose healthcheck
 * reads that.
 */
export const FRAGMENT_TOLERANCE = 0.05;

/** Not enough segments have been measured to say anything. */
export const FRAGMENT_UNDECIDED = 'undecided' as const;
/** The media is the length the deployment configured. */
export const FRAGMENT_AGREES = 'agrees' as const;
/** The two differ on a stage where they cannot legitimately, so one container is running an older deploy. */
export const FRAGMENT_MISMATCH = 'mismatch' as const;
/** The two differ on a single rendition, where the publisher's own GOP decides the segment. */
export const FRAGMENT_PUBLISHER_GOP = 'publisher-gop' as const;

export type FragmentVerdict =
  | { kind: typeof FRAGMENT_UNDECIDED }
  | { kind: typeof FRAGMENT_AGREES; measuredSeconds: number }
  | { kind: typeof FRAGMENT_MISMATCH; measuredSeconds: number }
  | { kind: typeof FRAGMENT_PUBLISHER_GOP; measuredSeconds: number };

/** What the deployment asked for, and whether its stage is one where the engine must deliver it. */
export interface FragmentStage {
  /** Seconds of media per fragment, from `HLS_FRAGMENT`, which is what every date steps by. */
  configuredSeconds: number;
  /** `ABR_ENABLED`, which is what makes a difference a fault rather than the publisher's choice. */
  underLadder: boolean;
}

/** One stream's readings so far, and the verdict once there are enough of them. */
export interface FragmentWatch {
  readonly samples: readonly number[];
  readonly verdict: FragmentVerdict;
}

/** A stream that has measured nothing yet, which is where every stream starts. */
export const UNWATCHED_FRAGMENT: FragmentWatch = { samples: [], verdict: { kind: FRAGMENT_UNDECIDED } };

/**
 * `samples` with `seconds` added, or `samples` itself once the sample is full.
 *
 * The opening of a broadcast is what is measured rather than a sliding window, because the fault is
 * a container that was started with the wrong value and there is nothing later that changes it.
 */
export function withFragmentSample(samples: readonly number[], seconds: number): readonly number[] {
  return samples.length >= FRAGMENT_SAMPLE_COUNT ? samples : [...samples, seconds];
}

/**
 * The middle reading, which is the mean of the two middle ones on an even sample.
 *
 * The median rather than the mean of all of them, because one force-closed segment is far longer
 * than the rest and would pull a mean across the tolerance on its own.
 *
 * Needs at least one reading. Every caller counts to {@link FRAGMENT_SAMPLE_COUNT} first.
 */
export function medianSeconds(samples: readonly number[]): number {
  const ascending = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(ascending.length / 2);
  return ascending.length % 2 === 1 ? ascending[middle] : (ascending[middle - 1] + ascending[middle]) / 2;
}

/** What a full sample says about this stage, and {@link FRAGMENT_UNDECIDED} until the sample is full. */
export function fragmentVerdict(samples: readonly number[], stage: FragmentStage): FragmentVerdict {
  if (samples.length < FRAGMENT_SAMPLE_COUNT) {
    return { kind: FRAGMENT_UNDECIDED };
  }

  const measuredSeconds = medianSeconds(samples);
  if (Math.abs(measuredSeconds - stage.configuredSeconds) <= stage.configuredSeconds * FRAGMENT_TOLERANCE) {
    return { kind: FRAGMENT_AGREES, measuredSeconds };
  }

  return { kind: stage.underLadder ? FRAGMENT_MISMATCH : FRAGMENT_PUBLISHER_GOP, measuredSeconds };
}

/**
 * `watch` with one more reading folded in.
 *
 * A settled watch is returned unchanged, which is what lets a caller report a verdict exactly once:
 * the only call that returns a different object is the one that settles it.
 */
export function watchFragment(watch: FragmentWatch, measuredSeconds: number, stage: FragmentStage): FragmentWatch {
  if (watch.verdict.kind !== FRAGMENT_UNDECIDED) {
    return watch;
  }

  const samples = withFragmentSample(watch.samples, measuredSeconds);
  return { samples, verdict: fragmentVerdict(samples, stage) };
}

/** Three decimals, so a median that lands on a float reads as a length rather than as an artefact. */
function asLength(seconds: number): string {
  return seconds.toFixed(3);
}

/** The two clocks, in the one sentence both messages share. */
const TWO_CLOCKS =
  'Every #EXT-X-PROGRAM-DATE-TIME steps by the configured value from the broadcast start rather ' +
  'than by anything measured, so the playlist says a segment covers one length of media while the ' +
  'media covers another, and the recording keeps those dates for ever.';

/**
 * What an operator is told when a ladder's segments are not the configured length.
 *
 * The remedy is the wording `e2e/src/segmentLength.ts` already uses for the same fault read off the
 * two containers' environments, because an operator meeting it twice should meet one instruction.
 */
export function fragmentMismatchReport(streamId: string, measuredSeconds: number, stage: FragmentStage): string {
  return (
    `${streamId} is being dated by HLS_FRAGMENT ${stage.configuredSeconds} and its segments measure ` +
    `${asLength(measuredSeconds)}s of media. ${TWO_CLOCKS} With the ladder on the two cannot ` +
    'legitimately differ, because every rung is re-encoded with a keyframe every ABR_FPS x ' +
    'HLS_FRAGMENT frames and SRS cuts exactly there. One of the two containers is running an older ' +
    'deploy: HLS_FRAGMENT is one value in the deployment env and it reaches both, so a difference is ' +
    'a container that was never restarted on the current one. Redeploy the stale one.'
  );
}

/** The same reading on a single rendition, where the stage rather than a stale deploy explains it. */
export function fragmentLengthNotice(streamId: string, measuredSeconds: number, stage: FragmentStage): string {
  return (
    `${streamId} is being dated by HLS_FRAGMENT ${stage.configuredSeconds} and its segments measure ` +
    `${asLength(measuredSeconds)}s of media. ${TWO_CLOCKS} Nothing on this stage transcodes, so the ` +
    'segment is the first keyframe at or after HLS_FRAGMENT and the publisher decides it, which ' +
    'makes the configured value a floor rather than the length. Bring the publisher GOP to ' +
    'HLS_FRAGMENT, or turn ABR_ENABLED on, where the fragment sets the segment directly.'
  );
}
