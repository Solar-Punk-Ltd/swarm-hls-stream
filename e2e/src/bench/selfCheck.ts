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
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { startFfmpeg } from '../harness/ffmpegProcess.js';
import { sleep } from '../harness/wait.js';

import { probeFirstVideoFrame } from './probe.js';
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

export interface SelfCheckResult {
  segmentsProbed: number;
  /** Gap between the process starting and its first frame being stamped. Around 1.5s on ffmpeg 7.1.1. */
  startupDelayMs: number;
  /** Capture instants of consecutive segments, relative to the first. */
  captureOffsetsMs: number[];
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

  const segments = (await readdir(dir))
    .filter((name) => /^s\d+\.ts$/.test(name))
    .sort((a, b) => Number(a.slice(1, -3)) - Number(b.slice(1, -3)));

  if (segments.length < 2) {
    fail(
      `publishing produced ${segments.length} segment(s) in ${CHECK_PUBLISH_MS}ms. ` +
        `ffmpeg said: ${proc.stderr().trim().slice(0, 400) || '(nothing)'}`,
    );
  }

  const capturedAtMs: number[] = [];
  for (const segment of segments) {
    const frame = await probeFirstVideoFrame(join(dir, segment), segment);
    const observedAtMs = Date.now();
    // Throws `UnusableTimestampsError` if the recipe stopped carrying the clock, which is the whole
    // point of running this: against a deployment that error is ambiguous between the recipe and the
    // media engine, and here there is no media engine to blame.
    capturedAtMs.push(observedAtMs - latencyMsFromPts(frame, { publishStartedAtMs: startedAtMs, observedAtMs }));
  }

  requirePacedAndOrdered(capturedAtMs);

  return {
    segmentsProbed: segments.length,
    startupDelayMs: capturedAtMs[0] - startedAtMs,
    captureOffsetsMs: capturedAtMs.map((at) => at - capturedAtMs[0]),
  };
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
