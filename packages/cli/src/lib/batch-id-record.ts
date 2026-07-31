import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';

import { writeEnvKey } from './env-writer.js';

export const STAMP_ENV_KEY = 'STAMP';

export interface BatchIdRecord {
  /** Every location the id was successfully written to, best first. Empty means it is only on screen. */
  writtenTo: string[];
  /** Why the `.env` write failed, when it did. Callers surface this rather than swallowing it. */
  envError?: string;
}

function recoveryFileName(batchIdHex: string): string {
  return `stamp-batch-${batchIdHex.slice(0, 16)}.txt`;
}

/**
 * Record a paid-for batch id everywhere it can be recorded, and report where that was.
 *
 * The batch id is the only durable product of an on-chain spend. Once `buyStamp` returns, losing it
 * means the operator has paid for a batch they cannot address, so this never throws: it degrades
 * from `.env` to a recovery file next to `.env`, then to one in the temp directory, and reports an
 * empty `writtenTo` rather than failing if none of those work. The caller is responsible for
 * printing the id whatever happens, which is the one channel that cannot fail. See OPS-1.
 */
export function recordBatchId(envPath: string, batchIdHex: string): BatchIdRecord {
  const writtenTo: string[] = [];
  let envError: string | undefined;

  try {
    writeEnvKey(envPath, STAMP_ENV_KEY, batchIdHex);
    writtenTo.push(envPath);
  } catch (err) {
    envError = err instanceof Error ? err.message : 'unknown error';
  }

  if (writtenTo.length > 0) {
    return { writtenTo };
  }

  const fallbacks = [join(dirname(envPath), recoveryFileName(batchIdHex)), join(tmpdir(), recoveryFileName(batchIdHex))];

  for (const fallback of fallbacks) {
    try {
      writeFileSync(fallback, `${STAMP_ENV_KEY}=${batchIdHex}\n`);
      writtenTo.push(fallback);
      break;
    } catch {
      // Try the next location. Reporting an empty writtenTo is the honest outcome if none work.
    }
  }

  return { writtenTo, envError };
}

/**
 * The lines an operator needs to recover a batch id that did not reach `.env`.
 *
 * Separate from the recording so it can be asserted directly, and so the caller cannot record
 * without having something to print.
 */
export function batchIdRecoveryNotice(envPath: string, batchIdHex: string, record: BatchIdRecord): string[] {
  if (record.writtenTo[0] === envPath) {
    return [];
  }

  const lines = [
    `The postage batch was PAID FOR but could not be written to ${basename(envPath)}.`,
    record.envError ? `Reason: ${record.envError}` : 'Reason: unknown',
    '',
    `  ${STAMP_ENV_KEY}=${batchIdHex}`,
    '',
  ];

  if (record.writtenTo.length > 0) {
    lines.push(`Saved a copy at: ${record.writtenTo[0]}`);
  } else {
    lines.push('It could not be saved anywhere on disk. Copy the line above now, it is not recoverable from here.');
  }
  lines.push(`Add it to ${envPath} before deploying.`);

  return lines;
}
