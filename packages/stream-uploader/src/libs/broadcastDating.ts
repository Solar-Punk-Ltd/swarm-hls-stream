import { BroadcastAnchor, BroadcastEpoch } from '../types.js';

const MS_PER_SECOND = 1000;

/**
 * How far a segment's measured length may sit from the configured one and still be dated as that
 * configured length.
 *
 * **What it is: the rounding band of one keyframe grid seen by several encoders.** Under
 * `ABR_ENABLED` every rung is re-encoded from one source with a keyframe forced every
 * `ABR_FPS x HLS_FRAGMENT` frames, and SRS cuts on that keyframe, so all four rungs are cutting the
 * same instants of media. What separates their readings is 90kHz tick rounding at a frame rate that
 * does not divide it, which is a fraction of a percent. One percent covers that with room and
 * nothing else, which is the whole job: every rung reads the same segment as the configured length,
 * so all four date it identically while each publishes its own `#EXTINF`.
 *
 * ⛔ **What it is NOT: `FRAGMENT_TOLERANCE` from `fragmentAgreement.ts`, and the two are different
 * numbers on purpose.** That one answers a different question, whether this stage is misconfigured,
 * and it is five percent because it has to survive a segment SRS force-closed at
 * `HLS_FRAGMENT x HLS_AOF_RATIO` without calling a correct deployment broken. Borrowing it here
 * would leave real media unmeasured: a segment of 2.067 seconds against a configured 2 is inside
 * five percent, so it would be dated as 2.000 and its 67 milliseconds lost, every segment, which is
 * about two minutes an hour. That is the exact live stream this dating exists to fix, measured
 * 2026-09-15.
 *
 * The consequence, both ways. A measured duration within one percent of the configured length is
 * read as the configured length, so the rungs of a ladder stay identical to the millisecond.
 * Anything wider is read as itself, rounded to the millisecond, so a recording says what its media
 * really did.
 */
export const DATING_SNAP_TOLERANCE = 0.01;

/**
 * How far the dating a restart already minted may sit from the wall clock and still be read as that
 * same restart.
 *
 * ⛔ Two failures pull on this number in opposite directions, and they are not equally bad.
 *
 * Too tight, and a rung that crosses the restart later than its siblings mints a line of its own.
 * The ladder then dates one segment two different ways, which hls.js reads as the rungs covering
 * different media, and a level switch lands somewhere else. The 1080p rung is the one this happens
 * to: it is the slowest to transcode and the slowest to upload, and after a restart it has been
 * measured tens of seconds behind the three fast rungs before its first segment lands at all.
 *
 * Too loose, and two restarts close together collapse into one, so the media after the second one is
 * dated from the first one's line and lags by however long the second outage was. That lag is
 * bounded by this number, against the unbounded one it replaces.
 *
 * Two minutes therefore, because a bounded lag is the cheaper of the two failures.
 */
export const SAME_RESTART_TOLERANCE_MS = 120_000;

/** Where a broadcast's dating starts, which is the epoch every sequence below the first restart takes. */
function openingEpoch(anchor: BroadcastAnchor): BroadcastEpoch {
  return { fromSequence: 0, atMs: anchor.startedAtMs };
}

/**
 * The epoch a playlist sequence is dated from: the newest one that starts at or below it.
 *
 * The list is kept in `fromSequence` order by {@link withEpoch}, so the first match walking back is
 * the newest, and a sequence below every epoch falls through to the broadcast's own start.
 */
function epochFor(anchor: BroadcastAnchor, sequence: number): BroadcastEpoch {
  const epochs = anchor.epochs ?? [];
  for (let i = epochs.length - 1; i >= 0; i--) {
    if (epochs[i].fromSequence <= sequence) {
      return epochs[i];
    }
  }
  return openingEpoch(anchor);
}

/** The date `sequence` carries under `epoch`, stepping by the declared fragment length. */
function dateOnLine(epoch: BroadcastEpoch, sequence: number, fragmentSeconds: number): number {
  return epoch.atMs + Math.round((sequence - epoch.fromSequence) * fragmentSeconds * MS_PER_SECOND);
}

