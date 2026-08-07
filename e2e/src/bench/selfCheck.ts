/**
 * Prove the instrument before trusting it, locally, before a run touches the deployment.
 *
 * A latency figure is not self-evidently wrong the way a failed request is. If the publish recipe
 * stops carrying the wall clock, or ffprobe changes what it prints, or the arithmetic drifts, the
 * bench does not crash — it reports a number, and that number becomes a baseline a later sprint is
 * measured against. So the whole chain is exercised first against a local file: publish with the same
 * encode arguments the run will use, probe the result, and recover capture instants that have to come
 * back consistent.
 *
 * Costs about fifteen seconds and no postage, and it runs before the stack is touched. That ordering
 * is the point: an instrument fault should cost nothing but the wait.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { startFfmpeg } from '../harness/ffmpegProcess.js';
import { sleep } from '../harness/wait.js';

import { probeSegment } from './probe.js';
import { latencyMsFromPts } from './wallclock.js';
import { type PublishKnobs, wallclockEncodeArgs } from './wallclockPublisher.js';

const execFileAsync = promisify(execFile);

/** Long enough for several segments at a 2s target, short enough that a broken run costs little. */
const CHECK_PUBLISH_MS = 13_000;
/** Time for the muxer to close and flush the final segment after the interrupt. */
const CHECK_FLUSH_MS = 1_500;
const CHECK_SEGMENT_SECONDS = 2;
/** Small frames: this checks that timestamps survive, which is independent of how much is encoded. */
const CHECK_SIZE = '320x240';

/**
 * The widest gap between two consecutive segments' capture instants that still reads as a paced
 * publish, as a multiple of the segment duration.
 *
 * Generous, because this is a smoke test of the arithmetic and not a measurement. What it has to
 * catch is the case where capture instants come back unordered or bunched, which is what a recipe
 * that stopped anchoring on the wall clock looks like.
 */
const MAX_SPACING_FACTOR = 3;

/**
 * How far a segment's measured span may fall from where the next segment starts, in frames.
 *
 * Half a frame, which is the widest value that still separates a correct span from one that is a
 * whole frame out. The quantity being bounded came back exact on every pair measured, so anything
 * this leaves room for is float error in two tick-to-millisecond conversions.
 */
const SPAN_TOLERANCE_FRAMES = 0.5;

/**
 * Three, because the interrupt-cut final segment is discarded and two whole ones are what the checks
 * below need: `requirePacedAndOrdered` compares consecutive capture instants and
 * `requireSpansMeetEndToEnd` measures one span against the next segment's start.
 */
const MIN_SEGMENTS_PRODUCED = 3;

export interface SelfCheckResult {
  segmentsProbed: number;
  /** Gap between the process starting and its first frame being stamped. Around 1.5s on ffmpeg 7.1.1. */
  startupDelayMs: number;
  /** Capture instants of consecutive segments, relative to the first. */
  captureOffsetsMs: number[];
  /** Media each segment holds, measured from its own packets. Reported so a check can be read, not just passed. */
  mediaSpansMs: number[];
  /** How far the publisher's timestamps run ahead of wall clock. See `measureMediaTimelineLead`. */
  mediaTimelineLeadMs: number;
  /** Widest departure from that median across the check's segments, so the estimate can be read as tight or loose. */
  leadSpreadMs: number;
}

/**
 * One probed segment of the local check, holding only what the two checks below compare.
 *
 * Exported with `requireSpansMeetEndToEnd` so that check can be tested at all. Producing this array
 * needs ffmpeg; checking it is arithmetic over three numbers, which is the same split that took
 * `segmentSpan.ts` out of `probe.ts`.
 */
export interface ProbedCheckSegment {
  capturedAtMs: number;
  mediaSpanMs: number;
  frameDurationMs: number;
  /** Wall clock when the muxer last wrote the segment, so when the media it holds had really been captured. */
  closedAtMs: number;
}

function fail(why: string): never {
  throw new Error(
    `the latency instrument failed its own local check, so nothing it measured against a deployment ` +
      `would be trustworthy: ${why}`,
  );
}

/**
 * Publish, probe and recover locally. Throws if any link in the chain is broken.
 *
 * @param knobs the same knobs the run will publish with, so the check covers the run's own encode
 */
