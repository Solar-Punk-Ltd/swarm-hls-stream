import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'fs';
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
 * @throws if the file exists and is not writable, or does not exist and cannot be created.
 */
export function assertEnvKeyWritable(envPath: string): void {
  if (existsSync(envPath)) {
    try {
      accessSync(envPath, constants.W_OK);
    } catch {
      throw new Error(`${envPath} exists but is not writable`);
    }
    return;
  }

  const parent = dirname(envPath);
  if (!existsSync(parent)) {
    throw new Error(`${envPath} cannot be created: the directory ${parent} does not exist`);
  }
  try {
    accessSync(parent, constants.W_OK);
  } catch {
    throw new Error(`${envPath} cannot be created: the directory ${parent} is not writable`);
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

  writeFileSync(envPath, updated.join('\n'));
}