/**
 * When the segment at this playlist sequence is presented, counting every sequence below it as one
 * configured fragment of media.
 *
 * What the dating was before it followed the media, and still the answer in the two places where no
 * media is there to follow: the first segment placed at or after an epoch, and a sequence nothing
 * has been placed below. {@link presentationMsOf} dates a segment that has media in front of it.
 */
export function programDateTimeMsOf(anchor: BroadcastAnchor, sequence: number): number {
  return dateOnLine(epochFor(anchor, sequence), sequence, anchor.fragmentSeconds);
}

/**
 * The media one segment contributes to the date of the one after it, in milliseconds.
 *
 * ⛔ **A measurement inside {@link DATING_SNAP_TOLERANCE} of the configured length is read AS the
 * configured length, and that is what keeps a ladder's rungs agreeing to the millisecond.** Every
 * rung of one ladder is cut on one keyframe grid, so what separates their readings of a segment is
 * tick rounding rather than media, and reading all of those as the configured length makes four
 * rungs date one piece of media identically while each keeps its own `#EXTINF`.
 *
 * Outside that band the segment is read as itself. That is the single-rendition stage, where the
 * publisher's own keyframe interval decides the segment and `HLS_FRAGMENT` is a floor: segments
 * measured 2.067 to 10.033 seconds against a configured 2 on 2026-09-15, and dating each of them at
 * 2.000 put the recording's wall clock further behind its own media with every segment, permanently.
 */
export function datedDurationMs(measuredSeconds: number, fragmentSeconds: number): number {
  const onTheGrid = Math.abs(measuredSeconds - fragmentSeconds) <= fragmentSeconds * DATING_SNAP_TOLERANCE;
  return Math.round((onTheGrid ? fragmentSeconds : measuredSeconds) * MS_PER_SECOND);
}

/** A segment already placed in the broadcast, as the dating reads one. */
export interface PlacedMedia {
  sequence: number;
  /** When it is presented, as {@link presentationMsOf} decided when it was placed. */
  presentedAtMs: number;
  /** Its own measured `#EXTINF`, in seconds. */
  durationSeconds: number;
}

/**
 * When the segment at `sequence` is presented, given the newest segment placed below it.
 *
 * ⛔ **Decided from the shared anchor plus the media in front of it, never from an arrival time.**
 * Four rung uploaders stamping the clock they received a segment at would disagree about the same
 * media by their upload jitter, and hls.js reads that as the rungs covering different media.
 *
 * A sequence between the two carries no media anybody observed, so it is charged the configured
 * length. That is also the `#EXTINF` its own `#EXT-X-GAP` entry declares, so a hole says the same
 * length it occupies.
 *
 * `previous` is null where nothing has been placed below `sequence`, and a `previous` that sits
 * below the epoch dating `sequence` is media from before a restart. Both take the epoch's own
 * arithmetic, which is what re-anchoring on the wall clock means.
 */
export function presentationMsOf(anchor: BroadcastAnchor, sequence: number, previous: PlacedMedia | null): number {
  const epoch = epochFor(anchor, sequence);
  if (previous === null || previous.sequence < epoch.fromSequence) {
    return dateOnLine(epoch, sequence, anchor.fragmentSeconds);
  }

  const lost = sequence - previous.sequence - 1;
  return (
    previous.presentedAtMs +
    datedDurationMs(previous.durationSeconds, anchor.fragmentSeconds) +
    Math.round(lost * anchor.fragmentSeconds * MS_PER_SECOND)
  );
}

/**
 * The dating with `epoch` in it, returned as a new anchor so a session still holding the old one
 * keeps the dates it published.
 *
 * Epochs it dates over are dropped rather than kept behind it. A replacement session numbers its
 * playlist from zero again, so its epoch starts at zero and supersedes every earlier one, which is
 * numbering nothing will publish again. What that leaves is a list in strict `fromSequence` order,
 * which is what makes {@link epochFor} unambiguous.
 */
