/**
 * Where a browser run's output goes, and how it reads its own settings.
 *
 * One module so a clean watch and a crash scenario write to the same place in the same shape. A
 * crash report is only worth having if its numbers sit beside a clean one's and mean the same thing.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ROOT_DIR } from '../config.js';

export const REPORT_DIR = join(ROOT_DIR, 'docs', 'bench');

/**
 * A run's identity: one string that names its report, its json, its request log and its screenshots.
 *
 * Stamped before the watch rather than after it. Taken at the end, the screenshots were being
 * written before the run they belong to had a name.
 */
export function runIdFrom(measuredAt: string): string {
  return measuredAt.replace(/[:.]/g, '-');
}

/**
 * Where a run's screenshots go, under a directory of its own.
 *
 * Flat filenames put every run's `sample-0001.png` at the same path, so a second run silently
 * replaced the images the first run's report still links to. That is the whole glass-to-glass
 * measurement gone, and gone in the way that is hardest to notice: the report reads correctly and
 * the file it names exists, showing a different broadcast. Two runs on 2026-08-05 lost the earlier
 * one's clocks that way.
 */
export function screenshotDirFor(runId: string): string {
  return join(REPORT_DIR, 'browser-screenshots', runId);
}

/**
 * How many successful requests a run's log keeps.
 *
 * An hour at a 0.25s segment makes roughly fifty thousand requests, which is a fifteen megabyte json
 * file per run committed to git. Everything that went wrong is kept in full, because a refusal or a
 * failure is why anyone opens this file at all, and the successes are thinned to a sample that still
 * carries the timing distribution. The aggregate the report prints is computed over **every**
 * request before any of this, so no figure changes.
 */
export const MAX_LOGGED_SUCCESSES = 5_000;

const succeeded = (status: number | null): boolean => status !== null && status < 400;

/**
 * Keep every failure and refusal, and an evenly spread sample of what worked.
 *
 * One pass, in order. Selecting the two groups separately and sorting them back together needs each
 * record's original position, and looking that up per record is quadratic: at the fifty thousand
 * requests an hour-long run makes, that is the thinning costing more than the run it is thinning.
 */
export function thinRequestLog<T extends { status: number | null }>(records: readonly T[]): T[] {
  const successes = records.reduce((total, r) => total + (succeeded(r.status) ? 1 : 0), 0);
  if (successes <= MAX_LOGGED_SUCCESSES) {
    return [...records];
  }

  const everyNth = Math.ceil(successes / MAX_LOGGED_SUCCESSES);
  let kept = 0;
  return records.filter((record) => (succeeded(record.status) ? kept++ % everyNth === 0 : true));
}

export interface RunArtifacts {
  /** The rendered report, which is the thing a person reads. */
  markdown: string;
  /** Everything the run collected, so a question nobody thought to ask can still be answered later. */
  run: unknown;
  /**
   * The request log, kept beside the report rather than inside it: a three-minute watch makes
   * thousands of requests, and the answer to "why did it stall" is usually a distribution over them
   * rather than one row.
   */
  requests: unknown;
}

/** @returns The path stem the artifacts were written to, for the line the run prints at the end. */
export async function writeRunArtifacts(prefix: string, runId: string, artifacts: RunArtifacts): Promise<string> {
  await mkdir(REPORT_DIR, { recursive: true });
  const stem = join(REPORT_DIR, `${prefix}-${runId}`);

  await writeFile(`${stem}.md`, artifacts.markdown, 'utf8');
  await writeFile(`${stem}.json`, JSON.stringify(artifacts.run, null, 2), 'utf8');
  await writeFile(`${stem}.requests.json`, JSON.stringify(artifacts.requests), 'utf8');

  return stem;
}

export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got '${raw}'`);
  }
  return value;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. browser-on-host.sh reads it out of the deployed profile.`);
  }
  return value;
}
