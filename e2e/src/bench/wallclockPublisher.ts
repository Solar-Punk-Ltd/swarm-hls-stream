/**
 * The publish side of the glass-to-glass measurement: an ffmpeg test pattern whose frames carry the
 * bench machine's wall clock, so a segment retrieved at the far end can say when its picture was
 * taken.
 *
 * `-use_wallclock_as_timestamps 1` stamps each input packet as it is demuxed, and `-copyts` stops
 * ffmpeg rebasing the output timeline to zero. Both are needed: without `-copyts` the stamps are
 * subtracted away and every segment starts near 0, which is indistinguishable from a stream that
 * never carried a clock at all.
 *
 * Separate from `harness/publisher.ts` rather than a flag on it. That one feeds the fault scenarios
 * and its arguments are a fixed, known-good ingest; this one exists to be varied, and the two must
 * not be able to drift into each other. They share the process supervision and nothing else.
 *
 * ## What the timeline is, exactly
 *
 * The wall clock anchors the **first** frame. After that the encoder emits at the nominal frame rate,
 * measured: three consecutive two-second segments came back exactly 180000 ticks apart at 90kHz, not
 * at whatever the wall clock had done in between. Under `-re` the two coincide, because `-re` paces
 * the input at that same nominal rate, so media time and wall time advance together and the anchor
 * stays true. What that costs is a slow accumulation of pacing drift over a long publish, which is
 * why a run is minutes rather than hours, and why `bench/latency.ts` reports the drift it measured
 * instead of assuming it away.
 */

import type { E2EConfig } from '../config.js';
import { srtIngestUrl } from '../harness/engine.js';
import { type FfmpegProcess,startFfmpeg } from '../harness/ffmpegProcess.js';

/**
 * The knobs a run varies, and the reason each one is a latency lever.
 *
 * Held together as one object so a report can name the configuration it measured. A number changed
 * here without the report saying so is a measurement attributed to the wrong setup.
 */
export interface PublishKnobs {
  fps: number;
  /**
   * Seconds between keyframes.
   *
   * The largest publisher-side lever there is. An engine can only cut a segment at a keyframe, so a
   * GOP longer than the segment duration silently lengthens every segment, and a viewer's first frame
   * waits for a whole one. Asking for two-second segments from a four-second GOP gets four-second
   * segments and roughly two extra seconds of latency, with nothing in the pipeline reporting it.
   */
  gopSeconds: number;
  videoBitrateKbps: number;
  /** Frame size as ffmpeg spells it, e.g. `1280x720`. More pixels is more to encode and to upload. */
  size: string;
}

export const DEFAULT_KNOBS: PublishKnobs = {
  fps: 30,
  gopSeconds: 2,
  videoBitrateKbps: 2_500,
  size: '1280x720',
};

export interface WallclockPublisher extends FfmpegProcess {
  readonly url: string;
  /**
   * Bench-clock instant the process was spawned.
   *
   * The lower bound every measured capture instant is checked against, so it is taken here rather
   * than by the caller: a value read a moment later would sit after the first frame's own stamp and
   * reject the very first segment of every run.
   */
  readonly startedAtMs: number;
  readonly knobs: PublishKnobs;
}

/** Frames per group of pictures, which is what `-g` takes. */
function gopFrames(knobs: PublishKnobs): number {
  return Math.round(knobs.fps * knobs.gopSeconds);
}

/**
 * Everything up to the output: the two stamped inputs and the encode, with no destination.
 *
 * Split here so the local self-check can run this exact encode into an HLS folder instead of an SRT
 * ingest. If the check built its own argument list, it would prove a recipe the bench does not use,
 * which is the failure it exists to prevent.
 *
 * `-use_wallclock_as_timestamps` is an input option and appears before each `-i`. It is applied to
 * both inputs: stamping only the video leaves the audio starting at zero, and a muxer handed two
 * timelines an epoch apart cannot interleave them. Measured, not reasoned — stamping the video alone
 * produced one segment in eight seconds where stamping both produced five.
 */
export function wallclockEncodeArgs(knobs: PublishKnobs): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-re',
    '-use_wallclock_as_timestamps',
    '1',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${knobs.size}:rate=${knobs.fps}`,
    '-use_wallclock_as_timestamps',
    '1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    '-b:v',
    `${knobs.videoBitrateKbps}k`,
    '-g',
    String(gopFrames(knobs)),
    // Without this, x264 inserts keyframes on scene changes too, so the interval the GOP knob names
    // is an upper bound rather than the cadence, and segment boundaries wander with the content.
    '-sc_threshold',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-b:a',
    '128k',
    '-copyts',
  ];
}

/** The encode above, published as MPEG-TS over SRT to a media engine's ingest. */
export function wallclockPublishArgs(url: string, knobs: PublishKnobs): string[] {
  return [...wallclockEncodeArgs(knobs), '-f', 'mpegts', url];
}

export function startWallclockPublisher(
  cfg: E2EConfig,
  knobs: PublishKnobs = DEFAULT_KNOBS,
  streamPath: string = cfg.streamPath,
): WallclockPublisher {
  const url = srtIngestUrl(cfg, streamPath);
  const startedAtMs = Date.now();
  return { url, startedAtMs, knobs, ...startFfmpeg(wallclockPublishArgs(url, knobs)) };
}
