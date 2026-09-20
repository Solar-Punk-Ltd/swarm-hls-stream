import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LOCK_FILE = '.stream-uploader.lock';
const LOCK_BUSY_EXIT = 73;
const FLOCK_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTIC_BYTES = 4_096;

export interface ManagedStateLockFileOps {
  mkdirSync(target: string, options: { recursive: true }): unknown;
  openSync(target: string, flags: string, mode: number): number;
  closeSync(fd: number): void;
}

export interface ManagedStateLockAttempt {
  readonly status: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly error?: Error;
  readonly stderr?: string;
}

export type ManagedStateLockRunner = (fd: number) => ManagedStateLockAttempt;

const nodeFileOps: ManagedStateLockFileOps = {
  mkdirSync: (target, options) => fs.mkdirSync(target, options),
  openSync: (target, flags, mode) => fs.openSync(target, flags, mode),
  closeSync: (fd) => fs.closeSync(fd),
};

const runFlock: ManagedStateLockRunner = (fd) => {
  const result = spawnSync('flock', ['-n', '-E', String(LOCK_BUSY_EXIT), '3'], {
    stdio: ['ignore', 'ignore', 'pipe', fd],
    encoding: 'utf8',
    timeout: FLOCK_TIMEOUT_MS,
    maxBuffer: MAX_DIAGNOSTIC_BYTES,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stderr: result.stderr,
  };
};

/** Process-lifetime advisory lock for the persistent directory owned by managed SRS lifecycle state. */
export class ManagedStateLock {
  private released = false;

  private constructor(
    private readonly fd: number,
    private readonly fileOps: ManagedStateLockFileOps,
  ) {}

  public static acquire(
    stateDir: string,
    runner: ManagedStateLockRunner = runFlock,
    fileOps: ManagedStateLockFileOps = nodeFileOps,
  ): ManagedStateLock {
    fileOps.mkdirSync(stateDir, { recursive: true });
    const fd = fileOps.openSync(path.join(stateDir, LOCK_FILE), 'a', 0o600);
    try {
      const result = runner(fd);
      if (result.status === LOCK_BUSY_EXIT) {
        throw new Error(`Managed state directory ${stateDir} already has a writer`);
      }
      if (result.error || result.status !== 0) {
        const detail = result.error?.message ?? result.stderr?.trim() ?? result.signal ?? `exit ${result.status}`;
        throw new Error(`Could not lock managed state directory ${stateDir}: ${detail}`);
      }
      return new ManagedStateLock(fd, fileOps);
    } catch (error) {
      fileOps.closeSync(fd);
      throw error;
    }
  }

  public release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.fileOps.closeSync(this.fd);
  }
}