export async function checkInstrumentLocally(knobs: PublishKnobs): Promise<SelfCheckResult> {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-hls-bench-'));
  try {
    return await runCheck(knobs, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runCheck(knobs: PublishKnobs, dir: string): Promise<SelfCheckResult> {
  await requireFfmpegTools();

  const args = [
    ...wallclockEncodeArgs({ ...knobs, size: CHECK_SIZE }),
    '-f',
    'hls',
    '-hls_time',
    String(CHECK_SEGMENT_SECONDS),
    '-hls_flags',
    'independent_segments',
    '-hls_segment_filename',
    join(dir, 's%d.ts'),
    join(dir, 'check.m3u8'),
  ];

  const startedAtMs = Date.now();
  const proc = startFfmpeg(args);
  await sleep(CHECK_PUBLISH_MS);
  await proc.stop();
  await sleep(CHECK_FLUSH_MS);

  const produced = (await readdir(dir))
    .filter((name) => /^s\d+\.ts$/.test(name))
    .sort((a, b) => Number(a.slice(1, -3)) - Number(b.slice(1, -3)));

  if (produced.length < MIN_SEGMENTS_PRODUCED) {
    fail(
      `publishing produced ${produced.length} segment(s) in ${CHECK_PUBLISH_MS}ms. ` +
        `ffmpeg said: ${proc.stderr().trim().slice(0, 400) || '(nothing)'}`,
    );
  }

  // The last file was cut mid-segment by the interrupt, so it holds whatever had been written when
  // the muxer stopped. Nothing here wants it: `requireSpansMeetEndToEnd` already excludes it for
  // having nothing after it to meet. Probing it anyway is a way to fail on it, because a segment
  // interrupted inside one frame interval holds a single video packet and `measureSpanTicks` refuses
  // that, correctly, and the run would abort blaming an instrument that is fine.
  const segments = produced.slice(0, -1);

  const probed: ProbedCheckSegment[] = [];
  for (const segment of segments) {
    const closedAtMs = (await stat(join(dir, segment))).mtimeMs;
    const { firstFrame, mediaSpanS, frameDurationS } = await probeSegment(join(dir, segment), segment);
    const observedAtMs = Date.now();
    // Throws `UnusableTimestampsError` if the recipe stopped carrying the clock, which is the whole
    // point of running this: against a deployment that error is ambiguous between the recipe and the
    // media engine, and here there is no media engine to blame.
    // Zero, and not because the publisher keeps time. This is the measurement the lead comes OUT of,
    // so there is nothing yet to correct against, and `measureMediaTimelineLead` below reads it from
    // these very instants. Passing anything else would fold the answer into its own input.
    const latencyMs = latencyMsFromPts(firstFrame, {
      publishStartedAtMs: startedAtMs,
      observedAtMs,
      mediaTimelineLeadMs: 0,
    });
    probed.push({
      capturedAtMs: observedAtMs - latencyMs,
      mediaSpanMs: mediaSpanS * 1_000,
      frameDurationMs: frameDurationS * 1_000,
      closedAtMs,
    });
  }

  const capturedAtMs = probed.map((segment) => segment.capturedAtMs);
  requirePacedAndOrdered(capturedAtMs);
  requireSpansMeetEndToEnd(probed);
  const { leadMs, spreadMs } = measureMediaTimelineLead(probed);

  return {
    segmentsProbed: segments.length,
    startupDelayMs: capturedAtMs[0] - startedAtMs,
    captureOffsetsMs: capturedAtMs.map((at) => at - capturedAtMs[0]),
    mediaSpansMs: probed.map((segment) => segment.mediaSpanMs),
    mediaTimelineLeadMs: leadMs,
    leadSpreadMs: spreadMs,
  };
}

/**
 * The widest a lead estimate may vary across the check's segments before it is refused.
 *
 * Measured rather than chosen: across 44 consecutive segments of a 90-second local publish the
 * estimate held to within 2ms, and it held to the same 1393/1394ms at 640x360, at 1280x720, at 60fps
 * and at a 4-second GOP. So a spread wider than this is not the quantity being noisy, it is the
 * publish having done something else, and an estimate taken from it would shift every figure in the
 * report by however wrong it was.
 */
const MAX_LEAD_SPREAD_MS = 250;

/**
 * How far the publisher's timestamps run ahead of the wall clock they claim to be.
 *
 * `-use_wallclock_as_timestamps 1` anchors the first frame to the wall clock, and everything
 * downstream reads a segment's timestamps as when its picture was taken. Measured on 2026-08-03,
 * that is false by a constant: ffmpeg emits roughly 1.4 seconds of media faster than real time while
 * it starts up, the encoder's output timeline advances at the nominal rate regardless, and the two
 * never resync. From then on the timeline tracks wall clock exactly — media/wall came back 1.00000
 * over 86 seconds — while sitting permanently ahead of it.
 *
 * A frame stamped X was therefore captured at `X - lead`, which is what this returns, and every
 * capture instant in the run has to have it taken off. Left in, it makes `capture to fetchable`
 * report 1.4s less latency than the pipeline really has, and it drives the `upload` hop negative,
 * because that hop is bounded below by `capturedAtMs + span` and nothing else moves with it. Both
 * were visible in the runs of 2026-08-02 and 2026-08-03, where all ten `upload` readings were
 * negative and adding this quantity back makes every one of them positive.
 *
 * ## Why nothing else here could see it
 *
 * `requireSpansMeetEndToEnd` and `requirePacedAndOrdered` are both statements *inside* the media
 * timeline. Shift that timeline by any constant, or scale it, and consecutive spans still meet
 * exactly and capture instants stay ordered and paced. The only way to catch this is to compare
 * against an instant the timeline never touched, which is what `closedAtMs` is: the wall clock when
 * the muxer had actually written the media, on this machine, with no engine and no network in it.
 *
 * ## What it slightly understates
 *
 * The muxer writes a segment's last packet some small time after receiving it, and that delay sits
 * inside `closedAtMs`, so the figure here is the lead minus that delay plus one frame. The
 * independent control puts the same quantity at about 1492ms by comparing the newest timestamp on
 * disk against the instant the publisher was told to stop, which involves no muxer at all. The two
 * bracket the truth within ~100ms, and the report says which one it applied.
 */
export function measureMediaTimelineLead(probed: readonly ProbedCheckSegment[]): { leadMs: number; spreadMs: number } {
  const leads = probed.map((segment) => segment.capturedAtMs + segment.mediaSpanMs - segment.closedAtMs);
  const sorted = [...leads].sort((a, b) => a - b);
  const leadMs = sorted[Math.floor((sorted.length - 1) / 2)];
  const spreadMs = Math.max(...leads.map((lead) => Math.abs(lead - leadMs)));

  if (spreadMs > MAX_LEAD_SPREAD_MS) {
    fail(
      `the publisher's timestamps run between ${Math.round(sorted[0])}ms and ` +
        `${Math.round(sorted[sorted.length - 1])}ms ahead of wall clock across ${leads.length} segment(s), a ` +
        `spread of ${Math.round(spreadMs)}ms. This quantity is taken off every capture instant the run ` +
        'measures, so an estimate this loose would move every latency in the report by however wrong it is',
    );
  }

  return { leadMs, spreadMs };
}

/**
 * That each segment's measured span reaches exactly as far as the next segment's first frame.
 *
 * The check the span arithmetic needed and could not get from a constant. Segments are contiguous, so
 * one segment's media ends where the next one's begins, and that next start is a timestamp the span
 * itself never touched. Asserting the span against `CHECK_SEGMENT_SECONDS` instead would compare the
 * instrument against the number it was configured with, and pass however the arithmetic was wrong.
 *
 * Measured across three local encodes on 2026-08-03, constant-frame-rate and B-frame alike: the two
 * agree to zero ticks on every consecutive pair. So the tolerance is float noise and nothing else,
 * and it is expressed in frames rather than milliseconds because the error this is here to catch is
 * exactly one frame wide. A fixed millisecond bound would have to be re-argued at every frame rate.
 *
 * ## What it cannot see against this recipe
 *
 * Two errors are one frame wide and only one of them is visible here. Dropping the final frame's
 * credit shortens every span by a frame and is caught. Reading the ends of the packet list rather
 * than the widest timestamp is caught only on a stream whose packets are reordered, and
 * `wallclockEncodeArgs` passes `-tune zerolatency`, which disables B-frames: measured against that
 * exact recipe, decode order came back strictly ascending over all 60 packets. So this check runs
 * green either way on the bench's own publish, and only `segmentSpan.test.ts` holds that half.
 *
 * The final segment is excluded, because it was cut by the interrupt and nothing follows it to meet.
 */
export function requireSpansMeetEndToEnd(probed: readonly ProbedCheckSegment[]): void {
  for (let i = 1; i < probed.length; i++) {
    const previous = probed[i - 1];
    const toNextStartMs = probed[i].capturedAtMs - previous.capturedAtMs;
    const shortfallMs = toNextStartMs - previous.mediaSpanMs;
    if (Math.abs(shortfallMs) > previous.frameDurationMs * SPAN_TOLERANCE_FRAMES) {
      fail(
        `segment ${i - 1} measures ${Math.round(previous.mediaSpanMs)}ms of media, but segment ${i} starts ` +
          `${Math.round(toNextStartMs)}ms after it began, leaving ${Math.round(shortfallMs)}ms unaccounted ` +
          `for against a frame of ${Math.round(previous.frameDurationMs)}ms. Consecutive segments leave no ` +
          'gap and overlap by nothing, so this is the span being measured wrongly rather than an uneven publish',
      );
    }
  }
}

function requirePacedAndOrdered(capturedAtMs: readonly number[]): void {
  const maxSpacingMs = CHECK_SEGMENT_SECONDS * MAX_SPACING_FACTOR * 1_000;
  for (let i = 1; i < capturedAtMs.length; i++) {
    const spacingMs = capturedAtMs[i] - capturedAtMs[i - 1];
    if (spacingMs <= 0) {
      fail(`segment ${i} reports a capture instant at or before segment ${i - 1}, so the timestamps are not a clock`);
    }
    if (spacingMs > maxSpacingMs) {
      fail(
        `segments ${i - 1} and ${i} report capture instants ${Math.round(spacingMs)}ms apart for ` +
          `${CHECK_SEGMENT_SECONDS}s of media, so the publish is not paced in real time`,
      );
    }
  }
}

/**
 * Both tools, before anything else. A missing ffprobe otherwise surfaces after the publish, as a
 * spawn error attached to the first segment.
 */
async function requireFfmpegTools(): Promise<void> {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    try {
      await execFileAsync(tool, ['-version']);
    } catch {
      fail(`${tool} is not on PATH`);
    }
  }
}