export function withEpoch(anchor: BroadcastAnchor, epoch: BroadcastEpoch): BroadcastAnchor {
  const kept = (anchor.epochs ?? []).filter((held) => held.fromSequence < epoch.fromSequence);
  return { ...anchor, epochs: [...kept, epoch] };
}

interface ReanchorRequest {
  /** The first playlist sequence the resuming rung will publish, which is its own re-anchoring point. */
  resumeAt: number;
  /** The wall clock now, which is what a re-anchoring exists to put on the media. */
  nowMs: number;
  /**
   * The earliest date `resumeAt` may carry, which its caller takes as the date that sequence would
   * have carried had nothing restarted.
   */
  notBeforeMs: number;
}

/**
 * Where a rung asks for the dating of a restart, so every rung of one ladder gets the same answer.
 *
 * Implemented by the orchestrator against the anchor a broadcast's rungs share, and defaulted inside
 * {@link ManifestManager} for a manager built without one.
 */
export interface BroadcastDating {
  /**
   * The epoch a rung whose numbering resumes at `resumeAt` dates from, always starting at exactly
   * that sequence so nothing the rung has already published is re-dated.
   */
  epochFrom(resumeAt: number, notBeforeMs: number): BroadcastEpoch;
}

/** Which of the two ways a re-anchoring reached its epoch, alongside the epoch itself. */
interface ReanchorDecision {
  epoch: BroadcastEpoch;
  /**
   * Whether the epoch is this rung's own point on a line a sibling already minted for the same
   * restart, rather than a line this rung minted itself.
   *
   * ⭐ Not derivable from the epoch afterwards. A joining rung lands on the date its own sequence
   * already carried far more often than not, so a caller comparing the dating before against the
   * dating after cannot tell a join from a restart that happened to move nothing.
   */
  joined: boolean;
}

