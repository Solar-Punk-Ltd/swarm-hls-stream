import { BroadcastAnchor, BroadcastEpoch } from '../types.js';

const MS_PER_SECOND = 1000;

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
 * When the segment at this playlist sequence is presented, in epoch milliseconds.
 *
 * Derived and never observed. Not the time the segment arrived, and not its own `#EXTINF`: four rung
 * uploaders stamping their own readings would disagree about the same media by their upload jitter.
 * See {@link BroadcastAnchor}.
 */
export function programDateTimeMsOf(anchor: BroadcastAnchor, sequence: number): number {
  return dateOnLine(epochFor(anchor, sequence), sequence, anchor.fragmentSeconds);
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

export interface ReanchorRequest {
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

/**
 * The epoch a rung takes when its numbering resumes after a restart, reusing the line a sibling
 * already minted for that same restart.
 *
 * ⭐ **What is shared across the ladder is the line, never the point it is written down at.** Rungs
 * cross a restart with their own numbering at their own places, so each one materialises the shared
 * line at its own `resumeAt`. A rung one sequence behind its siblings therefore lands one fragment
 * earlier on that line, which is the same function of sequence they are all reading. Handing it the
 * sibling's point unchanged would leave its own first post-restart segment on the old line, with the
 * whole jump landing on the segment after it, where no discontinuity marks it.
 *
 * ⛔ **A restart is recognised by whether the line it minted still dates this rung's media as
 * happening now**, rather than by a clock reading or by how close the sequences are. That one test
 * covers both ways two restarts can be confused. A sibling crossing the same restart is asking about
 * a sequence within a fragment or two of the one the line was minted at, so the line dates it within
 * a fragment or two of now. A second restart is asking about a sequence the line reaches after an
 * outage in which no sequence advanced at all, so the line dates it that whole outage ago, however
 * few fragments of media separate the two restarts.
 *
 * ⛔ **The broadcast's own start is never reused.** It is where the dating began rather than a
 * re-anchoring, so the first restart of a broadcast always re-anchors, which is the lag this whole
 * shape exists to remove.
 *
 * The floor applies to a minted epoch and not to a reused one. Minting takes the wall clock, and a
 * dating that had run ahead of it would be pulled backwards, which hls.js reads as a parsing error
 * rather than as a restart. A reused line needs no floor: every rung was on one line before the
 * restart too, and the minter's floor already puts the line at or after the date its own resuming
 * sequence would have carried, so a rung any number of sequences behind lands at or after its own.
 */
export function reanchorEpoch(anchor: BroadcastAnchor, request: ReanchorRequest): BroadcastEpoch {
  const { resumeAt, nowMs, notBeforeMs } = request;
  const minted = (anchor.epochs ?? []).at(-1);

  if (minted !== undefined) {
    const onTheSameLine = dateOnLine(minted, resumeAt, anchor.fragmentSeconds);
    if (Math.abs(onTheSameLine - nowMs) <= SAME_RESTART_TOLERANCE_MS) {
      return { fromSequence: resumeAt, atMs: onTheSameLine };
    }
  }

  return { fromSequence: resumeAt, atMs: Math.max(nowMs, notBeforeMs) };
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
