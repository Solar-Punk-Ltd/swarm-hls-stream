import { Rendition } from '../types.js';

/**
 * When a ladder counts as a recording, and which of its rungs that recording names.
 *
 * ⛔⛔⛔ **A ladder used to be a recording only once every rung carried an index, and a rung that
 * cannot finish never will.** Measured live 2026-09-23: 1080p's postage batch filled, its closing
 * playlist and its recording were refused with 402, and the orchestrator force-stopped it two seconds
 * before 360p, 480p and 720p finalized. The catalog entry then said `live` with no index for good, so
 * viewers were shown a dead live broadcast and never the recording three rungs had made. Owner ruling:
 * the broadcast is listed as finished with the rungs that did finish, and a rung that finishes later is
 * added then.
 *
 * Shared by both ladder registries, because the rule has to be the same whichever side of the wire the
 * ladder's merge lives on.
 */

/** Whether this rung has published its recording, which is exactly what an index on its record says. */
export function hasRecording(rendition: Rendition): boolean {
  return rendition.index !== undefined;
}

/** The rungs a recording can offer a viewer: those with a recording, in the ladder's own order. */
export function recordedRungs<T extends Rendition>(renditions: readonly T[]): T[] {
  return renditions.filter(hasRecording);
}

/**
 * Whether the ladder is a recording: every rung has either finished or is known not to finish, and at
 * least one of them finished.
 *
 * ⚠️ At least one, because a ladder none of whose rungs finished has nothing to point a viewer at, and
 * listing it as a recording would trade a dead live entry for an unplayable one.
 *
 * @param unfinished the names of rungs whose session ended without a recording. See
 * `LadderRegistry.recordRungUnfinished`.
 */
export function isFinishedLadder(renditions: readonly Rendition[], unfinished: ReadonlySet<string>): boolean {
  return (
    renditions.some(hasRecording) &&
    renditions.every((rendition) => hasRecording(rendition) || unfinished.has(rendition.name))
  );
}

/**
 * How long a recording plays: its longest rung. The rungs are cut from one broadcast and differ by
 * fractions of a segment, and a viewer's seek bar must not stop short of the longest one.
 */
export function recordingDuration(recorded: readonly Rendition[]): number {
  return Math.max(0, ...recorded.map((rendition) => rendition.duration ?? 0));
}
