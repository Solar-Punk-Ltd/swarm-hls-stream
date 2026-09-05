/**
 * What `pnpm make:recording` counts while it publishes, and which rung its outage reaches.
 *
 * ## ⛔⛔ Why a recording is counted per rung
 *
 * A recording is watched one rung at a time. The uploader writes one `Segment N of <stream>
 * uploaded` line per rung, so the merged count is the ladder's width times the recording's length,
 * and a target set against it produces a recording a viewer sees a fraction of. Found live on
 * 2026-09-02 on the latbench stage: 60 before and 60 after, on four rungs, made 32 segments per
 * rung. The driver reported success.
 *
 * ## Why the rules live here rather than in the driver
 *
 * `browser/make-recording.ts` runs its own `main()` on import, so a test that pulled it in would
 * publish a broadcast and spend BZZ. Everything here is pure and `test/recording.test.ts` reaches
 * it, which puts the arithmetic in `pnpm verify` where it costs nothing.
 */

import { announcedRungs, segmentIndicesByStream } from './logwatch.js';

/** One rung's progress through a recording. */
export interface RungSegmentCount {
  /** The rung as the ladder names it, or the stream id where the log announces no rungs at all. */
  rung: string;
  segments: number;
}

/** How far a recording has got, per rung and as the one number a target is set against. */
export interface RecordingProgress {
  /** Every rung the broadcast announced, in announce order, including any that published nothing. */
  rungs: readonly RungSegmentCount[];
  /**
   * The count EVERY rung has reached, which is what a viewer sees whichever rung they ride.
   *
   * ⭐ The minimum rather than the tallest or an average. A player picks its own rung, so a
   * recording is only as long as its shortest one, and any other reading calls a recording ready
   * while a viewer on the slow rung runs out of it early.
   */
  perRung: number;
}

/**
 * How far each rung of a recording has got, out of the uploader's log.
 *
 * ⚠️ **Distinct indices per rung**, so a segment the uploader logged twice counts once. It does not
 * repair the other overcount a log window carries: SRS's segment counter runs on across broadcasts,
 * so a straggler from the previous broadcast arrives at an index continuing the sequence and is
 * indistinguishable from this broadcast's own. `lastUploadedSegmentRefByRung` records that at
 * length, and a handful over on a target of sixty is a different order of error from the fourfold
 * one this replaces.
 *
 * ⛔ The rung set comes from what the log ANNOUNCED, not from what has published. A rung that
 * announced and then published nothing is this deployment's signature failure, and it has to count
 * zero rather than be absent: absent, it leaves the minimum, and a ladder that lost 1080p at its
 * first segment would report the other three's progress and stop publishing on a recording that
 * cannot be watched at 1080p at all. A broadcast that announces no rungs is single-rendition, and
 * there the streams that published are the whole of it.
 */
export function recordingProgress(log: string): RecordingProgress {
  const byStream = segmentIndicesByStream(log);
  const countOf = (streamId: string): number => new Set(byStream.get(streamId) ?? []).size;

  const announced = new Map<string, string>();
  for (const announce of announcedRungs(log)) {
    announced.set(announce.streamId, announce.rung);
  }

  const rungs: RungSegmentCount[] =
    announced.size > 0
      ? [...announced].map(([streamId, rung]) => ({ rung, segments: countOf(streamId) }))
      : [...byStream.keys()].map((streamId) => ({ rung: streamId, segments: countOf(streamId) }));

  return { rungs, perRung: rungs.length === 0 ? 0 : Math.min(...rungs.map((rung) => rung.segments)) };
}

/**
 * The line an operator reads while a recording is being made.
 *
 * Every rung by name, because a rung that has stopped publishing is what the wait is stuck on and
 * the driver would otherwise sit at one number for ten minutes without saying which rung held it
 * there. The media seconds are stated rather than left as segments times a length a reader has to
 * remember, since that multiplication is the one the driver was getting wrong.
 *
 * @param segmentSeconds What the running stage cuts at, or null where it could not be read. Null is
 *   an engine this harness has no config reader for rather than a stage cutting nothing, so the
 *   media clause is dropped instead of being printed as zero.
 */
export function recordingSummary(progress: RecordingProgress, segmentSeconds: number | null): string {
  const perRung = progress.rungs.map((rung) => `${rung.rung} ${rung.segments}`).join(', ');
  const media =
    segmentSeconds === null
      ? ', of a media length this stage does not report'
      : `, ${(progress.perRung * segmentSeconds).toFixed(1)}s of media at ${segmentSeconds}s segments`;

  return `${perRung || 'nothing published yet'}; ${progress.perRung} per rung${media}`;
}

/** `1080p` is 1080 and `live/stream` is nothing. */
const RUNG_HEIGHT = /^(\d+)/;

/**
 * The shortest rung of a ladder, which is the one `bee-uploader` publishes.
 *
 * ⛔ Not a preference. `bee-uploader` is the lowest rung's node as well as the shared default,
 * because the stream catalog and every ladder's master playlist go through the longest-lived batch,
 * which is the cheapest rung's. See `BEE_PUBLISHERS` in `.env.sample` and the per-rung block in
 * `deploy/docker-compose.yml`. So on a split ladder an outage of that container reaches this rung
 * and no other, and a driver that says "the writer's node" without naming it claims a discontinuity
 * on four rungs when it armed one.
 *
 * Null where no name carries a height, which is a single-rendition deployment rather than a ladder,
 * and there is no lowest rung of one stream.
 */
export function lowestRungOf(rungs: readonly string[]): string | null {
  const heighted = rungs.flatMap((rung) => {
    const height = RUNG_HEIGHT.exec(rung)?.[1];
    return height === undefined ? [] : [{ rung, height: Number(height) }];
  });
  if (heighted.length === 0) {
    return null;
  }

  return heighted.reduce((lowest, candidate) => (candidate.height < lowest.height ? candidate : lowest)).rung;
}
