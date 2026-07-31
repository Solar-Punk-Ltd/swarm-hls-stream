import { accessSync, constants, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * Whether `writeEnvKey` can be expected to succeed for this path.
 *
 * Exists to be called *before* an irreversible action rather than as a substitute for handling a
 * failed write. `pnpm stamp:setup` buys a postage batch on chain, and the batch id is worth nothing
 * to the operator unless it is recorded, so the run establishes it can record one before it spends.
 * A race between this check and the write is still possible, which is why the caller also handles
 * the write throwing.
 *
 * Checks what `writeEnvKey` actually does, which is read the file, write a sibling, and rename over
 * the target. So an existing file must be readable as well as writable, must be a regular file, and
 * its directory must be writable even when the file itself is: the rename creates and removes an
 * entry in that directory. Checking only the file's write bit passed in four states where the write
 * then threw.
 *
 * @throws if the file exists and cannot be read or replaced, or does not exist and cannot be created.
 */
export function assertEnvKeyWritable(envPath: string): void {
  const parent = dirname(envPath);

  if (existsSync(envPath)) {
    if (!statSync(envPath).isFile()) {
      throw new Error(`${envPath} exists but is not a regular file`);
    }
    try {
      accessSync(envPath, constants.R_OK | constants.W_OK);
    } catch {
      throw new Error(`${envPath} exists but is not both readable and writable`);
    }
  } else if (!existsSync(parent)) {
    throw new Error(`${envPath} cannot be created: the directory ${parent} does not exist`);
  }

  if (!statSync(parent).isDirectory()) {
    throw new Error(`${envPath} cannot be created: ${parent} is not a directory`);
  }

  try {
    accessSync(parent, constants.W_OK);
  } catch {
    throw new Error(`${envPath} cannot be replaced: the directory ${parent} is not writable`);
  }
}

/**
 * Replace a file's contents, or leave the file exactly as it was.
 *
 * `writeFileSync` truncates before it writes, so a write that fails partway leaves the file
 * truncated. For `.env` that means the operator loses STREAM_KEY, API_AUTH_TOKEN and everything
 * else, from a disk that filled up while a single unrelated key was being updated. Writing a
 * sibling and renaming makes the replacement atomic: `rename` within a directory either happens or
 * does not. The sibling is removed on failure so a half-written temp file is not left behind.
 */
function writeFileAtomically(targetPath: string, content: string): void {
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, content);
    renameSync(tempPath, targetPath);
  } catch (err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // The original is intact either way, which is the property that matters.
    }
    throw err;
  }
}

/**
 * Update a key in a .env file. If the key exists, replaces its value. If not, appends it at the end.
 *
 * Creates the file when it is missing. A fresh clone has no `.env`, and this used to throw ENOENT at
 * the one moment it must not: after the postage batch had been paid for, leaving the batch id in
 * terminal scrollback and nowhere else. See OPS-1.
 */
export function writeEnvKey(envPath: string, key: string, value: string): void {
  const content = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const lines = content === '' ? [] : content.split('\n');
  const pattern = new RegExp(`^${key}=`);
  let found = false;

  const updated = lines.map((line) => {
    if (pattern.test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    updated.push(`${key}=${value}`);
  }

  writeFileAtomically(envPath, updated.join('\n'));
}
