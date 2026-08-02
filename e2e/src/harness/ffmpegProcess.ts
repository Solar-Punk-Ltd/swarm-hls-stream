/**
 * Running ffmpeg for as long as a test or a measurement needs it, and stopping it without waiting
 * forever.
 *
 * Shared by the fault-injection publisher and the bench's, which differ entirely in their arguments
 * and not at all in how the process is supervised. The argument lists stay apart on purpose: the two
 * are answering different questions, and folding them into one function with flags is how the bench's
 * `-copyts` would eventually end up on a scenario run.
 */

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';

/** How long a SIGINT gets to land before the process is killed outright. */
const STOP_GRACE_MS = 3_000;

/** How a process ended. Both fields are null when it never started, which is a spawn failure. */
export interface FfmpegExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface FfmpegProcess {
  /** Accumulated stderr. The first thing to read when no media appears: an SRT refusal lands here. */
  stderr(): string;
  /**
   * How the process ended, or null while it is still running.
   *
   * Exposed because a publish that died on its arguments and a publish still working are the same
   * object to a caller that cannot ask, and the caller is normally inside a wait measured in minutes.
   */
  exit(): FfmpegExit | null;
  /** Interrupt, then kill if it does not exit. Safe to call after the process has already gone. */
  stop(): Promise<void>;
}

export interface FfmpegOptions {
  stopGraceMs?: number;
  /** Replaceable so the lifecycle can be driven without launching a real encoder. */
  spawnFn?: typeof nodeSpawn;
}

export function startFfmpeg(args: readonly string[], options: FfmpegOptions = {}): FfmpegProcess {
  const { stopGraceMs = STOP_GRACE_MS, spawnFn = nodeSpawn } = options;

  let stderr = '';
  let ended: FfmpegExit | null = null;
  const proc: ChildProcess = spawnFn('ffmpeg', [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  // Without a listener here an `error` event is an unhandled emitter error, which Node throws from
  // its own internals and which ends the run rather than the publish. It is also the only channel a
  // spawn failure has: a missing or unexecutable ffmpeg writes no stderr, it emits ENOENT or EACCES.
  proc.on('error', (error: Error) => {
    stderr += `${error.message}\n`;
    ended = { code: null, signal: null };
  });
  proc.on('exit', (code, signal) => {
    ended = { code, signal };
  });

  return {
    stderr: () => stderr,
    exit: () => ended,
    async stop() {
      if (ended !== null) {
        return;
      }
      proc.kill('SIGINT');
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, stopGraceMs);
        proc.on('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    },
  };
}
