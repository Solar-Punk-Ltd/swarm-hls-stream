import { type ChildProcess, spawn } from 'node:child_process';

import type { E2EConfig } from '../config.js';

import { srtIngestUrl } from './engine.js';

const DEFAULT_FPS = 30;
const STOP_GRACE_MS = 3_000;

export interface Publisher {
  readonly url: string;
  /** Accumulated ffmpeg stderr — inspect this if no segments appear (e.g. SRT handshake refused). */
  stderr(): string;
  stop(): Promise<void>;
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
    String(fps * 2),
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

  let stderr = '';
  let exited = false;
  const proc: ChildProcess = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  proc.on('exit', () => {
    exited = true;
  });

  return {
    url,
    stderr: () => stderr,
    async stop() {
      if (exited) {
        return;
      }
      proc.kill('SIGINT');
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, STOP_GRACE_MS);
        proc.on('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    },
  };
}
