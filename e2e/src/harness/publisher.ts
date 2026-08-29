import type { E2EConfig } from '../config.js';

import { srtIngestUrl } from './engine.js';
import { type FfmpegProcess, startFfmpeg } from './ffmpegProcess.js';

const DEFAULT_FPS = 30;

/**
 * Seconds between the keyframes this publisher emits.
 *
 * Named because it is read outside the ffmpeg line: against a single-rendition stage SRS has no
 * cadence of its own, so this is the number that decides the segment length and
 * `suites/preflight/segment-length.test.ts` has to know it. With the ABR ladder on the stage
 * transcodes and this is not in the path at all.
 */
export const PUBLISHER_GOP_SECONDS = 2;

export interface Publisher extends FfmpegProcess {
  readonly url: string;
}

/** Start an ffmpeg test-pattern (video+audio) publish over SRT to the configured engine's ingest. */
export function startPublisher(cfg: E2EConfig, opts: { fps?: number; streamPath?: string } = {}): Publisher {
  const fps = opts.fps ?? DEFAULT_FPS;
  const url = srtIngestUrl(cfg, opts.streamPath ?? cfg.streamPath);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-re',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1280x720:rate=${fps}`,
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
    '-g',
    String(fps * PUBLISHER_GOP_SECONDS),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-b:a',
    '128k',
    '-f',
    'mpegts',
    url,
  ];

  return { url, ...startFfmpeg(args) };
}