/**
 * The epoch a rung takes when its numbering resumes after a restart, reusing the line a sibling
 * already minted for that same restart, and which of those two things it did.
 *
 * ⭐ **What is shared across the ladder is the line, never the point it is written down at.** Rungs
 * cross a restart with their own numbering at their own places, so each one materialises the shared
 * line at its own `resumeAt`. A rung one sequence behind its siblings therefore lands one fragment
 * earlier on that line, which is the same function of sequence they are all reading. Handing it the
 * sibling's point unchanged would leave its own first post-restart segment on the old line, with the
 * whole jump landing on the segment after it, where no discontinuity marks it.
 *
 * ⛔⛔ **A restart is recognised by THE SEQUENCE ITS LINE WAS MINTED AT, and the clock is only a
 * backstop.** A line minted for one restart is joined by a rung asking about exactly the sequence it
 * was written down at, and by nothing else. That is what a sibling is: the rungs of one ladder are
 * cut by one encoder on one keyframe grid, so they cross a restart holding the same media and resume
 * at the same number by construction.
 *
 * ⛔ **The clock test alone was wrong, and it cost the second and every later reconnect of a
 * broadcast its dating.** It asked whether the minted line still dates `resumeAt` within
 * {@link SAME_RESTART_TOLERANCE_MS} of now, which is true of a second outage on the SAME rung for as
 * long as that outage is shorter than the tolerance: nothing advanced while the encoder was away, so
 * the line reaches the resuming sequence at almost exactly the instant it was minted. Measured
 * through the orchestrator on four fifty second outages: the first return was dated correctly, the
 * second landed 48 seconds behind, the third 96 seconds behind, and only the fourth was right,
 * because by then the accumulated lag had finally exceeded the tolerance. A rung's second reconnect
 * always resumes at a strictly higher sequence than its first, because a line is only ever minted
 * where a segment is actually placed, so keying on the sequence separates them exactly.
 *
 * ⛔ **A rung may join from AT OR BELOW the sequence a line was minted at, never from above, and the
 * direction is the whole discriminator.** A sibling that is behind its siblings is the routine case
 * — the 1080p rung is the slowest to transcode and the slowest to upload, and a rung whose last
 * pre-gap segment never landed resumes one lower than the rest — and it has always landed that many
 * fragments earlier on the shared line. A later reconnect on the same rung can only ever ask about a
 * HIGHER sequence than the line it already minted, because a line is minted where a segment is
 * placed and the high-water mark never decreases. So "at or below joins, above mints" separates the
 * two exactly, with no window to tune.
 *
 * ⚠️ **What it gives up, said out loud: a sibling that is AHEAD of the rung that minted first.** That
 * ask is shaped exactly like a second reconnect and cannot be told from one, so it mints a line of
 * its own at its own reading of the clock. Siblings cross a restart within seconds of each other, so
 * the cost is those seconds of disagreement about one instant; the alternative is a whole outage of
 * lag on every reconnect after the first, which is what the measurement above cost. It is also the
 * less common ordering: the rung that is behind in numbering is behind because it is slower, and a
 * slower rung is usually the last to come back rather than the first.
 *
 * The clock test is kept **as well**, so a line minted long ago cannot be joined by a sequence that
 * happens to sit below it forever. It is a backstop rather than the rule.
 *
 * ⛔ **The broadcast's own start is never reused.** It is where the dating began rather than a
 * re-anchoring, so the first restart of a broadcast always re-anchors, which is the lag this whole
 * shape exists to remove.
 *
 * ⛔ **The floor applies to both branches, because a line is grid arithmetic and the media is not.**
 * A minted epoch takes the wall clock, and a reused one is {@link dateOnLine}, which steps by the
 * configured fragment length from where the line was written down. Neither knows what the asking
 * rung's media actually did. Since the dating started following the media, a rung whose segments run
 * longer than `HLS_FRAGMENT` has stamped its playlist past that arithmetic, by the overrun times the
 * segments since, so the line can name an instant behind the segment already in front of the one
 * resuming. `notBeforeMs` is the caller's own account of the date that sequence would have carried,
 * read off its media rather than off the grid, which is why it is the floor for either answer.
 *
 * What a floorless join cost, on the stage measured 2026-09-15 (`HLS_FRAGMENT=2`, segments really
 * 2.067 seconds): about 67 milliseconds of backwards movement per segment since the restart the line
 * belongs to, up to the tolerance below. A date that goes backwards is not a late date. hls.js reads
 * it as a parsing error rather than as a restart, and a recording is sealed with it for ever.
 */
export function reanchorDecision(anchor: BroadcastAnchor, request: ReanchorRequest): ReanchorDecision {
  const { resumeAt, nowMs, notBeforeMs } = request;
  const minted = (anchor.epochs ?? []).at(-1);

  if (minted !== undefined && resumeAt <= minted.fromSequence) {
    const onTheSameLine = dateOnLine(minted, resumeAt, anchor.fragmentSeconds);
    if (Math.abs(onTheSameLine - nowMs) <= SAME_RESTART_TOLERANCE_MS) {
      return { epoch: { fromSequence: resumeAt, atMs: Math.max(onTheSameLine, notBeforeMs) }, joined: true };
    }
  }

  return { epoch: { fromSequence: resumeAt, atMs: Math.max(nowMs, notBeforeMs) }, joined: false };
}

/** {@link reanchorDecision} for a caller with no use for how the epoch was reached. */
export function reanchorEpoch(anchor: BroadcastAnchor, request: ReanchorRequest): BroadcastEpoch {
  return reanchorDecision(anchor, request).epoch;
}

/**
 * The dating of a broadcast with nobody to agree with, which is what a {@link ManifestManager} built
 * without one gets: every restart re-anchors on this process's own wall clock.
 *
 * Production always injects the orchestrator's instead, ladder or not, because a lone rendition is a
 * ladder of one and its dating is kept per broadcast for the same reasons.
 */
export function soleRungDating(anchorOf: () => BroadcastAnchor, wallClock: () => number = Date.now): BroadcastDating {
  return {
    epochFrom: (resumeAt, notBeforeMs) => reanchorEpoch(anchorOf(), { resumeAt, nowMs: wallClock(), notBeforeMs }),
  };
}
