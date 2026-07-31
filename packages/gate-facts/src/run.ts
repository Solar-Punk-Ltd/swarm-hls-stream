import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Test reporters and audit reports both run to a few hundred kB, so this is headroom rather than a limit. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** A whole workspace test run is the slowest thing collected here and takes about a minute. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** Null when the process was killed by a signal or never started, which is not the same as a non-zero exit. */
  exitCode: number | null;
}

/**
 * Run a command and return its output whatever its exit code.
 *
 * Nothing here treats a non-zero exit as an error, because for several of these commands a non-zero
 * exit IS the measurement: `pnpm audit` exits non-zero whenever it finds anything at all, and the
 * exit code of `pnpm verify` is the fact being collected. Throwing on it would discard the answer.
 *
 * The exit code is read from the child rather than from a shell, because a pipe reports the last
 * command's status and not the one that matters. That mistake is on this project's record.
 */
export async function run(command: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: MAX_OUTPUT_BYTES, timeout: timeoutMs });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown };
    return {
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
      exitCode: typeof failure.code === 'number' ? failure.code : null,
    };
  }
}

/** How a command reads in the artifact, so a reviewer can paste it rather than reconstruct it. */
export function describe(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}
