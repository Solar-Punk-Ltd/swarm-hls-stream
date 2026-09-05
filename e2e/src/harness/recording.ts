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

import { UPLOAD_RETRY_WINDOW_MS } from './crashArm.js';
import { announcedRungs, segmentIndicesByStream } from './logwatch.js';

/** One rung's progress through a recording. */
interface RungSegmentCount {
  /** The rung as the ladder names it, or the stream id where the log announces no rungs at all. */
  rung: string;
  segments: number;
}

/** How far a recording has got, per rung and as the one number a target is set against. */
interface RecordingProgress {
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

  return `${perRung || 'nothing published yet'}. ${progress.perRung} per rung${media}`;
}

/**
 * How long a live rung may receive nothing before the uploader reaps it as an orphan.
 *
 * ⛔ Mirrors `ORPHAN_REAP_MS`'s default in `packages/stream-uploader/src/utils/config.ts`, and
 * `test/recording.test.ts` greps that file and fails if the two drift.
 */
export const ORPHAN_REAP_MS = 60_000;

/**
 * The deadline a drain runs to before the uploader force-stops the stream instead.
 *
 * ⛔ Mirrors `DRAIN_TIMEOUT_MS` in `packages/stream-uploader/src/libs/StreamOrchestrator.ts`, greped
 * the same way and for the same reason.
 */
export const DRAIN_TIMEOUT_MS = 5 * 60 * 1_000;

/** What a run knows about the stage when it needs to size its finalize wait. */
interface VodWaitInputs {
  /** What the running stage cuts at, or null where this run could not read the engine's config. */
  segmentSeconds: number | null;
  /** The interval the wait samples the log at, since it polls rather than watches. */
  pollMs: number;
}

/**
 * How long `make:recording` may wait for the uploader to turn a stopped broadcast into a recording.
 *
 * ## ⛔⛔ Why 180 s was not short by a little
 *
 * Live on 2026-09-02, right after an SRS restart: the driver exited 1 on its flat three minute wait
 * and the uploader finalized all four rungs four seconds later, about three minutes after the
 * publisher stopped. Nothing about 180 s came from the mechanism, so it was as likely to be short as
 * long, and the run it lost had already published for minutes and paid for every segment of it.
 *
 * ## The derivation, in the order the uploader spends it
 *
 * **The segment still in the engine.** SRS closes the fragment it is cutting when the source goes
 * away, so the last upload starts up to one segment length after the publisher stopped, and an
 * upload in flight keeps trying for {@link UPLOAD_RETRY_WINDOW_MS}. That is when the orphan reaper's
 * own window starts, because it measures from the last segment to arrive rather than from the stop.
 *
 * **The rung's stop, sized for the case that actually failed rather than the usual one.** A ladder
 * source's `on_unpublish` clears the authenticated base and stops NOTHING: each rung is one of SRS's
 * own loopback publishers and ends on its own `on_unpublish`, which `engines/srs.ts` answers with
 * `stopStreamQuietly`. When those do not arrive, the only thing that ends a rung is the stall
 * reaper, which fires {@link ORPHAN_REAP_MS} after the last segment and re-arms itself with the
 * remainder when one arrived since. So a full reap window is the worst case, and it is exactly the
 * case a driver's wait has to survive.
 *
 * **The drain.** `stopStream` runs `performDrain`, which races the uploader's finalize against
 * {@link DRAIN_TIMEOUT_MS}. The line this waits for is written inside that finalize, so giving up
 * earlier abandons a drain that is still running and could still write it. At the deadline either
 * the line is there or the drain has force-stopped and said so in the log.
 *
 * ⭐ `RECOVERY_TIMEOUT` is deliberately not in this. It arms only for a stream a restarted uploader
 * restored and is waiting for an engine to reconnect to, and nothing on this path restarts the
 * uploader. It is the same 60 s `ORPHAN_REAP_MS` was chosen against, which is why one term covers
 * the waiting-for-an-engine case either way.
 *
 * One poll interval on top, because the wait samples the log rather than watching it.
 */
export function vodFinalizeWaitMs({ segmentSeconds, pollMs }: VodWaitInputs): number {
  if (segmentSeconds !== null && (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0)) {
    throw new Error(`a segment length of ${segmentSeconds}s is not a length, so no wait can be sized from it`);
  }

  // ⭐ Null contributes nothing, and that is safe rather than approximate: this leg is bounded by the
  // uploader's own retry window, which is fifteen seconds against a budget of six minutes, and the
  // segment inside it is one of those seconds.
  const lastSegmentMs = Math.ceil((segmentSeconds ?? 0) * 1_000) + UPLOAD_RETRY_WINDOW_MS;

  return lastSegmentMs + ORPHAN_REAP_MS + DRAIN_TIMEOUT_MS + pollMs;
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
